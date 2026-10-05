import hmac
import os
import re
from dataclasses import dataclass, field
from typing import Mapping

from starlette.responses import JSONResponse

from .origin_policy import LOOPBACK_HOSTS, OriginPolicy, local_host

SESSION_HEADER = "X-OpenButler-Session"
DEMO_READS = frozenset({
    "/health", "/api/events", "/api/plugins", "/api/privacy-mode",
    "/api/butler/home", "/api/butler/timeline", "/api/butler/insights",
    "/api/butler/metrics/today", "/api/butler/metrics/trend",
    "/api/butler/briefings", "/api/butler/goals",
    "/api/butler/insights/noise-evaluation",
})


@dataclass(frozen=True)
class LocalSessionPolicy:
    mode: str
    token: str | None = field(repr=False)
    origins: OriginPolicy
    preview_builtin: bool = False

    @classmethod
    def from_environ(cls, env: Mapping[str, str] | None = None):
        env = os.environ if env is None else env
        demo = env.get("OPENBUTLER_DEPLOY_TARGET") == "vercel" and env.get("OPENBUTLER_DESKTOP") != "1"
        if demo:
            return cls("demo", None, OriginPolicy.demo(env.get("OPENBUTLER_ALLOWED_ORIGINS", "https://openbutler.vercel.app")))
        token = env.get("OPENBUTLER_SESSION_TOKEN")
        if not token or not re.fullmatch(r"[a-fA-F0-9]{64}", token):
            token = None
        return cls("local", token, OriginPolicy.local(env.get("OPENBUTLER_ALLOWED_ORIGINS", "")),
                   env.get("OPENBUTLER_DESKTOP") == "1" and env.get("OPENBUTLER_PREVIEW_BUILTIN") == "1")


class LocalSessionMiddleware:
    def __init__(self, app, policy: LocalSessionPolicy):
        self.app, self.policy = app, policy

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        raw = scope.get("headers", ())
        names = [key.lower() for key, _ in raw]
        if any(names.count(key) > 1 for key in (b"host", b"origin", b"x-openbutler-session")):
            return await self.deny(scope, receive, send, 403, "request_not_allowed")
        headers = {key.lower(): value.decode("latin1") for key, value in raw}
        origin = headers.get(b"origin")
        if not self.policy.origins.accepts(origin):
            return await self.deny(scope, receive, send, 403, "origin_not_allowed")
        method, path = scope["method"], scope["path"]
        if self.policy.preview_builtin and (
            path.startswith("/api/pc-activity/minecontext/")
            or path == "/api/butler/import/pc-activity/preview"
        ):
            return await self.deny(scope, receive, send, 403, "legacy_source_disabled")
        if self.policy.mode == "local":
            peer = (scope.get("client") or (None,))[0]
            if peer not in LOOPBACK_HOSTS or not local_host(headers.get(b"host", "")):
                return await self.deny(scope, receive, send, 403, "loopback_required")
        if method == "OPTIONS" and origin is not None:
            return await self.app(scope, receive, send)
        if method in {"GET", "HEAD"} and path == "/health":
            return await self.app(scope, receive, send)
        if self.policy.mode == "demo":
            if method not in {"GET", "HEAD"} or path not in DEMO_READS:
                return await self.deny(scope, receive, send, 403, "demo_read_only")
        else:
            if self.policy.token is None:
                return await self.deny(scope, receive, send, 503, "local_session_unavailable")
            supplied = headers.get(b"x-openbutler-session", "").encode("latin1")
            if not hmac.compare_digest(supplied, self.policy.token.encode("ascii")):
                return await self.deny(scope, receive, send, 401, "local_session_required")
        return await self.app(scope, receive, send)

    @staticmethod
    async def deny(scope, receive, send, status, code):
        await JSONResponse({"detail": code}, status_code=status,
                           headers={"Cache-Control": "no-store"})(scope, receive, send)
