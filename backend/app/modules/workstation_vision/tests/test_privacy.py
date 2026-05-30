from __future__ import annotations

import sqlite3
import unittest
import uuid
import os
from pathlib import Path

from app.modules.workstation_vision.schemas import StartSessionRequest
from app.modules.workstation_vision.service import WorkstationVisionService, init_workstation_vision_db


def make_service() -> WorkstationVisionService:
    os.environ["OPENBUTLER_VISION_MOCK"] = "1"
    root = Path("backend/data/test_tmp")
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{uuid.uuid4().hex}.sqlite3"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    init_workstation_vision_db(conn)
    conn.commit()
    conn.close()
    return WorkstationVisionService(path)


class PrivacyAndSessionTests(unittest.TestCase):
    def test_strict_mode_forces_raw_frame_discard(self) -> None:
        service = make_service()
        response = service.start_session(
            StartSessionRequest(
                camera_id="usb-camera-0",
                privacy_mode="strict",
                save_raw_frames=True,
                user_confirmed=True,
            )
        )
        self.assertEqual(response["raw_frame_retention"], "discard")
        events = service.events()
        self.assertTrue(events)
        self.assertTrue(all(event["raw_frame_ref"] is None for event in events))

    def test_start_and_stop_session(self) -> None:
        service = make_service()
        started = service.start_session(StartSessionRequest(user_confirmed=True))
        self.assertEqual(started["status"], "running")
        stopped = service.stop_session(started["session_id"])
        self.assertEqual(stopped["status"], "stopped")


if __name__ == "__main__":
    unittest.main()
