import os
import tempfile
import unittest
from pathlib import Path

from app.integrations.minecontext.adapter import MineContextAdapter
from app.integrations.minecontext.config import MineContextSettings


class MineContextHealthPrivacyTests(unittest.TestCase):
    def test_health_status_redacts_local_paths(self) -> None:
        with tempfile.TemporaryDirectory() as runtime:
            settings = MineContextSettings(
                workspace_dir=str(Path(runtime) / "private-workspace"),
                data_dir=str(Path(runtime) / "private-data"),
            )
            health = MineContextAdapter(settings, runtime).health_check()

        self.assertEqual(health.workspace_dir, "configured")
        self.assertEqual(health.data_dir, "configured")
        self.assertNotIn(runtime, health.model_dump_json())

    def test_default_config_contains_no_committed_personal_workspace(self) -> None:
        previous = os.environ.pop("OPENBUTLER_MINECONTEXT_WORKSPACE", None)
        try:
            settings = MineContextSettings()
        finally:
            if previous is not None:
                os.environ["OPENBUTLER_MINECONTEXT_WORKSPACE"] = previous

        self.assertEqual(settings.workspace_dir, "")


if __name__ == "__main__":
    unittest.main()
