"""Desktop session protected model settings; keys exist in process memory only."""

from threading import RLock
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.modules.context_engine.audit import PrivacyAuditLedger
from app.modules.context_engine.privacy import AuditedPrivacyGuard
from .gateway import CallAuthorization, Gateway, ModelRoute, RouteError


class RouteInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    protocol: Literal["openai_compatible", "ollama_native"]
    mode: Literal["local", "custom"]
    endpoint: str = Field(max_length=500)
    model: str = Field(max_length=200)
    api_key: str | None = Field(default=None, max_length=4096, repr=False)
    thinking: bool = False

    def route(self) -> ModelRoute:
        return ModelRoute(**self.model_dump())


class ModelSettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    image: RouteInput
    text: RouteInput
    external_consent: bool = False
    masked_data_consent: bool = False


class ValidateEndpointInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    target: Literal["image", "text"]
    route: RouteInput
    external_consent: bool = False


def create_model_settings_router(connection_factory, get_privacy_mode, set_privacy_mode, *, dispatch_lock=None):
    router = APIRouter()
    policy_lock = dispatch_lock if dispatch_lock is not None else RLock()
    gateway = Gateway(AuditedPrivacyGuard(PrivacyAuditLedger(connection_factory)),
                      privacy_mode_getter=get_privacy_mode, dispatch_lock=policy_lock)
    lock = RLock()
    active: dict = {"image": None, "text": None, "external_consent": False,
                    "masked_data_consent": False}

    def public_status():
        state = gateway.status()
        def route_status(name):
            route = active[name]
            if route is None:
                return {"configured": False, "apiKeyConfigured": False}
            return {"configured": True, "protocol": route.protocol, "mode": route.mode,
                    "endpoint": route.endpoint, "model": route.model,
                    "apiKeyConfigured": bool(route.api_key), "thinking": route.thinking}
        return {"ready": state.ready, "last_attempt": state.last_attempt,
                "error_code": state.error_code, "image": route_status("image"),
                "text": route_status("text"),
                "external_consent": active["external_consent"],
                "masked_data_consent": active["masked_data_consent"]}

    @router.get("/api/model_settings/get")
    def get_settings():
        with lock:
            return public_status()

    @router.post("/api/model_settings/validate_endpoint")
    def validate_endpoint(request: ValidateEndpointInput):
        try:
            route = request.route.route()
            auth = CallAuthorization(
                privacy_mode="basic" if route.mode == "custom" and request.external_consent
                else get_privacy_mode(), authorized=route.mode == "local" or request.external_consent,
                redacted=True,
            )
            gateway.validate_route(target=request.target, route=route, auth=auth)
            return {"ok": True, "target": request.target}
        except (RouteError, PermissionError, ValueError) as error:
            code = error.args[0] if error.args else "model_validation_failed"
            if not isinstance(code, str) or len(code) > 80:
                code = "model_validation_failed"
            return {"ok": False, "target": request.target, "error_code": code}

    @router.post("/api/model_settings/update")
    def update_settings(request: ModelSettingsInput):
        # Keep model-state -> policy-lock order; runtime dispatch does not call
        # current_authorization while holding the policy lock.
        with lock, policy_lock:
            try:
                image, text = request.image.route(), request.text.route()
                external = any(route.mode == "custom" for route in (image, text))
                if external and (not request.external_consent or not request.masked_data_consent):
                    raise PermissionError("external_consent_required")
                mode = "basic" if external else "strict"
                gateway.configure(image=image, text=text,
                                  auth=CallAuthorization(privacy_mode=mode, authorized=True,
                                                         redacted=True))
                # A successful pair becomes active together; strict remains for local-only routes.
                set_privacy_mode(mode)
                active.update(image=image, text=text,
                              external_consent=request.external_consent if external else False,
                              masked_data_consent=request.masked_data_consent if external else False)
                return {"ok": True, **public_status()}
            except (RouteError, PermissionError, ValueError) as error:
                code = error.args[0] if error.args else "model_validation_failed"
                if not isinstance(code, str) or len(code) > 80:
                    code = "model_validation_failed"
                return {"ok": False, "error_code": code, **public_status()}

    @router.post("/api/model_settings/validate")
    def validate_settings(request: ModelSettingsInput):
        # Compatibility path validates a proposed pair without publishing it.
        image = validate_endpoint(ValidateEndpointInput(
            target="image", route=request.image, external_consent=request.external_consent))
        text = validate_endpoint(ValidateEndpointInput(
            target="text", route=request.text, external_consent=request.external_consent))
        return {"ok": image["ok"] and text["ok"], "image": image, "text": text}

    def current_authorization() -> CallAuthorization:
        with lock:
            external = bool(active["external_consent"] and active["masked_data_consent"])
            return CallAuthorization(privacy_mode=get_privacy_mode(),
                                     authorized=bool(gateway.status().ready)
                                     and (not any(route and route.mode == "custom"
                                                  for route in (active["image"], active["text"]))
                                          or external),
                                     redacted=True)

    router.gateway = gateway  # type: ignore[attr-defined]
    router.current_authorization = current_authorization  # type: ignore[attr-defined]
    return router
