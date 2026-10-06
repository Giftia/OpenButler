"""Immutable current-frame OCR candidates. IDs establish membership, not meaning."""
from dataclasses import dataclass
from hashlib import sha256
import json

_BINDING_KEYS = ('id', 'evidence_id', 'image_digest', 'consent_revision',
                 'post_mask_ocr_text', 'post_mask_ocr_image_digest', 'provenance', 'expires_at')


def source_binding(snapshot):
    return sha256(json.dumps({key: snapshot[key] for key in _BINDING_KEYS},
        ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


@dataclass(frozen=True)
class SourceCandidate:
    source_id: str
    quote: str
    start: int
    end: int
    byte_start: int
    byte_end: int


@dataclass(frozen=True)
class CandidateSet:
    binding: str
    text: str
    candidates: tuple[SourceCandidate, ...]

    def prompt_data(self):
        return {'source_candidates': [[item.source_id, item.quote]
                                     for item in self.candidates]}

    def resolve(self, selected, snapshot):
        if source_binding(snapshot) != self.binding:
            raise ValueError('evidence_changed')
        if (type(selected) is not list or not 1 <= len(selected) <= 3
                or any(type(item) is not str for item in selected)
                or len(set(selected)) != len(selected)):
            raise ValueError('invalid_source_grounding')
        known = {item.source_id: item for item in self.candidates}
        if any(item not in known for item in selected):
            raise ValueError('invalid_source_grounding')
        items = [known[item] for item in selected]
        # Distinct occurrences have distinct IDs/offsets. Selecting both identical
        # texts is rejected to retain the existing v1 unique-quote contract.
        if (len({item.quote for item in items}) != len(items)
                or sum(len(item.quote) for item in items) > 200
                or any(self.text[item.start:item.end] != item.quote for item in items)):
            raise ValueError('invalid_source_grounding')
        return [{'quote': item.quote, 'start': item.start, 'end': item.end} for item in items]


def build_candidates(snapshot):
    text = snapshot['post_mask_ocr_text']
    if snapshot['image_digest'] != snapshot['post_mask_ocr_image_digest']:
        raise ValueError('post_mask_ocr_evidence_mismatch')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('invalid_post_mask_ocr')
    binding = source_binding(snapshot)
    items, offset = [], 0
    for line in text.splitlines(keepends=True):
        content = line.rstrip('\r\n')
        if content.strip():
            for relative in range(0, len(content), 120):
                start = offset + relative
                end = min(offset + len(content), start + 120)
                quote = text[start:end]
                if quote.strip():
                    items.append(SourceCandidate(f'E{len(items)+1:02d}_{binding[:16]}',
                        quote, start, end, len(text[:start].encode('utf-8')),
                        len(text[:end].encode('utf-8'))))
                if len(items) > 12:
                    raise ValueError('prompt_limit_exceeded')
        offset += len(line)
    if not items:
        raise ValueError('invalid_post_mask_ocr')
    return CandidateSet(binding, text, tuple(items))
