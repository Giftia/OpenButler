from __future__ import annotations

import unittest
from datetime import datetime, timezone
from itertools import product
from typing import get_args
from unittest.mock import MagicMock, Mock, call, patch

from pydantic import ValidationError

from app.modules.pc_activity_context.schemas import PCActivitySettings
from app.modules.pc_activity_context.service import PCActivityContextService
from app.modules.workstation_vision.schemas import StartSessionRequest, WorkstationVisionSettings
from app.modules.workstation_vision.service import WorkstationVisionService
from app.security.privacy_compat import restrict_legacy_setting
from app.security.privacy_guard import (
    PrivacyAction,
    PrivacyDecision,
    PrivacyGuard,
    PrivacyMode,
    PrivacyReasonCode,
    PrivacyRequest,
)


ACTIONS = (
    "capture", "screenshot_copy", "model_local", "model_external", "webhook",
    "migration", "retention", "external_write", "source_mutation",
)
FLAGS = ("authorized", "redacted", "source_read_only", "target_owned", "paused")
STRICT_BLOCKED = {"model_external", "webhook", "screenshot_copy", "external_write"}


class PrivacyGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.guard = PrivacyGuard()

    def test_request_contract_and_defaults(self) -> None:
        self.assertEqual(set(get_args(PrivacyAction)), set(ACTIONS))
        self.assertEqual(set(get_args(PrivacyMode)), {"strict", "basic"})
        self.assertEqual(set(PrivacyRequest.model_fields), {"action", "mode", *FLAGS})
        for action, mode in product(ACTIONS, get_args(PrivacyMode)):
            with self.subTest(action=action, mode=mode):
                request = PrivacyRequest(action=action, mode=mode)
                self.assertEqual(request.model_dump(), {
                    "action": action, "mode": mode, "authorized": False,
                    "redacted": False, "source_read_only": True,
                    "target_owned": False, "paused": False,
                })
                self.assertFalse(self.guard.evaluate(request).allowed)

    def test_request_rejects_extra_fields_and_invalid_enums(self) -> None:
        for changes in (
            {"payload": {"text": "PRIVATE_SENTINEL"}},
            {"path": "PRIVATE_SENTINEL"}, {"callback": Mock()},
            {"action": "external_model"}, {"action": "PRIVATE_SENTINEL"},
            {"mode": "STRICT"}, {"mode": "PRIVATE_SENTINEL"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                PrivacyRequest(**{"action": "capture", "mode": "strict", **changes})
        for values in ({}, {"action": "capture"}, {"mode": "strict"}):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                PrivacyRequest(**values)

    def test_flags_require_actual_booleans(self) -> None:
        for flag, value in product(FLAGS, (0, 1, "true", "false", "yes", None, [], {})):
            with self.subTest(flag=flag, value=value), self.assertRaises(ValidationError):
                PrivacyRequest(action="capture", mode="strict", **{flag: value})

    def test_request_and_decision_are_frozen(self) -> None:
        request = PrivacyRequest(action="capture", mode="strict")
        decision = self.guard.evaluate(request)
        for model in (request, decision):
            for field in type(model).model_fields:
                with self.subTest(model=type(model).__name__, field=field):
                    with self.assertRaises(ValidationError):
                        setattr(model, field, getattr(model, field))

    def test_unvalidated_copies_cannot_bypass_guard(self) -> None:
        request = PrivacyRequest(action="capture", mode="strict")
        for values in (
            {"action": "PRIVATE_SENTINEL"}, {"mode": "PRIVATE_SENTINEL"},
            {"authorized": "yes"}, {"authorized": 1}, {"payload": "PRIVATE_SENTINEL"},
        ):
            tampered = request.model_copy(update=values)
            for operation in (self.guard.evaluate, self.guard.require):
                with self.subTest(values=values, operation=operation.__name__):
                    with self.assertRaises(ValidationError):
                        operation(tampered)

    def test_decision_contains_only_fixed_enums_and_boolean(self) -> None:
        values = dict(action="capture", allowed=False, reason_code="authorization_required", mode="strict")
        decision = PrivacyDecision(**values)
        self.assertEqual(decision.model_dump(), values)
        self.assertEqual(set(PrivacyDecision.model_fields), {"action", "allowed", "reason_code", "mode"})
        for changes in (
            {"payload": "PRIVATE_SENTINEL"}, {"action": "PRIVATE_SENTINEL"},
            {"reason_code": "PRIVATE_SENTINEL"}, {"mode": "PRIVATE_SENTINEL"},
            {"allowed": "true"}, {"allowed": 1},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                PrivacyDecision(**{**values, **changes})

    def test_full_policy_matrix_and_denied_callbacks(self) -> None:
        counts = {True: 0, False: 0}
        for action, mode, flags in product(ACTIONS, ("strict", "basic"), product((False, True), repeat=5)):
            authorized, redacted, source_read_only, target_owned, paused = flags
            violations = (
                (action == "source_mutation", "source_mutation_forbidden"),
                (mode == "strict" and action in STRICT_BLOCKED, "strict_mode_forbidden"),
                (not authorized, "authorization_required"),
                (action == "capture" and paused, "capture_paused"),
                (action == "migration" and not source_read_only, "source_not_read_only"),
                (action in {"migration", "retention"} and not target_owned, "target_not_owned"),
                (action in {"model_external", "webhook"} and not redacted, "redaction_required"),
            )
            reason = next((code for denied, code in violations if denied), "allowed")
            request = PrivacyRequest(action=action, mode=mode, **dict(zip(FLAGS, flags)))
            callback = Mock()
            with self.subTest(request=request):
                before = request.model_dump()
                decision = self.guard.evaluate(request)
                self.assertEqual(decision.model_dump(), {
                    "action": action, "allowed": reason == "allowed",
                    "reason_code": reason, "mode": mode,
                })
                self.assertIn(decision.reason_code, get_args(PrivacyReasonCode))
                self.assertEqual(self.guard.evaluate(request), decision)
                if decision.allowed:
                    self.assertEqual(self.guard.require(request), decision)
                    callback()
                    callback.assert_called_once_with()
                else:
                    with self.assertRaises(PermissionError) as raised:
                        self.guard.require(request)
                        callback()
                    self.assertEqual(raised.exception.args, (reason,))
                    self.assertEqual(str(raised.exception), reason)
                    callback.assert_not_called()
                self.assertEqual(request.model_dump(), before)
                counts[decision.allowed] += 1
        self.assertEqual(counts, {True: 120, False: 456})


class PrivacyCompatibilityTests(unittest.TestCase):
    def test_compatibility_only_restricts_existing_settings(self) -> None:
        for action, mode, enabled in product(
            ("model_external", "screenshot_copy"), ("strict", "basic", "unknown"), (False, True),
        ):
            with self.subTest(action=action, mode=mode, enabled=enabled):
                self.assertEqual(
                    restrict_legacy_setting(action=action, mode=mode, enabled=enabled),
                    enabled and mode == "basic",
                )
        for action in set(ACTIONS) - {"model_external", "screenshot_copy"}:
            with self.subTest(action=action), self.assertRaises(ValueError):
                restrict_legacy_setting(action=action, mode="basic", enabled=True)

    def test_compatibility_does_not_fabricate_authorization_or_redaction(self) -> None:
        with patch.object(PrivacyGuard, "evaluate", wraps=PrivacyGuard().evaluate) as evaluate:
            self.assertFalse(restrict_legacy_setting(action="model_external", mode="strict", enabled=True))
            request = evaluate.call_args.args[0]
            self.assertFalse(request.authorized)
            self.assertFalse(request.redacted)
            self.assertEqual((request.action, request.mode), ("model_external", "strict"))
            evaluate.reset_mock()
            self.assertTrue(restrict_legacy_setting(action="model_external", mode="basic", enabled=True))
            evaluate.assert_not_called()

    def test_pc_settings_keep_strict_protection_and_basic_flags(self) -> None:
        service = PCActivityContextService("synthetic.sqlite3", "synthetic-runtime")
        for mode in ("strict", "basic"):
            with self.subTest(mode=mode), patch.object(service, "get_settings", return_value=PCActivitySettings()), \
                    patch.object(service, "connect", return_value=MagicMock()), \
                    patch.object(service, "adapter") as adapter, \
                    patch("app.modules.pc_activity_context.service.restrict_legacy_setting",
                          wraps=restrict_legacy_setting) as compat:
                settings = service.update_settings({
                    "privacy_mode": mode,
                    "minecontext": {"external_model_allowed": True, "copy_screenshot_evidence": True},
                })
                self.assertEqual(settings.minecontext.external_model_allowed, mode == "basic")
                self.assertEqual(settings.minecontext.copy_screenshot_evidence, mode == "basic")
                self.assertEqual(compat.call_args_list, [
                    call(action="model_external", mode=mode, enabled=True),
                    call(action="screenshot_copy", mode=mode, enabled=True),
                ])
                adapter.assert_not_called()

    def test_original_pc_strict_check_remains_independent(self) -> None:
        service = PCActivityContextService("synthetic.sqlite3", "synthetic-runtime")
        with patch.object(service, "get_settings", return_value=PCActivitySettings()), \
                patch.object(service, "connect", return_value=MagicMock()), \
                patch("app.modules.pc_activity_context.service.restrict_legacy_setting", return_value=True):
            settings = service.update_settings({
                "minecontext": {"external_model_allowed": True, "copy_screenshot_evidence": True},
            })
        self.assertFalse(settings.minecontext.external_model_allowed)
        self.assertFalse(settings.minecontext.copy_screenshot_evidence)

    def test_original_pc_preview_strict_check_remains_independent(self) -> None:
        service = PCActivityContextService("synthetic.sqlite3", "synthetic-runtime")
        when = datetime(2026, 1, 1, tzinfo=timezone.utc)
        with patch.object(service, "get_settings", return_value=PCActivitySettings()), \
                patch.object(service, "adapter") as adapter, \
                patch("app.modules.pc_activity_context.service.restrict_legacy_setting", return_value=True):
            adapter.return_value.export_recent_activities.return_value = []
            result = service.preview_import_activities(when, when, 10, copy_screenshots=True)
        self.assertFalse(result["copy_screenshots_effective"])

    def test_pc_preview_remains_non_mutating(self) -> None:
        service = PCActivityContextService("synthetic.sqlite3", "synthetic-runtime")
        when = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for mode in ("strict", "basic"):
            with self.subTest(mode=mode), \
                    patch.object(service, "get_settings", return_value=PCActivitySettings(privacy_mode=mode)), \
                    patch.object(service, "adapter") as adapter, patch.object(service, "connect") as connect:
                adapter.return_value.export_recent_activities.return_value = []
                result = service.preview_import_activities(when, when, 10, copy_screenshots=True)
                self.assertEqual(result["copy_screenshots_effective"], mode == "basic")
                for field in ("screenshots_copied", "mutates_openbutler_db", "minecontext_source_mutated",
                              "external_model_used", "external_webhook_used"):
                    self.assertFalse(result[field])
                connect.assert_not_called()
                self.assertEqual(adapter.return_value.mock_calls, [
                    call.export_recent_activities(when, when, 10),
                ])

    def test_vision_settings_keep_strict_protection_and_basic_flags(self) -> None:
        service = WorkstationVisionService("synthetic.sqlite3")
        for mode in ("strict", "basic"):
            with self.subTest(mode=mode), \
                    patch.object(service, "get_settings", return_value=WorkstationVisionSettings()), \
                    patch.object(service, "connect", return_value=MagicMock()), \
                    patch.object(service, "adapter") as adapter, \
                    patch("app.modules.workstation_vision.service.restrict_legacy_setting",
                          wraps=restrict_legacy_setting) as compat:
                settings = service.update_settings({"privacy_mode": mode, "save_raw_frames": True})
                self.assertEqual(settings.save_raw_frames, mode == "basic")
                compat.assert_called_once_with(action="screenshot_copy", mode=mode, enabled=True)
                adapter.assert_not_called()

    def test_vision_session_flags_use_compatibility_without_enabling_raw_saving(self) -> None:
        service = WorkstationVisionService("synthetic.sqlite3")
        for mode, enabled in product(("strict", "basic"), (False, True)):
            with self.subTest(mode=mode, enabled=enabled), \
                    patch.object(service, "connect", return_value=MagicMock()), \
                    patch.object(service, "adapter"), patch.object(service, "analyze_one_frame"), \
                    patch("app.modules.workstation_vision.service.restrict_legacy_setting",
                          wraps=restrict_legacy_setting) as compat:
                request = StartSessionRequest(privacy_mode=mode, save_raw_frames=enabled, user_confirmed=True)
                result = service.start_session(request)
                expected = enabled and mode == "basic"
                self.assertEqual(request.save_raw_frames, expected)
                self.assertEqual(result["raw_frame_retention"], "keep" if expected else "discard")
                compat.assert_called_once_with(action="screenshot_copy", mode=mode, enabled=enabled)

    def test_original_vision_strict_checks_remain_independent(self) -> None:
        service = WorkstationVisionService("synthetic.sqlite3")
        with patch.object(service, "get_settings", return_value=WorkstationVisionSettings()), \
                patch.object(service, "connect", return_value=MagicMock()), \
                patch.object(service, "adapter"), patch.object(service, "analyze_one_frame"), \
                patch("app.modules.workstation_vision.service.restrict_legacy_setting", return_value=True):
            settings = service.update_settings({"save_raw_frames": True})
            result = service.start_session(StartSessionRequest(save_raw_frames=True, user_confirmed=True))
        self.assertFalse(settings.save_raw_frames)
        self.assertEqual(result["raw_frame_retention"], "discard")

    def test_vision_without_confirmation_never_reaches_adapter(self) -> None:
        service = WorkstationVisionService("synthetic.sqlite3")
        with patch.object(service, "adapter") as adapter, patch.object(service, "connect") as connect:
            with self.assertRaises(ValueError):
                service.start_session(StartSessionRequest(user_confirmed=False))
            adapter.assert_not_called()
            connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
