"""Private Windows RC policy: retain goals but do not run goal automation.

This is an application-composition boundary, not a user setting or environment
switch. The underlying kernel remains independently testable. There is no
schema migration, provenance inference, data deletion, or automatic resume.
"""
from .models import AuthorizationError
from .service import RuntimeService


class PrivateRcRuntimeService(RuntimeService):
    rc_goal_automation_unavailable = True

    @staticmethod
    def automation_blocked():
        return {"id": None, "status": "blocked", "reason": "private_rc_goal_automation_unavailable",
                "processed_wakes": 0, "executed_actions": 0}

    def run_once(self, max_wakes=10):
        return self.automation_blocked()

    def activate_goal(self, goal_id, expected_version):
        raise AuthorizationError("private_rc_goal_automation_unavailable")

    def set_enabled(self, enabled):
        if enabled is True:
            raise AuthorizationError("private_rc_goal_automation_unavailable")
        return super().set_enabled(enabled)

    def status(self):
        result = super().status()
        return {**result, "enabled": False, "next_wake_at": None,
                "blocked_reason": "private_rc_goal_automation_unavailable",
                "rc_goal_automation_unavailable": True,
                "conversation_goal_adoption_enabled": False, "natural_chat_enabled": False}

    def _goal_detail(self, connection, goal):
        result = super()._goal_detail(connection, goal)
        # No attempt to guess whether legacy content was manually authored or
        # derived from uncited conversation inputs. Only this read projection
        # is withheld; original rows, status, IDs and pause/cancel remain intact.
        return {**result, "title": "目标自动化暂不可用（数据已保留）", "target_id": "unavailable",
                "success_event_type": "unavailable", "success_value": None,
                "evidence_ids": [], "completion_evidence_ids": [], "wait_target": None,
                "checkpoint": None, "plan": None, "approval": None,
                "content_withheld": True, "evidence_unavailable": True,
                "verification_status": "unverified", "rc_goal_automation_unavailable": True}

    @staticmethod
    def _notice_projection(notice):
        return {**notice, "message": "目标自动化暂不可用，历史目标提醒暂不展示（数据已保留）。",
                "rc_goal_automation_unavailable": True}

    def list_inbox(self, limit=100):
        return [self._notice_projection(notice) for notice in super().list_inbox(limit)]

    def mark_notice_read(self, notice_id):
        return self._notice_projection(super().mark_notice_read(notice_id))
