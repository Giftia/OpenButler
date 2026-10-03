"""Bounded chat transport and atomic image/text route activation."""

import base64
import errno
from dataclasses import dataclass, field
import http.client
import ipaddress
import json
import os
import select
import socket
import ssl
import struct
from threading import Event, Lock, RLock, Thread, Timer
from time import monotonic
from typing import Callable, Literal, Protocol
from urllib.parse import urlsplit
import zlib

from app.security.privacy_guard import PrivacyRequest


ProtocolName = Literal["openai_compatible", "ollama_native"]
RouteMode = Literal["local", "custom"]
Kind = Literal["image", "text"]
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
HTTP_TOTAL_TIMEOUT_SECONDS = 10
LOCAL_MAX_TOTAL_TIMEOUT_SECONDS = 120
LOCAL_MODEL_CONTEXT_TOKENS = 2048
LOCAL_IMAGE_OUTPUT_TOKENS = 512
LOCAL_TEXT_OUTPUT_TOKENS = 768
LOCAL_MODEL_CPU_THREADS = 6
# Only these engine-authored schemas are admitted. No endpoint, model response or
# untrusted observation can supply a new schema or expand its complexity.
OBSERVATION_JSON_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "title": {"type": "string", "minLength": 1, "maxLength": 100},
        "summary": {"type": "string", "minLength": 1, "maxLength": 500},
        "boundary": {"type": "string", "minLength": 1, "maxLength": 300},
        "comparison": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "performed": {"type": "boolean"},
                "prior_observation_ids": {"type": "array", "maxItems": 3, "uniqueItems": True,
                    "items": {"type": "string", "pattern": "^[0-9a-f-]{36}$"}},
                "current_quote": {"type": "string", "maxLength": 300},
                "prior_quote": {"type": "string", "maxLength": 300},
            },
            "required": ["performed", "prior_observation_ids", "current_quote", "prior_quote"],
        },
    },
    "required": ["title", "summary", "boundary", "comparison"],
}
_OBSERVATION_SCHEMA_JSON = json.dumps(OBSERVATION_JSON_SCHEMA, sort_keys=True, separators=(",", ":"))
# This stronger first-frame contract removes choices that cannot be grounded
# when the processor has selected no prior records. The caller must still
# strictly validate the returned shape and content; this is not output repair.
OBSERVATION_CURRENT_FRAME_BOUNDARY = "仅依据当前可见画面，属于模型推断；不能确认连续活动或远程完成。"
OBSERVATION_NO_PRIOR_JSON_SCHEMA = json.loads(_OBSERVATION_SCHEMA_JSON)
OBSERVATION_NO_PRIOR_JSON_SCHEMA["properties"]["boundary"]["enum"] = [OBSERVATION_CURRENT_FRAME_BOUNDARY]
_no_prior_comparison = OBSERVATION_NO_PRIOR_JSON_SCHEMA["properties"]["comparison"]["properties"]
_no_prior_comparison["performed"]["enum"] = [False]
_no_prior_comparison["prior_observation_ids"]["maxItems"] = 0
_no_prior_comparison["current_quote"]["enum"] = [""]
_no_prior_comparison["prior_quote"]["enum"] = [""]
del _no_prior_comparison
# OCR output must cite source text. These citations establish traceability only;
# free-form model proposals are not accepted as observed screen content.
OCR_OBSERVATION_JSON_SCHEMA = json.loads(json.dumps(OBSERVATION_NO_PRIOR_JSON_SCHEMA))
OCR_OBSERVATION_JSON_SCHEMA["properties"]["source_quotes"] = {
    "type": "array", "minItems": 1, "maxItems": 3, "uniqueItems": True,
    "items": {"type": "string", "minLength": 1, "maxLength": 120},
}
OCR_OBSERVATION_JSON_SCHEMA["required"].append("source_quotes")
TEMPORAL_ASSOCIATION_JSON_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "relations": {"type": "array", "minItems": 1, "maxItems": 3,
            "items": {"type": "object", "additionalProperties": False,
                "properties": {
                    "prior_observation_id": {"type": "string", "pattern": "^[0-9a-f-]{36}$"},
                    "relation": {"type": "string", "enum": ["same_topic", "different_topic", "uncertain"]},
                    "current_quote": {"type": "string", "minLength": 1, "maxLength": 120},
                    "prior_quote": {"type": "string", "minLength": 1, "maxLength": 120},
                },
                "required": ["prior_observation_id", "relation", "current_quote", "prior_quote"],
            }},
    },
    "required": ["relations"],
}
_OBSERVATION_SCHEMA_ALLOWLIST = frozenset((
    _OBSERVATION_SCHEMA_JSON,
    json.dumps(OBSERVATION_NO_PRIOR_JSON_SCHEMA, sort_keys=True, separators=(",", ":")),
    json.dumps(TEMPORAL_ASSOCIATION_JSON_SCHEMA, sort_keys=True, separators=(",", ":")),
    json.dumps(OCR_OBSERVATION_JSON_SCHEMA, sort_keys=True, separators=(",", ":")),
))


