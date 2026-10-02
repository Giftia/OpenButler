"""Turn one locally masked observation into a bounded, evidence-linked result."""

import json
import re

from app.modules.model_gateway.gateway import CallAuthorization, Gateway, RouteError
from .capture import CaptureStore


class ObservationProcessor:
    def __init__(self, captures: CaptureStore, gateway: Gateway, authorization) -> None:
        self.captures = captures
        self.gateway = gateway
        self.authorization = authorization

    def process(self, event_id: str, masked_image: bytes) -> bool:
        auth: CallAuthorization = self.authorization()
        if not self.gateway.status().ready or not auth.authorized or not auth.redacted:
            self.captures.set_result(event_id, state="model_unavailable")
            return False
        try:
            description = self.captures.with_processing_consent(lambda: self.gateway.call_image(
                "只描述画面中可见的工作内容，不推断用户身份、私人动机或远程系统状态。"
                "如果无法看清，请直接说明无法确认。不要输出思考过程。", masked_image, auth)
            )
            if len(description) > 4000 or re.search(r"<\s*(?:think|analysis)\b", description, re.I):
                raise ValueError("unsafe_model_result")
            response = self.captures.with_processing_consent(lambda: self.gateway.call_text(
                "把下面这段已遮挡画面的观察整理为一条中文时间线记录。"
                "只依据给定观察；不推断画面之外的活动、远程任务结果或个人特征。"
                "仅返回 JSON 对象，键为 title、summary、boundary，分别为简短标题、"
                "一句事实摘要和不确定性边界。观察内容：\n" + description, auth)
            )
            parsed = json.loads(response)
            if not isinstance(parsed, dict) or set(parsed) != {"title", "summary", "boundary"}:
                raise ValueError("invalid_result_shape")
            fields = [parsed[key] for key in ("title", "summary", "boundary")]
            if any(not isinstance(value, str) or not value.strip() or len(value) > limit
                   for value, limit in zip(fields, (100, 500, 300))):
                raise ValueError("invalid_result_field")
            if any(re.search(r"<\s*(?:think|analysis)\b", value, re.I) for value in fields):
                raise ValueError("unsafe_model_result")
            self.captures.set_result(event_id, state="ready", title=fields[0].strip(),
                                     summary=fields[1].strip(), boundary=fields[2].strip())
            return True
        except (RouteError, PermissionError, ValueError, TypeError, json.JSONDecodeError):
            self.captures.set_result(event_id, state="model_unavailable")
            return False
