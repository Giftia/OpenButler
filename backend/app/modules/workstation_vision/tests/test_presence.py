from __future__ import annotations

import unittest
import os
from datetime import datetime, timedelta, timezone

from app.integrations.local_eyes_adapter import LocalEyesAdapter, LocalEyesUnavailable
from app.modules.workstation_vision.detectors.presence import DebouncedPresence, detect_presence


class PresenceTests(unittest.TestCase):
    def test_detect_presence_present(self) -> None:
        result = detect_presence({"face_detected": True, "body_detected": True, "person_count": 1})
        self.assertEqual(result["state"], "present")
        self.assertGreaterEqual(result["confidence"], 0.9)

    def test_multiple_people_returns_unknown(self) -> None:
        result = detect_presence({"face_detected": True, "body_detected": True, "person_count": 2})
        self.assertEqual(result["state"], "unknown")
        self.assertIn("multiple_people", result["reason_codes"])

    def test_presence_debounce_filters_short_away(self) -> None:
        debounced = DebouncedPresence(state="present", debounce_seconds=15)
        start = datetime(2026, 5, 29, 9, 0, tzinfo=timezone.utc)
        state, changed = debounced.update("away", start)
        self.assertEqual(state, "present")
        self.assertFalse(changed)
        state, changed = debounced.update("away", start + timedelta(seconds=10))
        self.assertEqual(state, "present")
        self.assertFalse(changed)
        state, changed = debounced.update("away", start + timedelta(seconds=16))
        self.assertEqual(state, "away")
        self.assertTrue(changed)

    def test_local_eyes_unavailable_is_clear(self) -> None:
        os.environ.pop("OPENBUTLER_VISION_MOCK", None)
        adapter = LocalEyesAdapter(base_url="", use_mock=False)
        adapter.skill_script = adapter.skill_script.parent / "missing-camera-eye.ps1"
        with self.assertRaises(LocalEyesUnavailable):
            adapter.list_cameras()


if __name__ == "__main__":
    unittest.main()