def _observation_schema(schema: dict) -> dict:
    # Bound work before serialization/comparison, including recursive/cyclic
    # caller objects. Use exact primitive types and a frozen canonical source;
    # mutating the exported convenience constant cannot enlarge the allowlist.
    visited = 0
    def visit(value, depth=0):
        nonlocal visited
        visited += 1
        if visited > 128 or depth > 8:
            raise RouteError("invalid_json_schema")
        if type(value) is dict:
            if len(value) > 12 or any(type(key) is not str or len(key) > 100 for key in value):
                raise RouteError("invalid_json_schema")
            for child in value.values():
                visit(child, depth + 1)
        elif type(value) is list:
            if len(value) > 12:
                raise RouteError("invalid_json_schema")
            for child in value:
                visit(child, depth + 1)
        elif type(value) is str:
            if len(value) > 1000:
                raise RouteError("invalid_json_schema")
        elif type(value) is bool:
            pass
        elif type(value) is int and 0 <= value <= 10000:
            pass
        else:
            raise RouteError("invalid_json_schema")
    visit(schema)
    canonical = json.dumps(schema, sort_keys=True, separators=(",", ":"))
    if canonical not in _OBSERVATION_SCHEMA_ALLOWLIST:
        raise RouteError("invalid_json_schema")
    return json.loads(canonical)
_PROBE_FONT = {
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "4": ("10010", "10010", "10010", "11111", "00010", "00010", "00010"),
    "2": ("11110", "00001", "00001", "01110", "10000", "10000", "11111"),
    " ": ("00000",) * 7,
}


class RouteError(Exception):
    """Public, content-free failure code."""


@dataclass(frozen=True)
class ModelRoute:
    protocol: ProtocolName
    mode: RouteMode
    endpoint: str
    model: str
    api_key: str | None = field(default=None, repr=False, compare=False)
    thinking: bool = False

    def __post_init__(self) -> None:
        if self.protocol not in ("openai_compatible", "ollama_native"):
            raise ValueError("invalid_protocol")
        if self.mode not in ("local", "custom"):
            raise ValueError("invalid_mode")
        if not self.model or self.model.strip() != self.model or len(self.model) > 200:
            raise ValueError("invalid_model")
        if self.thinking and self.protocol != "ollama_native":
            raise ValueError("thinking_unsupported")
        _endpoint(self)


@dataclass(frozen=True)
class CallAuthorization:
    privacy_mode: Literal["strict", "basic"] = "strict"
    authorized: bool = False
    redacted: bool = False


@dataclass(frozen=True)
class RouteStatus:
    ready: bool
    image_configured: bool
    text_configured: bool
    last_attempt: Literal["never", "passed", "failed"]
    error_code: str | None
    image_protocol: str | None
    text_protocol: str | None
    image_mode: str | None
    text_mode: str | None
    image_key_present: bool
    text_key_present: bool
    local_total_timeout_seconds: float | None = None
    external_total_timeout_seconds: float | None = None


class Guard(Protocol):
    def require(self, request: PrivacyRequest) -> object: ...


class Transport(Protocol):
    def post(self, route: ModelRoute, payload: dict, *, cancel_event: Event | None = None) -> dict: ...


