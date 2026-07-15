from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

from .schemas import MineContextActivity, MineContextGodviewResult, MineContextSearchResult

GENERIC_WEB_TERMS = {"网站", "网页", "浏览器", "chrome", "edge", "safari", "http", "https", "页面"}
SENSITIVE_PATTERNS = [
    (re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(api[_-]?key\s*[:=]\s*)[A-Za-z0-9._\-]{8,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(token\s*[:=]\s*)[A-Za-z0-9._\-]{8,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(cookie\s*[:=]\s*)[^;\n]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(password|密码)\s*[:=：]\s*\S+"), r"\1=[REDACTED]"),
    (re.compile(r"\b1[3-9]\d{9}\b"), "[REDACTED_PHONE]"),
    (re.compile(r"\b\d{16,19}\b"), "[REDACTED_CARD]"),
    (re.compile(r"\b\d{17}[\dXx]\b"), "[REDACTED_ID]"),
    (re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"), "[REDACTED_EMAIL]"),
    (re.compile(r"\b\d{6}\b"), "[REDACTED_CODE]"),
]


def redact_sensitive_text(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: redact_sensitive_text(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_sensitive_text(item) for item in value]
    if not isinstance(value, str):
        return value
    text = value
    for pattern, replacement in SENSITIVE_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text[:26], fmt)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def trim(value: Any, limit: int = 520) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def screenshot_paths_from_resources(resources: Any) -> list[str]:
    paths: list[str] = []
    if isinstance(resources, str):
        try:
            resources = json.loads(resources)
        except json.JSONDecodeError:
            resources = []
    for resource in resources if isinstance(resources, list) else []:
        if isinstance(resource, dict) and resource.get("type") == "image" and resource.get("path"):
            paths.append(str(resource["path"]))
    return paths


def screenshot_paths_from_refs(refs: Any) -> list[str]:
    paths: list[str] = []
    for ref in refs if isinstance(refs, list) else []:
        if isinstance(ref, dict) and ref.get("path"):
            paths.append(str(ref["path"]))
    return paths


def classify_activity_type(text: str) -> str:
    lower = text.lower()
    if any(term in lower for term in ["vscode", "vs code", "code.exe", "git", "python", "typescript", "代码", "编码"]):
        return "coding"
    if any(term in lower for term in ["chrome", "edge", "浏览器", "http", "网站", "网页"]):
        return "browser"
    if any(term in lower for term in ["word", "excel", "pdf", "文档", "markdown"]):
        return "document"
    if any(term in lower for term in ["chatgpt", "codex", "聊天", "会议"]):
        return "chat"
    if any(term in lower for term in ["xshell", "powershell", "terminal", "终端", "ssh"]):
        return "terminal"
    if any(term in lower for term in ["小红书", "rednote", "xiaohongshu", "视频", "娱乐"]):
        return "entertainment"
    return "unknown"


def infer_app_name(text: str) -> str | None:
    lower = text.lower()
    for name in ["VS Code", "Chrome", "Edge", "Xshell", "PowerShell", "ChatGPT", "Codex", "云效", "MineContext"]:
        if name.lower() in lower or name in text:
            return name
    return None


def infer_domain(text: str) -> str | None:
    match = re.search(r"https?://[^\s)\"'，。；]+", text)
    if match:
        return urlparse(match.group(0)).netloc or None
    for domain in ["github.com", "devops.aliyun.com", "xiaohongshu.com", "chatgpt.com", "127.0.0.1"]:
        if domain in text.lower():
            return domain
    return None


def query_result_from_json(data: dict[str, Any], include_raw_output: bool) -> MineContextGodviewResult:
    direct = data.get("direct_activities") or []
    nearby = data.get("nearby_activities") or []
    contexts = data.get("nearby_contexts") or []
    nearest = data.get("nearest_activities_same_day") or []
    target = data.get("target_time")
    window = int(data.get("window_minutes") or 10)
    source_items = direct or nearby or contexts or nearest[:1]
    first = source_items[0] if source_items else {}
    can_confirm = bool(direct or nearby)
    confidence = 0.86 if direct else 0.74 if nearby else 0.58 if contexts else 0.35 if nearest else 0.0
    evidence_level = "activity_record" if (direct or nearby) else "context_summary" if contexts else "generated_report"
    activity_ids = [str(item.get("id") or item.get("source_id")) for item in [*direct, *nearby] if item.get("id") or item.get("source_id")]
    context_ids = [str(item.get("embedding_id") or item.get("source_id") or item.get("id")) for item in contexts if item.get("embedding_id") or item.get("source_id") or item.get("id")]
    paths: list[str] = []
    for item in source_items:
        paths.extend(screenshot_paths_from_resources(item.get("resources")))
        paths.extend(screenshot_paths_from_refs(item.get("evidence_refs")))
    summary = trim(first.get("content") or first.get("summary") or first.get("title") or "MineContext 没有返回可确认的活动记录。")
    boundary = (
        "该结论来自 MineContext 本地活动记录和截图路径线索；可以说明当时 PC 画面和操作线索。"
        if can_confirm
        else "MineContext 未返回直接活动命中；当前结果只能作为上下文线索，不能客观确认具体动作。"
    )
    return MineContextGodviewResult(
        can_confirm=can_confirm,
        confidence=confidence,
        time_range={"target": target, "window_minutes": window},
        activity_ids=activity_ids,
        context_ids=context_ids,
        summary=summary,
        evidence_level=evidence_level,  # type: ignore[arg-type]
        evidence_boundary=boundary + " 如需确认远程仓库、云效或线上接口状态，需要回源系统实时验证。",
        screenshot_paths=paths,
        raw_output=redact_sensitive_text(data) if include_raw_output else None,
    )


def classify_search_match(query: str, matched_keywords: list[str], source_kind: str, screenshot_paths: list[str], aliases: dict[str, list[str]]) -> tuple[str, bool, float, str]:
    required_aliases: set[str] = set()
    query_lower = query.lower()
    for key, values in aliases.items():
        if key.lower() in query_lower or any(value.lower() in query_lower for value in values):
            required_aliases.update(value.lower() for value in values)
    if not required_aliases:
        required_aliases.update(term.lower() for term in re.split(r"[\s,，。；;、/\\?？]+", query) if len(term.strip()) >= 2 and term.lower() not in GENERIC_WEB_TERMS)
    hit_subject = any(keyword.lower() in required_aliases for keyword in matched_keywords)
    generic_only = bool(matched_keywords) and not hit_subject
    if source_kind == "activity" and hit_subject and screenshot_paths:
        return "confirmed_match", True, 0.86, "activity_record"
    if source_kind == "activity" and hit_subject:
        return "confirmed_match", True, 0.78, "activity_record"
    if source_kind in {"context", "activity_context", "state_context"} and hit_subject:
        return "likely_match", True, 0.62, "context_summary"
    if hit_subject:
        return "weak_hint", False, 0.42, "semantic_hit"
    if generic_only:
        return "not_confirmed", False, 0.18, "semantic_hit"
    return "not_confirmed", False, 0.0, "generated_report"


def search_results_from_json(data: dict[str, Any], aliases: dict[str, list[str]]) -> list[MineContextSearchResult]:
    results: list[MineContextSearchResult] = []
    query = str(data.get("query") or "")
    groups = [
        ("activity", data.get("activity_matches") or []),
        ("context", data.get("context_matches") or []),
        ("report", data.get("report_matches") or []),
    ]
    for group_kind, items in groups:
        for item in items:
            refs = item.get("evidence_refs") or []
            paths = screenshot_paths_from_refs(refs) or screenshot_paths_from_resources((item.get("raw") or {}).get("resources"))
            matched = [str(keyword) for keyword in item.get("matched_keywords") or []]
            match_level, can_confirm, confidence, evidence_level = classify_search_match(query, matched, group_kind, paths, aliases)
            started_at = item.get("start_time") or item.get("event_time")
            ended_at = item.get("end_time")
            results.append(
                MineContextSearchResult(
                    match_level=match_level,  # type: ignore[arg-type]
                    can_confirm=can_confirm,
                    confidence=confidence,
                    source_kind=group_kind,
                    source_id=str(item.get("source_id") or item.get("id") or ""),
                    started_at=str(started_at) if started_at else None,
                    ended_at=str(ended_at) if ended_at else None,
                    title=item.get("title"),
                    summary=trim(item.get("summary") or item.get("content") or item.get("title")),
                    matched_keywords=matched,
                    evidence_level=evidence_level,  # type: ignore[arg-type]
                    evidence_boundary="命中等级基于目标主体词、来源类型和截图路径判断；生成式上下文只作为线索，不作为最终事实。",
                    screenshot_paths=paths,
                )
            )
    return results


def pc_event_from_activity(activity: MineContextActivity, user_id: str = "demo-user") -> dict[str, Any]:
    text = f"{activity.title or ''} {activity.summary or ''}"
    paths = screenshot_paths_from_resources(activity.resources)
    started = activity.started_at
    ended = activity.ended_at
    duration = int((ended - started).total_seconds()) if ended and ended >= started else None
    return {
        "user_id": user_id,
        "household_id": None,
        "source": "minecontext",
        "source_activity_id": activity.source_activity_id,
        "source_context_id": None,
        "started_at": started.isoformat(),
        "ended_at": ended.isoformat() if ended else None,
        "duration_seconds": duration,
        "title": redact_sensitive_text(activity.title),
        "summary": redact_sensitive_text(activity.summary),
        "app_name": infer_app_name(text),
        "window_title": activity.title,
        "url": None,
        "domain": infer_domain(text),
        "project_name": None,
        "repo_name": None,
        "document_name": None,
        "activity_type": classify_activity_type(text),
        "confidence": 0.78 if paths else 0.68,
        "evidence_level": "activity_record",
        "evidence": {"source": "minecontext_db_readonly", "resource_count": len(activity.resources)},
        "screenshot_paths": paths,
        "raw_ref": f"minecontext:activity/{activity.source_activity_id}",
        "privacy_level": "local_sensitive",
    }
