from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageStat


class LocalEyesUnavailable(RuntimeError):
    pass


class LocalEyesAdapter:
    """Adapter around the separately developed local eyes skill.

    This class deliberately avoids implementing camera drivers. It calls an
    optional local eyes HTTP service when configured, otherwise it provides a
    deterministic mock mode for local development and CI.
    """

    def __init__(self, base_url: str | None = None, use_mock: bool | None = None) -> None:
        self.base_url = (base_url or os.getenv("OPENBUTLER_LOCAL_EYES_URL", "")).rstrip("/")
        self.skill_script = Path(
            os.getenv(
                "OPENBUTLER_CAMERA_EYE_SCRIPT",
                r"C:\Users\admin\.codex\skills\camera-eye\scripts\camera_eye.ps1",
            )
        )
        self.capture_dir = Path(
            os.getenv(
                "OPENBUTLER_VISION_CAPTURE_DIR",
                str(Path(__file__).resolve().parents[2] / "data" / "vision_runtime"),
            )
        )
        if use_mock is None:
            use_mock = os.getenv("OPENBUTLER_VISION_MOCK", os.getenv("OPENBUTLER_WORKSTATION_VISION_MOCK", "0")) == "1"
        self.use_mock = use_mock

    def status(self) -> dict[str, Any]:
        if self.base_url:
            try:
                return self._request("GET", "/status")
            except LocalEyesUnavailable as exc:
                return {"available": False, "mode": "local-eyes-http", "error": str(exc)}
        if self.use_mock:
            return {"available": True, "mode": "mock", "error": None}
        if self.skill_script.exists():
            return {"available": True, "mode": "camera-eye-skill", "script": str(self.skill_script)}
        return {
            "available": self.use_mock,
            "mode": "mock" if self.use_mock else "unavailable",
            "error": None if self.use_mock else "camera-eye skill was not found.",
        }

    def list_cameras(self) -> list[dict[str, Any]]:
        if self.base_url:
            result = self._request("GET", "/cameras")
            return result.get("items", result if isinstance(result, list) else [])
        if self.use_mock:
            return [
                {
                    "id": "usb-camera-0",
                    "name": "Mock USB Camera 0",
                    "source": "local_eyes_mock",
                    "capabilities": ["capture_frame", "analyze_frame"],
                }
            ]
        if self.skill_script.exists():
            result = self._invoke_camera_eye(["-Action", "list", "-Backend", "auto"])
            return normalize_camera_eye_list(result)
        if not self.use_mock:
            raise LocalEyesUnavailable("Local eyes skill is not configured and mock mode is disabled.")
        return [
            {
                "id": "usb-camera-0",
                "name": "Mock USB Camera 0",
                "source": "local_eyes_mock",
                "capabilities": ["capture_frame", "analyze_frame"],
            }
        ]

    def start_camera(self, camera_id: str) -> dict[str, Any]:
        if self.base_url:
            return self._request("POST", "/camera/start", {"camera_id": camera_id})
        if self.use_mock:
            return {"camera_id": camera_id, "status": "running", "source": "local_eyes_mock"}
        if self.skill_script.exists():
            return {"camera_id": camera_id, "status": "ready", "source": "camera-eye-skill"}
        if not self.use_mock:
            raise LocalEyesUnavailable("Cannot start camera because local eyes skill is unavailable.")
        return {"camera_id": camera_id, "status": "running", "source": "local_eyes_mock"}

    def stop_camera(self, camera_id: str) -> dict[str, Any]:
        if self.base_url:
            return self._request("POST", "/camera/stop", {"camera_id": camera_id})
        if self.use_mock:
            return {"camera_id": camera_id, "status": "stopped", "source": "local_eyes_mock"}
        if self.skill_script.exists():
            return {"camera_id": camera_id, "status": "stopped", "source": "camera-eye-skill"}
        return {"camera_id": camera_id, "status": "stopped", "source": "local_eyes_mock"}

    def analyze_frame(self, camera_id: str, tasks: list[str], keep_raw_frame: bool = False) -> dict[str, Any]:
        if self.base_url:
            return self._request(
                "POST",
                "/frame/analyze",
                {"camera_id": camera_id, "tasks": tasks},
            )
        if self.use_mock:
            return mock_frame_metadata(camera_id)
        if self.skill_script.exists():
            capture = self.capture_frame(camera_id)
            image_path = Path(capture["image_path"])
            metadata = analyze_snapshot(image_path)
            metadata.update(
                {
                    "camera_id": camera_id,
                    "timestamp": capture.get("timestamp") or datetime.now(timezone.utc).isoformat(),
                    "capture": capture,
                    "local_eyes_source": "camera-eye-skill",
                    "raw_frame_ref": str(image_path) if keep_raw_frame else None,
                }
            )
            if not keep_raw_frame:
                try:
                    image_path.unlink(missing_ok=True)
                except OSError:
                    metadata["raw_frame_delete_warning"] = str(image_path)
            return metadata
        raise LocalEyesUnavailable("Cannot analyze frame because local eyes skill is unavailable.")

    def capture_frame(self, camera_id: str) -> dict[str, Any]:
        self.capture_dir.mkdir(parents=True, exist_ok=True)
        args = ["-Action", "capture", "-Out", str(self.capture_dir)]
        args.extend(camera_id_to_camera_eye_args(camera_id))
        result = self._invoke_camera_eye(args)
        if result.get("status") != "ok" or not result.get("image_path"):
            raise LocalEyesUnavailable(result.get("message", "camera-eye capture failed"))
        return result

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise LocalEyesUnavailable(f"Local eyes skill request failed: {exc}") from exc

    def _invoke_camera_eye(self, args: list[str]) -> dict[str, Any]:
        command = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.skill_script),
            *args,
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise LocalEyesUnavailable(f"camera-eye invocation failed: {exc}") from exc
        raw = (completed.stdout or completed.stderr).strip()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LocalEyesUnavailable(f"camera-eye returned non-JSON output: {raw[:300]}") from exc
        if completed.returncode != 0 or payload.get("status") == "error":
            raise LocalEyesUnavailable(payload.get("message", f"camera-eye failed with code {completed.returncode}"))
        return payload