def _endpoint(route: ModelRoute) -> tuple[str, str, int, str]:
    raw = route.endpoint
    if not raw or any(ord(ch) <= 32 or ord(ch) == 127 for ch in raw):
        raise ValueError("invalid_endpoint")
    try:
        parts = urlsplit(raw)
        explicit_port = parts.port
        port = explicit_port if explicit_port is not None else (443 if parts.scheme == "https" else 80)
        host = parts.hostname
    except ValueError:
        raise ValueError("invalid_endpoint") from None
    if (parts.scheme not in ("http", "https") or not host or not port
            or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment or raw.endswith("/")
            or "\\" in raw or "%" in raw or "//" in parts.path
            or any(segment in (".", "..") for segment in parts.path.split("/"))):
        raise ValueError("invalid_endpoint")
    if route.protocol == "openai_compatible":
        if not parts.path or parts.path == "/":
            raise ValueError("invalid_endpoint")
    elif parts.path:
        raise ValueError("invalid_endpoint")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if route.mode == "local":
        if parts.scheme != "http" or not (host == "localhost" or address and address.is_loopback):
            raise ValueError("local_requires_loopback_http")
    elif parts.scheme != "https" or host == "localhost" or address and not address.is_global:
        raise ValueError("custom_requires_public_https")
    return parts.scheme, host, port, parts.path


def _pinned_address(route: ModelRoute, host: str, port: int) -> str:
    if route.mode == "local":
        return "127.0.0.1" if host == "localhost" else host
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
            raise RouteError("unsafe_endpoint")
        return sorted(addresses)[0]
    except (OSError, ValueError):
        raise RouteError("endpoint_resolution_failed") from None


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address: str, *, tls: bool,
                 deadline: float, expired: Event):
        super().__init__(host, port, timeout=max(.001, deadline - monotonic()))
        self.address = address
        self.tls = tls
        self.deadline = deadline
        self.expired = expired
        self.active_socket = None

    def _remaining(self):
        remaining = self.deadline - monotonic()
        if self.expired.is_set() or remaining <= 0:
            raise TimeoutError("request_deadline")
        return remaining

    def connect(self) -> None:
        # Expose the socket before connecting. A blocking create_connection()
        # hides it until success and could delay revocation for the full budget.
        sock = socket.socket(socket.AF_INET6 if ":" in self.address else socket.AF_INET,
                             socket.SOCK_STREAM)
        self.active_socket = self.sock = sock
        try:
            self._remaining()
            sock.setblocking(False)
            result = sock.connect_ex((self.address, self.port))
            while result not in (0, errno.EISCONN):
                if result not in (errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR):
                    raise OSError(result, "connection_failed")
                # Each wait is short even if closing a connecting socket in a
                # different thread does not immediately wake the platform poll.
                try:
                    _, writable, exceptional = select.select([], [sock], [sock], min(.05, self._remaining()))
                except (OSError, ValueError):
                    self._remaining()
                    raise OSError("connection_failed") from None
                self._remaining()
                if writable or exceptional:
                    result = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            sock.settimeout(self._remaining())
            if self.tls:
                # Publish the TLS socket before its network handshake as well.
                self.sock = ssl.create_default_context().wrap_socket(
                    sock, server_hostname=self.host, do_handshake_on_connect=False)
                self.active_socket = self.sock
                self.sock.settimeout(self._remaining())
                self.sock.do_handshake()
            self._remaining()
        except BaseException:
            sock.close()
            if self.sock is not None:
                self.sock.close()
            raise

    def send(self, data):
        self._remaining()
        return super().send(data)


