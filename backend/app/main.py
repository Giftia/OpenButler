from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.modules.butler_core import init_butler_core_db
from app.modules.butler_core.router import (
    configure_butler_core,
    router as butler_router,
)
from app.modules.butler_core.service import ButlerCoreService
from app.modules.butler_core.tools.proactive_chat_tool import render_proactive_butler_chat
from app.modules.pc_activity_context import init_pc_activity_context_db
from app.modules.pc_activity_context.router import (
    configure_pc_activity_context,
    router as pc_activity_router,
)
from app.modules.pc_activity_context.service import PCActivityContextService
from app.modules.pc_activity_context.tools.query_pc_activity_tool import render_query_result
from app.modules.pc_activity_context.tools.search_pc_activity_tool import render_search_result
from app.modules.pc_activity_context.tools.today_pc_summary_tool import render_today_pc_summary
from app.modules.workstation_vision import init_workstation_vision_db
from app.modules.workstation_vision.router import (
    configure_workstation_vision,
    router as workstation_vision_router,
    vision_router,
)
from app.modules.workstation_vision.service import WorkstationVisionService
from app.modules.workstation_vision.tools.workstation_status_tool import render_status_text
from app.modules.workstation_vision.tools.workstation_summary_tool import render_summary_text


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("OPENBUTLER_DATA_DIR", BASE_DIR.parent / "data"))
DB_PATH = DATA_DIR / "openbutler.sqlite3"
PLUGIN_DIR = BASE_DIR / "plugins"

PrivacyMode = Literal["basic", "strict"]


class PrivacyModePayload(BaseModel):
    mode: PrivacyMode


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    user_id: str = "demo-user"


class SimulateRequest(BaseModel):
    scenario: str = "daily_context"


class AutoClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        should_suppress = super().__exit__(exc_type, exc_value, traceback)
        self.close()
        return should_suppress


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, factory=AutoClosingConnection)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                event_type TEXT NOT NULL,
                source TEXT NOT NULL,
                subject TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                object_label TEXT,
                location TEXT,
                score REAL,
                evidence_chain TEXT NOT NULL,
                payload TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        default_privacy_mode = os.getenv("OPENBUTLER_DEFAULT_PRIVACY_MODE", "basic")
        if default_privacy_mode not in {"basic", "strict"}:
            default_privacy_mode = "basic"
        conn.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES('privacy_mode', ?)",
            (default_privacy_mode,),
        )
        init_workstation_vision_db(conn)
        init_pc_activity_context_db(conn)
        init_butler_core_db(conn)


def row_to_event(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["evidence_chain"] = json.loads(item["evidence_chain"])
    item["payload"] = json.loads(item["payload"])
    return item


def get_privacy_mode() -> PrivacyMode:
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'privacy_mode'"
        ).fetchone()
    return (row["value"] if row else "basic")  # type: ignore[return-value]


def set_privacy_mode(mode: PrivacyMode) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO settings(key, value)
            VALUES('privacy_mode', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (mode,),
        )


