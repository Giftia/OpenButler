from __future__ import annotations

from typing import Any


def pc_activity_to_unified(event: dict[str, Any]) -> dict[str, Any]:
    title = event.get("title") or event.get("app_name") or event.get("activity_type") or "PC activity"
    evidence_refs = [
        {"kind": "pc_activity_event", "id": event.get("id"), "source_activity_id": event.get("source_activity_id")}
    ]
    for path in event.get("screenshot_paths") or []:
        evidence_refs.append({"kind": "screenshot_path", "path": path})
    tags = [tag for tag in [event.get("activity_type"), event.get("app_name"), event.get("domain"), event.get("project_name")] if tag]
    return {
        "user_id": event.get("user_id", "demo-user"),
        "household_id": event.get("household_id"),
        "source": "pc_activity",
        "source_event_id": event.get("id"),
        "source_type": "minecontext",
        "started_at": event["started_at"],
        "ended_at": event.get("ended_at"),
        "duration_seconds": event.get("duration_seconds"),
        "title": str(title),
        "summary": event.get("summary"),
        "event_type": "pc_activity",
        "entities": {
            "app_name": event.get("app_name"),
            "domain": event.get("domain"),
            "project_name": event.get("project_name"),
            "repo_name": event.get("repo_name"),
            "document_name": event.get("document_name"),
        },
        "metrics": {"duration_seconds": event.get("duration_seconds") or 0},
        "tags": tags,
        "confidence": float(event.get("confidence") or 0.5),
        "evidence_level": event.get("evidence_level") or "activity_record",
        "evidence_refs": evidence_refs,
        "evidence_boundary": "该事件由 MineContext PC 活动记录导入 OpenButler；可说明本机操作线索，不能确认远程系统实时状态。",
        "privacy_level": event.get("privacy_level") or "local_sensitive",
    }