def camera_id_to_camera_eye_args(camera_id: str) -> list[str]:
    if camera_id.startswith("opencv:"):
        return ["-Backend", "opencv", "-Index", camera_id.split(":", 1)[1]]
    if camera_id.startswith("dshow:"):
        return ["-Backend", "dshow", "-DeviceName", camera_id.split(":", 1)[1]]
    if camera_id.startswith("winrt:"):
        _, encoded = camera_id.split(":", 1)
        group_name, _, source_kind = encoded.partition("|")
        args = ["-Backend", "winrt", "-GroupName", group_name]
        if source_kind:
            args.extend(["-SourceKind", source_kind])
        return args
    if camera_id.startswith("esp-eye:"):
        return ["-Backend", "esp-eye", "-Port", camera_id.split(":", 1)[1]]
    if camera_id == "usb-camera-0":
        return ["-Backend", "opencv", "-Index", "0"]
    return ["-Backend", "auto"]


def normalize_camera_eye_list(result: dict[str, Any]) -> list[dict[str, Any]]:
    cameras: list[dict[str, Any]] = []
    for backend_result in result.get("results", []):
        if not backend_result.get("ok"):
            continue
        backend = backend_result.get("backend")
        payload = backend_result.get("payload") or {}
        if backend == "opencv":
            for device in payload.get("devices", []):
                if device.get("opened") and device.get("frame_ok"):
                    index = device.get("index", 0)
                    cameras.append(
                        {
                            "id": f"opencv:{index}",
                            "name": f"OpenCV Camera {index}",
                            "source": "camera-eye",
                            "backend": "opencv",
                            "width": device.get("width"),
                            "height": device.get("height"),
                        }
                    )
        elif backend == "dshow":
            for device in payload.get("devices", []):
                name = device.get("name")
                if name:
                    cameras.append(
                        {
                            "id": f"dshow:{name}",
                            "name": name,
                            "source": "camera-eye",
                            "backend": "dshow",
                        }
                    )
        elif backend == "winrt":
            for group in payload.get("groups", []):
                group_name = group.get("display_name")
                for source in group.get("sources", []):
                    kind = source.get("source_kind", "Color")
                    cameras.append(
                        {
                            "id": f"winrt:{group_name}|{kind}",
                            "name": f"{group_name} ({kind})",
                            "source": "camera-eye",
                            "backend": "winrt",
                            "source_kind": kind,
                        }
                    )
    return cameras