def insert_event(event: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": event.get("id", str(uuid.uuid4())),
        "timestamp": event.get("timestamp", utc_now()),
        "event_type": event["event_type"],
        "source": event["source"],
        "subject": event.get("subject", "家庭"),
        "title": event["title"],
        "summary": event["summary"],
        "object_label": event.get("object_label"),
        "location": event.get("location"),
        "score": event.get("score"),
        "evidence_chain": event.get("evidence_chain", []),
        "payload": event.get("payload", {}),
    }
    with db() as conn:
        conn.execute(
            """
            INSERT INTO events (
                id, timestamp, event_type, source, subject, title, summary,
                object_label, location, score, evidence_chain, payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item["id"],
                item["timestamp"],
                item["event_type"],
                item["source"],
                item["subject"],
                item["title"],
                item["summary"],
                item["object_label"],
                item["location"],
                item["score"],
                json.dumps(item["evidence_chain"], ensure_ascii=False),
                json.dumps(item["payload"], ensure_ascii=False),
            ),
        )
    return item


def seed_events_if_empty() -> None:
    with db() as conn:
        count = conn.execute("SELECT COUNT(*) AS count FROM events").fetchone()["count"]
    if count:
        return
    for event in demo_events("seed"):
        insert_event(event)


def seed_vercel_demo_if_enabled() -> None:
    if os.getenv("OPENBUTLER_DEPLOY_TARGET") != "vercel" and os.getenv("OPENBUTLER_ENABLE_DEMO_DATA") != "1":
        return
    pc_activity = PCActivityContextService(DB_PATH, DATA_DIR / "minecontext_runtime")
    if pc_activity.events():
        return
    now = datetime.combine(date.today(), datetime.min.time(), tzinfo=timezone.utc).replace(hour=9)
    samples = [
        ("OpenButler coding block", "VS Code", None, "OpenButler", "OpenButler", "coding", 42),
        ("Review Productization docs", "Chrome", "github.com", "OpenButler", "OpenButler", "browser", 28),
        ("Run local verification", "Terminal", None, "OpenButler", "OpenButler", "terminal", 24),
        ("Check OpenButler Inbox", "Chrome", "openbutler.vercel.app", "OpenButler", "OpenButler", "browser", 18),
    ]
    for day_offset in range(7):
        day_start = now - timedelta(days=day_offset)
        cursor = day_start
        for index, (title, app, domain, project, repo, activity_type, minutes) in enumerate(samples):
            start = cursor
            end = start + timedelta(minutes=minutes)
            cursor = end + timedelta(minutes=6 + index)
            pc_activity.create_event(
                {
                    "user_id": "demo-user",
                    "household_id": None,
                    "source": "minecontext",
                    "source_activity_id": f"vercel-demo-{day_offset}-{index}",
                    "source_context_id": f"vercel-demo-ctx-{day_offset}-{index}",
                    "started_at": start.isoformat(),
                    "ended_at": end.isoformat(),
                    "duration_seconds": minutes * 60,
                    "title": title,
                    "summary": "Demo-only PC activity for Vercel product experience; not real MineContext data.",
                    "app_name": app,
                    "window_title": title,
                    "url": f"https://{domain}/openbutler" if domain else None,
                    "domain": domain,
                    "project_name": project,
                    "repo_name": repo,
                    "document_name": "Productization Harness" if index == 1 else None,
                    "activity_type": activity_type,
                    "confidence": 0.78,
                    "evidence_level": "activity_record",
                    "evidence": {
                        "demo_mode": True,
                        "deploy_target": os.getenv("OPENBUTLER_DEPLOY_TARGET"),
                        "boundary": "Synthetic demo event for hosted prototype only.",
                    },
                    "screenshot_paths": [],
                    "raw_ref": f"openbutler:vercel-demo/{day_offset}/{index}",
                    "privacy_level": "shareable_summary",
                }
            )
    butler = ButlerCoreService(DB_PATH, DATA_DIR / "minecontext_runtime")
    butler.rebuild_timeline()
    butler.metrics_today()
    butler.generate_insights(force=True)
    butler.generate_briefing("evening")


def demo_events(scenario: str) -> list[dict[str, Any]]:
    now = utc_now()
    suffix = scenario.replace("_", " ")
    return [
        {
            "timestamp": now,
            "event_type": "object_seen",
            "source": "phone_album",
            "subject": "Alex",
            "title": "钥匙出现在玄关托盘",
            "summary": f"模拟事件 {suffix}: 在 09:22 的相册帧中识别到钥匙，位置靠近玄关托盘左侧。",
            "object_label": "钥匙",
            "location": "玄关托盘",
            "score": 0.93,
            "evidence_chain": [
                {"kind": "raw_object", "uri": "storage/raw/photo_0922.jpg"},
                {"kind": "plugin", "id": "image-object-locator", "version": "0.1.0"},
            ],
            "payload": {"bbox": [0.62, 0.48, 0.18, 0.14], "room": "玄关"},
        },
        {
            "timestamp": now,
            "event_type": "light_score",
            "source": "smart_glasses",
            "subject": "Mia",
            "title": "书桌自然光偏低",
            "summary": "智能眼镜画面估算书桌光照 58/100，建议补充台灯或靠窗活动。",
            "object_label": "书桌",
            "location": "次卧书桌",
            "score": 58,
            "evidence_chain": [
                {"kind": "raw_object", "uri": "storage/raw/glasses_frame_1450.jpg"},
                {"kind": "plugin", "id": "image-light-score", "version": "0.1.0"},
            ],
            "payload": {"lux_estimate": 310, "confidence": 0.81},
        },
        {
            "timestamp": now,
            "event_type": "achievement",
            "source": "notes",
            "subject": "家庭",
            "title": "小成就：连续三天整理餐桌",
            "summary": "备忘录和相册事件共同确认餐桌整理习惯已连续三天完成。",
            "object_label": "餐桌",
            "location": "客厅",
            "score": 3,
            "evidence_chain": [
                {"kind": "event_ref", "id": "mock-table-day-1"},
                {"kind": "event_ref", "id": "mock-table-day-2"},
            ],
            "payload": {"streak_days": 3, "badge": "整洁启动"},
        },
    ]


def load_plugin_manifests() -> list[dict[str, Any]]:
    plugins: list[dict[str, Any]] = []
    for path in sorted(PLUGIN_DIR.glob("*.json")):
        with path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        manifest["manifest_path"] = str(path.relative_to(BASE_DIR))
        plugins.append(manifest)
    return plugins


def privacy_evaluation(manifest: dict[str, Any], mode: PrivacyMode) -> dict[str, Any]:
    permissions = set(manifest.get("permissions", []))
    model_requirements = manifest.get("model_requirements", {})
    provider = model_requirements.get("provider")
    blocked_reasons: list[str] = []
    if mode == "strict":
        if manifest.get("privacy_level") not in {"strict", "strict_local"}:
            blocked_reasons.append("插件隐私级别不是 strict")
        if provider == "cloud":
            blocked_reasons.append("strict 模式禁止云端模型")
        if permissions.intersection({"external_network", "cloud_api", "external_webhook"}):
            blocked_reasons.append("strict 模式禁止外部网络、云 API 或外部 Webhook")
    return {"available": not blocked_reasons, "blocked_reasons": blocked_reasons}


def list_events(search: str | None = None) -> list[dict[str, Any]]:
    with db() as conn:
        if search:
            like = f"%{search}%"
            rows = conn.execute(
                """
                SELECT * FROM events
                WHERE title LIKE ? OR summary LIKE ? OR object_label LIKE ? OR location LIKE ?
                ORDER BY timestamp DESC
                """,
                (like, like, like, like),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM events ORDER BY timestamp DESC"
            ).fetchall()
    return [row_to_event(row) for row in rows]


app = FastAPI(
    title="OpenButler API",
    version="0.1.0",
    description="Local-first AI butler prototype API with privacy guard and plugin manifests.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

configure_workstation_vision(DB_PATH)
configure_pc_activity_context(DB_PATH, DATA_DIR / "minecontext_runtime")
configure_butler_core(DB_PATH, DATA_DIR / "minecontext_runtime")
app.include_router(workstation_vision_router)
app.include_router(vision_router)
app.include_router(pc_activity_router)
app.include_router(butler_router)


@app.on_event("startup")
def startup() -> None:
    init_db()
    seed_events_if_empty()
    seed_vercel_demo_if_enabled()


@app.middleware("http")
async def ensure_vercel_demo_data(request, call_next):
    if request.url.path == "/health" or request.url.path.startswith("/api/"):
        init_db()
        seed_events_if_empty()
        seed_vercel_demo_if_enabled()
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "openbutler-api", "privacy_mode": get_privacy_mode()}


@app.get("/api/events")
def api_events(q: str | None = Query(default=None)) -> dict[str, Any]:
    events = list_events(q)
    return {"items": events, "count": len(events)}


@app.post("/api/events/simulate")
def simulate_events(payload: SimulateRequest) -> dict[str, Any]:
    created = [insert_event(event) for event in demo_events(payload.scenario)]
    return {"created": created, "count": len(created)}


@app.get("/api/plugins")
def api_plugins() -> dict[str, Any]:
    mode = get_privacy_mode()
    plugins = []
    for manifest in load_plugin_manifests():
        plugins.append({**manifest, "runtime": privacy_evaluation(manifest, mode)})
    return {"items": plugins, "privacy_mode": mode, "count": len(plugins)}


@app.get("/api/privacy-mode")
def get_mode() -> dict[str, PrivacyMode]:
    return {"mode": get_privacy_mode()}


@app.post("/api/privacy-mode")
def update_mode(payload: PrivacyModePayload) -> dict[str, PrivacyMode]:
    set_privacy_mode(payload.mode)
    return {"mode": payload.mode}


def compose_chat_answer(
    *,
    conclusion: str,
    key_numbers: str | None,
    evidence: str,
    boundary: str,
    next_step: str,
) -> str:
    parts = [f"结论：{conclusion}"]
    if key_numbers:
        parts.append(f"关键数字：{key_numbers}")
    parts.extend(
        [
            f"依据：{evidence}",
            f"边界说明：{boundary}",
            f"下一步：{next_step}",
        ]
    )
    return "\n".join(parts)


def user_facing_source(source: str | None) -> str:
    mapping = {
        "phone_album": "相册线索（样例）",
        "minecontext": "电脑活动",
        "godview": "本机回溯",
        "pc_activity": "电脑活动",
        "butler_core": "管家整理",
        "workstation_vision": "工位观察",
        "manual": "手动记录",
        "seed": "样例线索",
    }
    return mapping.get(str(source or "").lower(), "本地记录")


@app.post("/api/chat")
def chat(payload: ChatRequest) -> dict[str, Any]:
    message = payload.message.lower()
    events = list_events()
    if "钥匙" in message or "key" in message:
        match = next((e for e in events if e.get("object_label") == "钥匙"), None)
        if match:
            answer = compose_chat_answer(
                conclusion=f"我最近一次看到钥匙是在{match['location']}。",
                key_numbers="找到 1 条相关记录。",
                evidence=f"{user_facing_source(match.get('source'))}：{match['summary']}",
                boundary="这可能是样例或本地派生记录，不代表真实相册或摄像头事实。需要确认时，请回到原始线索查看。",
                next_step="如果你想确认真实位置，先接入本地相册或摄像头线索；未授权时不会读取真实数据。",
            )
        else:
            answer = compose_chat_answer(
                conclusion="我还没有找到钥匙记录。",
                key_numbers=None,
                evidence="当前事件湖里没有钥匙相关记录。",
                boundary="没有记录时，我不会凭聊天记忆猜测位置。",
                next_step="可以先看样例，或在本机环境里接入相册、视频或摄像头线索。",
            )
    elif "光照" in message or "light" in message:
        light_events = [e for e in events if e["event_type"] == "light_score"]
        score = light_events[0]["score"] if light_events else None
        if score is None:
            answer = compose_chat_answer(
                conclusion="今天还没有光照评分。",
                key_numbers=None,
                evidence="当前事件湖里没有光照评分记录。",
                boundary="数据不足时，我不会判断环境是否适合阅读或工作。",
                next_step="可以先看样例，或在本机环境里接入已授权的视觉线索。",
            )
        elif score >= 75:
            answer = compose_chat_answer(
                conclusion="今天光照比较充足。",
                key_numbers=f"当前评分 {score}/100。",
                evidence="来自已授权的本地光照评分事件。",
                boundary="这只是环境线索，不是健康或医学判断。",
                next_step="如果准备阅读或拍摄，可以继续；如果眼睛不舒服，仍然以自己的感受为准。",
            )
        else:
            answer = compose_chat_answer(
                conclusion="今天光照偏低。",
                key_numbers=f"当前评分 {score}/100。",
                evidence="来自已授权的本地光照评分事件。",
                boundary="这只是环境线索，不是健康或医学判断。",
                next_step="可以打开台灯，或把需要精细用眼的活动移到窗边。",
            )
    elif "成就" in message or "总结" in message or "achievement" in message:
        achievements = [e for e in events if e["event_type"] == "achievement"]
        titles = "；".join(e["title"] for e in achievements[:3])
        answer = compose_chat_answer(
            conclusion="本周的小成就可以先看这些。",
            key_numbers=f"已记录 {len(achievements)} 个小成就。",
            evidence=f"代表性进展：{titles or '暂无可展示记录'}。",
            boundary="这些来自本地事件湖记录，不代表外部系统的完成状态。",
            next_step="如果要确认提交、部署或任务完成情况，请回到对应系统检查。",
        )
    elif any(keyword in payload.message for keyword in ["值得注意", "应该先做", "深度工作", "上下文切换", "晚间复盘", "今晚复盘", "生成复盘", "主动洞察", "开工恢复", "建议不准确", "以后少提醒", "今天我主要", "主要做了什么", "查看今日记录", "查时间线", "时间线", "解释依据", "依据是什么", "修改偏好", "提醒偏好", "少提醒", "不准确"]):
        butler = ButlerCoreService(DB_PATH, DATA_DIR / "minecontext_runtime")
        answer = render_proactive_butler_chat(payload.message, butler)
    elif any(keyword in payload.message for keyword in ["点", "几点", "什么时候", "打开过", "访问过", "小红书", "pc", "电脑", "主要在忙", "项目上花", "分心", "重复做", "上午写代码", "主要做了什么"]):
        pc_activity = PCActivityContextService(DB_PATH, DATA_DIR / "minecontext_runtime")
        if any(keyword in payload.message for keyword in ["什么时候", "打开过", "访问过", "小红书", "网站", "网页"]):
            query_text = payload.message
            result = pc_activity.search(query_text, limit=5)
            answer = render_search_result(result)
        elif any(keyword in payload.message for keyword in ["点", "几点", "做了什么", "在干嘛"]):
            result = pc_activity.query_at_time(payload.message, 10)
            answer = render_query_result(result)
        else:
            answer = render_today_pc_summary(pc_activity.summary())
    elif any(keyword in payload.message for keyword in ["视觉", "摄像头", "工位", "实际工作", "坐太久", "离座", "专注", "休息", "疲劳", "姿态"]):
        workstation = WorkstationVisionService(DB_PATH)
        if any(keyword in payload.message for keyword in ["多久", "时长", "总结", "离座"]):
            answer = render_summary_text(workstation.today_summary())
        elif any(keyword in payload.message for keyword in ["休息", "疲劳"]):
            summary = workstation.today_summary()
            fatigue_count = summary.get("metrics", {}).get("fatigue_signal_count", 0)
            if fatigue_count:
                answer = (
                    f"今天已有 {fatigue_count} 次可能疲劳提示。建议短暂休息 3 到 5 分钟，活动肩颈并补充光照。"
                    "这个判断只基于本地视觉感知可观察线索，不代表医学结论。"
                )
            else:
                answer = "目前视觉感知数据中没有足够疲劳信号。数据不足时我不会做确定判断。"
        else:
            answer = render_status_text(workstation.status())
    else:
        answer = compose_chat_answer(
            conclusion="我现在最适合帮你回看今天、查时间线、解释提醒依据，或记录你的反馈。",
            key_numbers="这个问题没有命中可查询的数据。",
            evidence="我只检查 OpenButler 已授权的本地派生数据。",
            boundary="我不会凭聊天记忆补事实，也不能确认远程仓库、部署、接口或任务系统的实时状态。",
            next_step="你可以问“今天有什么值得注意？”、“查看今日记录”或“解释这条提醒的依据”。",
        )
    return {
        "answer": answer,
        "privacy_mode": get_privacy_mode(),
        "evidence_event_count": len(events),
    }


@app.get("/api/openclaw/skill")
def openclaw_skill() -> dict[str, Any]:
    skill_path = BASE_DIR.parents[1] / "openclaw" / "SKILL.md"
    fallback_skill = """---
name: openbutler
description: Query a local-first OpenButler personal or family event lake through HTTP tools.
---

# OpenButler Skill

Use `/api/chat`, `/api/events`, `/api/plugins`, and `/api/privacy-mode` to access the local OpenButler prototype. In strict mode, do not call cloud models, cloud APIs, external network tools, or external webhooks.
"""
    return {
        "name": "openbutler",
        "skill_md": skill_path.read_text(encoding="utf-8") if skill_path.exists() else fallback_skill,
        "tools": [
            {"method": "POST", "path": "/api/chat", "description": "Ask the local butler."},
            {"method": "GET", "path": "/api/events", "description": "Search event lake."},
        ],
    }
