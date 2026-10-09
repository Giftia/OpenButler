"""Exact post-mask OCR can be useful before optional model organization.

This path does not promote failed model output. It checks the owned capture's
original OCR binding and exposes bounded, verbatim lines with an explicit OCR
label. Capture/privacy failures never become usable evidence by this fallback.
"""
import json
import re
from dataclasses import dataclass
from hashlib import sha256
from uuid import UUID
from app.modules.context_engine.capture import MAX_POST_MASK_OCR_CHARS, MAX_POST_MASK_OCR_BYTES

OCR_ORGANIZATION_FAILURES = frozenset({
    'model_unavailable', 'route_not_ready', 'provider_connection_failed',
    'provider_http_error', 'invalid_model_result', 'invalid_source_grounding',
    # Optional model comparison validation says nothing about the independently
    # bound OCR evidence. Never admit capture/privacy/authorization failures here.
    'invalid_temporal_comparison',
})
_MARKER = re.compile(r'^(?:TODO\s*\(\s*me\s*\)\s*[:：]|我的待办\s*[:：]|TODO\s*[:：]|待办\s*[:：]|可能需要\s*[:：]|-\s*\[\s*\])', re.I)
OCR_BOUNDARY = ('以下仅为授权公开窗口遮挡后由本机 OCR 识别的原文片段，尚未完成模型整理；'
                'OCR 可能误识别，文字不证明真实操作、作者身份、连续工作或任务完成。')


class TaskContextIncomplete(ValueError):
    """A complete, independently verified task-model input cannot be supplied."""


@dataclass(frozen=True)
class TaskModelSource:
    """One complete OCR record, not a claim of complete work context."""
    observation_id: str
    evidence_id: str
    image_digest: str
    source_text_digest: str
    text: str
    start: int
    end: int

    def payload(self):
        try:
            valid = (all(type(value) is str and str(UUID(value)) == value
                         for value in (self.observation_id, self.evidence_id))
                and type(self.image_digest) is str and re.fullmatch(r'[0-9a-f]{64}', self.image_digest)
                and type(self.text) is str and self.text.strip()
                and len(self.text) <= MAX_POST_MASK_OCR_CHARS
                and len(self.text.encode('utf-8')) <= MAX_POST_MASK_OCR_BYTES
                and not any((ord(c) < 32 and c not in '\n\r\t') or ord(c) == 127 for c in self.text)
                and self.source_text_digest == sha256(self.text.encode('utf-8')).hexdigest()
                and type(self.start) is int and self.start == 0
                and type(self.end) is int and self.end == len(self.text))
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise TaskContextIncomplete('task_context_incomplete')
        return {'version': 1, 'source_kind': 'post_mask_ocr_text',
            'observation_id': self.observation_id, 'evidence_id': self.evidence_id,
            'image_digest': self.image_digest, 'source_text_digest': self.source_text_digest,
            'offset_unit': 'unicode_codepoints', 'complete_record': True,
            'semantic_verified': False,
            'span': {'quote': self.text, 'start': self.start, 'end': self.end}}


def complete_task_model_source(source):
    # Call only after the owning service's consent, scope, expiry and media checks.
    # Organization-selected snippets and model prose are never source authority.
    try:
        if not verified_post_mask_ocr(source):
            raise TaskContextIncomplete('task_context_incomplete')
        text = source['post_mask_ocr_text']
        result = TaskModelSource(source['id'], source['evidence_id'], source['image_digest'],
                                 sha256(text.encode('utf-8')).hexdigest(), text, 0, len(text))
        result.payload()
        return result
    except (KeyError, ValueError, TypeError, AttributeError):
        raise TaskContextIncomplete('task_context_incomplete') from None


def verified_post_mask_ocr(source):
    # Evidence identity is independent of optional organization progress.
    try:
        provenance = json.loads(source.get('provenance') or '{}')
    except (TypeError, ValueError):
        return False
    text = source.get('post_mask_ocr_text')
    digest = source.get('image_digest')
    return bool(source.get('source_kind') == 'public_window' and isinstance(provenance, dict)
        and provenance.get('source_kind') == 'public_window'
        and provenance.get('capture_scope') == 'dedicated_public_window'
        and provenance.get('observation_mode') == 'masked_ocr_text'
        and provenance.get('source_verified_before') is True
        and provenance.get('source_verified_after') is True
        and source.get('post_mask_ocr_engine') == 'tesseract.js'
        and isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest)
        and source.get('post_mask_ocr_image_digest') == digest
        and isinstance(text, str) and text.strip() and len(text) <= MAX_POST_MASK_OCR_CHARS
        and len(text.encode('utf-8')) <= MAX_POST_MASK_OCR_BYTES
        and not any((ord(c) < 32 and c not in '\n\r\t') or ord(c) == 127 for c in text))


def usable_unorganized_ocr(source):
    return (source.get('state') == 'model_unavailable'
            and source.get('processing_reason') in OCR_ORGANIZATION_FAILURES
            and verified_post_mask_ocr(source))


def retained_ocr(source):
    """Display an already-indexed, still-authorized OCR source during retry.

    This grants no new discovery eligibility. A capture stop/model cancellation
    can interrupt optional organization without deleting earlier valid OCR.
    Actual consent/evidence validity remains checked by the owning service.
    """
    interrupted = {'capture_paused', 'process_restarted', 'session_expired', 'authorization_revoked'}
    return (verified_post_mask_ocr(source)
        and (source.get('state') in {'recorded_pending', 'processing'}
             or source.get('state') == 'model_unavailable'
                and source.get('processing_reason') in OCR_ORGANIZATION_FAILURES | interrupted))


def unorganized_ocr_excerpts(source, *, existing=False):
    if not (usable_unorganized_ocr(source) or existing and retained_ocr(source)):
        return ()
    # Prefer explicit task markers over window chrome. Only whole bounded lines
    # are selected; truncating an action could remove negation or its assignee.
    text = source['post_mask_ocr_text']
    lines = list(dict.fromkeys(line.strip() for line in text.splitlines()
                              if 0 < len(line.strip()) <= 120))
    lines.sort(key=lambda line: not bool(_MARKER.match(line)))
    selected, size = [], 0
    for line in lines:
        if len(selected) < 3 and size + len(line) <= 200:
            selected.append(line)
            size += len(line)
    return tuple(selected)