def mock_frame_metadata(camera_id: str = "usb-camera-0") -> dict[str, Any]:
    return {
        "camera_id": camera_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "face_detected": True,
        "body_detected": True,
        "person_count": 1,
        "head_pose": {"yaw": 4, "pitch": -8, "roll": 1},
        "pose": {"sitting_probability": 0.86, "standing_probability": 0.08},
        "objects": [
            {"label": "laptop", "confidence": 0.91},
            {"label": "phone", "confidence": 0.64},
        ],
        "lighting": {"brightness": 0.42, "lux_proxy": 0.42},
        "movement_score": 0.38,
        "local_eyes_source": "mock",
    }


def analyze_snapshot(image_path: Path) -> dict[str, Any]:
    with Image.open(image_path) as image:
        rgb = image.convert("RGB")
        grayscale = rgb.convert("L")
        stat = ImageStat.Stat(grayscale)
        brightness = stat.mean[0] / 255
        contrast = stat.stddev[0] / 128
        width, height = rgb.size
        center = grayscale.crop((width * 0.25, height * 0.18, width * 0.75, height * 0.92))
        center_stat = ImageStat.Stat(center)
        center_brightness = center_stat.mean[0] / 255
        center_contrast = center_stat.stddev[0] / 128
        entropy = min(grayscale.entropy() / 8, 1.0)

    image_quality = "ok"
    if brightness < 0.12:
        image_quality = "too_dark"
    elif contrast < 0.05:
        image_quality = "low_detail"

    presence_score = clamp01(0.15 + center_contrast * 0.55 + entropy * 0.25 + min(center_brightness, 0.8) * 0.15)
    face_or_body_detected = image_quality == "ok" and presence_score >= 0.42
    looking_down_proxy = center_brightness < brightness * 0.82 and center_contrast > 0.18
    phone_proxy = center_contrast > 0.28 and entropy > 0.62
    movement_score = clamp01(contrast * 0.7 + entropy * 0.3)
    return {
        "face_detected": face_or_body_detected,
        "body_detected": face_or_body_detected,
        "person_count": 1 if face_or_body_detected else 0,
        "head_pose": {
            "yaw": 0,
            "pitch": -22 if looking_down_proxy else -6,
            "roll": 0,
            "method": "image_heuristic_not_eye_tracking",
        },
        "pose": {
            "sitting_probability": 0.72 if face_or_body_detected else 0.2,
            "standing_probability": 0.18 if face_or_body_detected else 0.05,
        },
        "objects": [
            {"label": "laptop", "confidence": 0.56 if face_or_body_detected else 0.25},
            {"label": "phone", "confidence": 0.62 if phone_proxy else 0.18},
        ],
        "lighting": {
            "brightness": round(brightness, 3),
            "lux_proxy": round(brightness, 3),
            "image_quality": image_quality,
        },
        "movement_score": round(movement_score, 3),
        "image_metrics": {
            "brightness": round(brightness, 3),
            "center_brightness": round(center_brightness, 3),
            "contrast": round(contrast, 3),
            "center_contrast": round(center_contrast, 3),
            "entropy": round(entropy, 3),
            "presence_score": round(presence_score, 3),
        },
        "analysis_method": "camera_eye_snapshot_pil_heuristics",
    }


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))