class HttpTransport:
    def __init__(self, *, total_timeout=HTTP_TOTAL_TIMEOUT_SECONDS, local_total_timeout=None):
        if (isinstance(total_timeout, bool) or not isinstance(total_timeout, (int, float))
                or not 0 < total_timeout <= HTTP_TOTAL_TIMEOUT_SECONDS):
            raise ValueError("invalid_transport_deadline")
        # A distinct, trusted local budget can accommodate CPU inference. It
        # never expands the budget of a custom/external route. None preserves
        # existing short-deadline callers and their slow-drip invariants.
        if local_total_timeout is None:
            local_total_timeout = total_timeout
        if (isinstance(local_total_timeout, bool) or not isinstance(local_total_timeout, (int, float))
                or not 0 < local_total_timeout <= LOCAL_MAX_TOTAL_TIMEOUT_SECONDS):
            raise ValueError("invalid_local_transport_deadline")
        self.total_timeout = total_timeout
        self.local_total_timeout = local_total_timeout

    def post(self, route: ModelRoute, payload: dict, *, cancel_event: Event | None = None) -> dict:
        if cancel_event is not None and cancel_event.is_set():
            raise PermissionError("authorization_revoked")
        scheme, host, port, prefix = _endpoint(route)
        address = _pinned_address(route, host, port)
        path = prefix + ("/chat/completions" if route.protocol == "openai_compatible" else "/api/chat")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if route.api_key:
            headers["Authorization"] = "Bearer " + route.api_key
        timeout = self.local_total_timeout if route.mode == "local" else self.total_timeout
        expired = Event()
        finished = Event()
        conn = _PinnedHTTP(host, port, address, tls=scheme == "https",
                           deadline=monotonic() + timeout, expired=expired)
        def abort():
            # Socket inactivity timeouts alone allow indefinite slow-drip
            # responses. The timer only closes sockets; it never sends data.
            expired.set()
            # Keep the connected socket even when HTTPConnection detaches it
            # for HTTP/1.0 or Connection:close while response.fp still reads.
            sock = conn.active_socket
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            conn.close()
        timer = Timer(timeout, abort)
        timer.daemon = True
        timer.start()
        cancellation_watcher = None
        if cancel_event is not None:
            def watch_cancel():
                while not finished.is_set():
                    if cancel_event.is_set():
                        abort()
                        return
                    finished.wait(.05)
            cancellation_watcher = Thread(target=watch_cancel, name="model-http-cancellation", daemon=True)
            cancellation_watcher.start()
        response = None
        try:
            if cancel_event is not None and cancel_event.is_set():
                raise PermissionError("authorization_revoked")
            conn.request("POST", path, body=json.dumps(payload, separators=(",", ":")).encode(), headers=headers)
            response = conn.getresponse()
            if response.status != 200:
                raise RouteError("provider_http_error")
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if cancel_event is not None and cancel_event.is_set():
                raise PermissionError("authorization_revoked")
            if len(body) > MAX_RESPONSE_BYTES:
                raise RouteError("provider_response_too_large")
            if expired.is_set():
                raise RouteError("provider_connection_failed")
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                raise RouteError("invalid_provider_response")
            return parsed
        except (OSError, TimeoutError, ssl.SSLError, http.client.HTTPException):
            if cancel_event is not None and cancel_event.is_set():
                raise PermissionError("authorization_revoked") from None
            raise RouteError("provider_connection_failed") from None
        except (UnicodeError, json.JSONDecodeError):
            raise RouteError("invalid_provider_response") from None
        finally:
            finished.set()
            timer.cancel()
            timer.join()
            if cancellation_watcher is not None:
                cancellation_watcher.join()
            if response is not None:
                response.close()
            conn.close()
            if conn.active_socket is not None:
                conn.active_socket.close()


def synthetic_probe_png() -> bytes:
    """A generated RGB PNG reading TEST 42; no file or screenshot input."""
    scale, label = 5, "TEST 42"
    width, height = (len(label) * 6 + 1) * scale, 9 * scale
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            glyph = x // (6 * scale)
            gy, gx = y // scale - 1, x // scale % 6
            ink = (glyph < len(label) and 0 <= gy < 7 and gx < 5
                   and _PROBE_FONT[label[glyph]][gy][gx] == "1")
            row.extend((0, 0, 0) if ink else (255, 255, 255))
        rows.append(bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))


