from __future__ import annotations

import os
import unittest
from pathlib import Path
from uuid import uuid4

import app.main as main


class DesktopStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_data_dir = main.DATA_DIR
        self.original_db_path = main.DB_PATH
        self.original_env = {
            key: os.environ.get(key)
            for key in (
                "OPENBUTLER_DESKTOP",
                "OPENBUTLER_DISABLE_SEED_EVENTS",
                "OPENBUTLER_DEFAULT_PRIVACY_MODE",
                "OPENBUTLER_COPY_SCREENSHOTS",
                "OPENBUTLER_EXTERNAL_MODEL_ALLOWED",
                "OPENBUTLER_EXTERNAL_WEBHOOK_ALLOWED",
                "MINECONTEXT_HOME",
                "OPENBUTLER_MINECONTEXT_HOME",
            )
        }
        self.tmp = Path(__file__).resolve().parents[5] / "data" / "test_tmp" / uuid4().hex
        self.tmp.mkdir(parents=True, exist_ok=True)
        main.DATA_DIR = self.tmp
        main.DB_PATH = self.tmp / "openbutler.sqlite3"
        os.environ["OPENBUTLER_DESKTOP"] = "1"
        os.environ["OPENBUTLER_DISABLE_SEED_EVENTS"] = "1"
        os.environ["OPENBUTLER_DEFAULT_PRIVACY_MODE"] = "strict"
        os.environ["MINECONTEXT_HOME"] = "C:\\Users\\admin\\AppData\\Local\\MineContext"
        main.init_db()

    def tearDown(self) -> None:
        main.DATA_DIR = self.original_data_dir
        main.DB_PATH = self.original_db_path
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_desktop_status_is_loopback_strict_and_redacted(self) -> None:
        payload = main.desktop_status()
        text = str(payload)

        self.assertTrue(payload["desktop"]["available"])
        self.assertEqual(payload["service"]["host"], "127.0.0.1")
        self.assertEqual(payload["service"]["privacy_mode"], "strict")
        self.assertTrue(payload["privacy"]["seed_events_disabled"])
        self.assertFalse(payload["privacy"]["copy_screenshots"])
        self.assertFalse(payload["privacy"]["external_model_allowed"])
        self.assertFalse(payload["privacy"]["external_webhook_allowed"])
        self.assertTrue(payload["data_sources"]["minecontext"]["read_only"])
        self.assertTrue(payload["data_sources"]["minecontext"]["configured"])
        self.assertFalse(payload["safety"]["raw_activity_titles_returned"])
        self.assertFalse(payload["safety"]["screenshot_paths_returned"])
        self.assertFalse(payload["safety"]["local_paths_returned"])
        self.assertNotIn("AppData", text)
        self.assertNotIn("MineContext\\", text)
        self.assertNotIn("C:\\", text)
        self.assertNotIn("\\screenshots\\", text.lower())


if __name__ == "__main__":
    unittest.main()