def _payload(route: ModelRoute, prompt: str, image: bytes | None, *, json_schema: dict | None = None,
             local_cpu_profile: Literal["observation"] | None = None) -> dict:
    if local_cpu_profile not in (None, "observation"):
        raise RouteError("invalid_local_cpu_profile")
    if not prompt or len(prompt) > 10000:
        raise RouteError("invalid_prompt")
    if image is not None:
        if not image or len(image) > MAX_IMAGE_BYTES or not (
            image.startswith(b"\x89PNG\r\n\x1a\n") or image.startswith(b"\xff\xd8\xff")
        ):
            raise RouteError("invalid_image")
    schema = _observation_schema(json_schema) if json_schema is not None else None
    if schema is not None and image is not None:
        raise RouteError("invalid_json_schema")
    if route.protocol == "openai_compatible":
        content: str | list = prompt
        if image is not None:
            mime = "image/png" if image.startswith(b"\x89PNG") else "image/jpeg"
            content = [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {
                "url": f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}"}}]
        payload = {"model": route.model, "stream": False, "messages": [{"role": "user", "content": content}]}
        if schema is not None:
            payload["response_format"] = {"type": "json_schema", "json_schema": {
                "name": "openbutler_observation", "strict": True, "schema": schema}}
        if route.mode == "local" and local_cpu_profile == "observation":
            payload["max_tokens"] = LOCAL_IMAGE_OUTPUT_TOKENS if image is not None else LOCAL_TEXT_OUTPUT_TOKENS
            payload["temperature"] = 0
        return payload
    message = {"role": "user", "content": prompt}
    if image is not None:
        message["images"] = [base64.b64encode(image).decode("ascii")]
    payload = {"model": route.model, "stream": False, "think": route.thinking, "messages": [message]}
    if schema is not None:
        payload["format"] = schema
    if route.mode == "local" and local_cpu_profile == "observation":
        payload["options"] = {"num_ctx": LOCAL_MODEL_CONTEXT_TOKENS,
            "num_predict": LOCAL_IMAGE_OUTPUT_TOKENS if image is not None else LOCAL_TEXT_OUTPUT_TOKENS,
            "num_thread": min(LOCAL_MODEL_CPU_THREADS, max(1, os.cpu_count() or 1)), "temperature": 0}
    return payload


def _content(route: ModelRoute, response: dict, *, strict_text_response: bool = False) -> str:
    try:
        if route.protocol == "openai_compatible":
            choices = response["choices"]
            message = choices[0]["message"]
            if strict_text_response and (not isinstance(choices, list) or len(choices) != 1
                    or set(response) - {"id", "object", "created", "model", "choices", "usage",
                                        "system_fingerprint", "service_tier"}
                    or set(choices[0]) - {"index", "message", "finish_reason", "logprobs"}
                    or choices[0].get("finish_reason") != "stop"):
                raise ValueError
        else:
            message = response["message"]
            if strict_text_response and (response.get("done") is not True
                    or set(response) - {"model", "created_at", "message", "done", "done_reason",
                                        "total_duration", "load_duration", "prompt_eval_count",
                                        "prompt_eval_cached_count", "prompt_eval_duration", "eval_count", "eval_duration"}
                    or response.get("done_reason") != "stop"):
                raise ValueError
            # Ollama 0.35 reports this optional token counter. It is metadata,
            # never authorization or model content; reject malformed values.
            if strict_text_response and "prompt_eval_cached_count" in response:
                cached = response["prompt_eval_cached_count"]
                if type(cached) is not int or not 0 <= cached <= 2**63 - 1:
                    raise ValueError
        if strict_text_response:
            # The runtime accepts only visible text. Never silently accept a
            # reasoning/tool/refusal channel alongside an otherwise valid plan.
            if not isinstance(message, dict) or set(message) - {"role", "content"}:
                raise ValueError
            if message.get("role", "assistant") != "assistant":
                raise ValueError
        value = message["content"]
        if not isinstance(value, str) or not value.strip():
            raise ValueError
        if strict_text_response and len(value) > 4096:
            raise ValueError
        return value.strip()
    except (KeyError, IndexError, TypeError, ValueError):
        raise RouteError("invalid_provider_response") from None


class Gateway:
    def __init__(self, guard: Guard, transport: Transport | None = None, *,
                 privacy_mode_getter=None, dispatch_lock=None):
        self._guard = guard
        self._transport = transport or HttpTransport()
        self._privacy_mode_getter = privacy_mode_getter
        self._dispatch_lock = dispatch_lock if dispatch_lock is not None else RLock()
        self._configuration: tuple[int, dict[Kind, ModelRoute]] = (0, {})
        self._configuration_lock = Lock()
        self._last_attempt: Literal["never", "passed", "failed"] = "never"
        self._error_code: str | None = None

    @property
    def configuration_revision(self) -> int:
        """Opaque active-pair revision; exposes no route or credential details."""
        return self._configuration[0]

    @property
    def _routes(self) -> dict[Kind, ModelRoute]:
        return self._configuration[1]

    def status(self) -> RouteStatus:
        image, text = self._routes.get("image"), self._routes.get("text")
        return RouteStatus(bool(image and text), bool(image), bool(text), self._last_attempt,
                           self._error_code, image.protocol if image else None,
                           text.protocol if text else None, image.mode if image else None,
                           text.mode if text else None, bool(image and image.api_key),
                           bool(text and text.api_key),
                           self._transport.local_total_timeout if isinstance(self._transport, HttpTransport) else None,
                           self._transport.total_timeout if isinstance(self._transport, HttpTransport) else None)

    @property
    def text_ready(self) -> bool:
        """Text-only readiness; existing paired status.ready semantics stay intact."""
        return "text" in self._routes

    def _call(self, route: ModelRoute, auth: CallAuthorization, prompt: str, image: bytes | None,
              *, runtime: bool = False, dispatch_precondition: Callable[[], None] | None = None,
              strict_text_response: bool = False, json_schema: dict | None = None,
              cancel_event: Event | None = None,
              local_cpu_profile: Literal["observation"] | None = None) -> str:
        payload = _payload(route, prompt, image, json_schema=json_schema, local_cpu_profile=local_cpu_profile)
        strict_text_response = strict_text_response or json_schema is not None or local_cpu_profile == "observation"

        def privacy_request():
            mode = auth.privacy_mode
            if runtime and self._privacy_mode_getter is not None:
                current = self._privacy_mode_getter()
                if current not in ("strict", "basic"):
                    raise PermissionError("privacy_mode_unavailable")
                # A newer strict policy can tighten a frozen authorization, but
                # a newer basic policy cannot loosen a caller's strict snapshot.
                mode = "strict" if "strict" in (mode, current) else "basic"
            return PrivacyRequest(action="model_local" if route.mode == "local" else "model_external",
                                  mode=mode, authorized=auth.authorized, redacted=auth.redacted)

        # The app shares this lock with privacy-mode mutation. A mode switch is
        # effective when it commits; already-dispatched calls finish
        # before that commit, and later calls cannot use stale basic authorization.
        # Synthetic route probes retain their explicit proposed authorization.
        with self._dispatch_lock:
            if cancel_event is not None and cancel_event.is_set():
                raise PermissionError("authorization_revoked")
            if dispatch_precondition is not None:
                dispatch_precondition()
            request = privacy_request()
            self._guard.require(request)
            latest = privacy_request()
            if latest != request:
                self._guard.require(latest)
            if dispatch_precondition is not None:
                dispatch_precondition()
            if cancel_event is not None and cancel_event.is_set():
                raise PermissionError("authorization_revoked")
            # Legacy synthetic transports keep their two-argument interface
            # unless a caller explicitly requires physical cancellation.
            response = (self._transport.post(route, payload, cancel_event=cancel_event)
                        if cancel_event is not None else self._transport.post(route, payload))
            if cancel_event is not None and cancel_event.is_set():
                raise PermissionError("authorization_revoked")
            if dispatch_precondition is not None:
                dispatch_precondition()
            return _content(route, response, strict_text_response=strict_text_response)

    def validate_route(self, *, target: Kind, route: ModelRoute,
                       auth: CallAuthorization, strict_text_response: bool = False) -> None:
        if target == "image":
            result = self._call(route, auth, "Read the large printed text in this image.",
                                synthetic_probe_png())
            if "".join(ch for ch in result.upper() if ch.isalnum()) != "TEST42":
                raise RouteError("image_probe_failed")
        else:
            result = self._call(route, auth, "Reply with the word READY.", None,
                                strict_text_response=strict_text_response)
            if result.upper().strip(" .!\n") != "READY":
                raise RouteError("text_probe_failed")

    def configure(self, *, image: ModelRoute, text: ModelRoute, auth: CallAuthorization) -> None:
        """Prove both proposed routes before publishing either one."""
        with self._dispatch_lock:
            try:
                self.validate_route(target="image", route=image, auth=auth)
                self.validate_route(target="text", route=text, auth=auth)
            except Exception as exc:
                self._last_attempt = "failed"
                allowed_codes = {"invalid_prompt", "invalid_image", "provider_http_error",
                                 "provider_response_too_large", "invalid_provider_response",
                                 "provider_connection_failed", "unsafe_endpoint",
                                 "endpoint_resolution_failed", "image_probe_failed", "text_probe_failed",
                                 "authorization_required", "strict_mode_forbidden",
                                 "redaction_required", "privacy_audit_unavailable"}
                code = exc.args[0] if isinstance(exc, (RouteError, PermissionError)) and exc.args else None
                self._error_code = code if code in allowed_codes else "probe_failed"
                raise
            with self._configuration_lock:
                # Pair and revision publish together, including concurrent configure
                # callers; a failed probe never changes the active revision.
                self._configuration = (self.configuration_revision + 1, {"image": image, "text": text})
            self._last_attempt = "passed"
            self._error_code = None

    def configure_text(self, *, text: ModelRoute, auth: CallAuthorization) -> int:
        """Explicit synthetic probe for a dedicated text-only Gateway.

        This never probes or replaces an image route. Existing configure() still
        publishes image/text pairs atomically and status.ready still means both.
        """
        with self._dispatch_lock:
            try:
                self.validate_route(target="text", route=text, auth=auth, strict_text_response=True)
            except Exception:
                self._last_attempt = "failed"
                self._error_code = "text_probe_failed"
                raise
            with self._configuration_lock:
                self._configuration = (self.configuration_revision + 1,
                                       {**self._routes, "text": text})
            self._last_attempt = "passed"
            self._error_code = None
            return self.configuration_revision

    def _restore_validated_text_route(self, text: ModelRoute) -> int:
        """Internal startup restore from trusted local runtime settings only.

        The owning runtime validates record provenance/schema and fixed scope.
        This makes no connectivity claim and performs no probe or network call.
        """
        if text.mode != "local" or text.api_key is not None or text.thinking:
            raise ValueError("invalid_restored_text_route")
        with self._dispatch_lock, self._configuration_lock:
            self._configuration = (self.configuration_revision + 1, {"text": text})
            return self.configuration_revision

    def _runtime_call(self, kind: Kind, prompt: str, auth: CallAuthorization,
                      image: bytes | None, expected_configuration_revision: int | None,
                      dispatch_precondition: Callable[[], None] | None,
                      strict_text_response: bool = False, json_schema: dict | None = None,
                      cancel_event: Event | None = None,
                      local_cpu_profile: Literal["observation"] | None = None) -> str:
        with self._dispatch_lock:
            if (expected_configuration_revision is not None
                    and expected_configuration_revision != self.configuration_revision):
                raise PermissionError("authorization_revoked")
            route = self._routes.get(kind)
            if route is None:
                raise RouteError("route_not_ready")
            return self._call(route, auth, prompt, image, runtime=True,
                              dispatch_precondition=dispatch_precondition,
                              strict_text_response=strict_text_response,
                              json_schema=json_schema, cancel_event=cancel_event, local_cpu_profile=local_cpu_profile)

    def call_text(self, prompt: str, auth: CallAuthorization, *,
                  expected_configuration_revision: int | None = None,
                  dispatch_precondition: Callable[[], None] | None = None,
                  strict_text_response: bool = False, json_schema: dict | None = None,
                  cancel_event: Event | None = None,
                  local_cpu_profile: Literal["observation"] | None = None) -> str:
        return self._runtime_call("text", prompt, auth, None, expected_configuration_revision,
                                  dispatch_precondition, strict_text_response, json_schema, cancel_event, local_cpu_profile)

    def call_image(self, prompt: str, image: bytes, auth: CallAuthorization, *,
                   expected_configuration_revision: int | None = None,
                   dispatch_precondition: Callable[[], None] | None = None,
                   strict_text_response: bool = False, cancel_event: Event | None = None,
                   local_cpu_profile: Literal["observation"] | None = None) -> str:
        return self._runtime_call("image", prompt, auth, image, expected_configuration_revision,
                                  dispatch_precondition, strict_text_response, cancel_event=cancel_event,
                                  local_cpu_profile=local_cpu_profile)
