
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from ..config import Config
from .history_db import HistoryDB


def _now_s() -> float:
    return time.time()


@dataclass
class PolicyDecision:
    allowed: bool
    reason: str = ""
    requires_extra_confirm: bool = False


class PolicyGuard:
    """Guardrails for patch/command execution + safe mode."""

    SAFE_MODE_KEY = "policy.safe_mode"
    FAIL_STREAK_KEY = "policy.fail_streak"
    PATCH_COUNT_KEY = "policy.patch_count"
    COMMAND_COUNT_KEY = "policy.command_count"
    PATCH_WINDOW_KEY = "policy.patch_window"
    COMMAND_WINDOW_KEY = "policy.command_window"

    def __init__(self, db: HistoryDB) -> None:
        self.db = db

    def is_safe_mode(self) -> bool:
        return bool(self.db.get_state(self.SAFE_MODE_KEY, False))

    def enable_safe_mode(self, session_id: str, reason: str) -> None:
        self.db.set_state(self.SAFE_MODE_KEY, True)
        self.db.log_policy_event(session_id, "safe_mode_enabled", {"reason": reason})

    def disable_safe_mode(self, session_id: str) -> None:
        self.db.set_state(self.SAFE_MODE_KEY, False)
        self.db.set_state(self.FAIL_STREAK_KEY, 0)
        self.db.log_policy_event(session_id, "safe_mode_disabled", {})

    def record_success(self) -> None:
        self.db.set_state(self.FAIL_STREAK_KEY, 0)

    def record_failure(self, session_id: str, kind: str, detail: dict[str, Any]) -> None:
        streak = int(self.db.get_state(self.FAIL_STREAK_KEY, 0) or 0) + 1
        self.db.set_state(self.FAIL_STREAK_KEY, streak)
        self.db.log_policy_event(session_id, "action_failed", {"kind": kind, "streak": streak, **detail})
        if streak >= Config.POLICY_MAX_CONSECUTIVE_FAILURES:
            self.enable_safe_mode(session_id, f"too many consecutive failures ({streak})")

    def _rate_limit_check(self, window_key: str, limit_per_min: int) -> PolicyDecision:
        window = self.db.get_state(window_key, []) or []
        now = _now_s()
        window = [t for t in window if now - float(t) < 60.0]
        if len(window) >= limit_per_min:
            self.db.set_state(window_key, window)
            return PolicyDecision(False, f"rate limit exceeded ({limit_per_min}/min)")
        window.append(now)
        self.db.set_state(window_key, window)
        return PolicyDecision(True)

    def check_patch(self, session_id: str, patch_text: str) -> PolicyDecision:
        if self.is_safe_mode():
            return PolicyDecision(False, "safe mode is enabled (patching disabled)")

        # per-session count
        count = int(self.db.get_state(self.PATCH_COUNT_KEY, 0) or 0)
        if count >= Config.POLICY_MAX_PATCHES_PER_SESSION:
            self.enable_safe_mode(session_id, "max patches per session exceeded")
            return PolicyDecision(False, "max patches per session exceeded (safe mode enabled)")

        rl = self._rate_limit_check(self.PATCH_WINDOW_KEY, Config.POLICY_RATE_LIMIT_PATCHES_PER_MINUTE)
        if not rl.allowed:
            return rl

        requires = len(patch_text or "") >= Config.POLICY_LARGE_DIFF_CHAR_THRESHOLD
        self.db.set_state(self.PATCH_COUNT_KEY, count + 1)

        if requires:
            self.db.log_policy_event(session_id, "large_patch_requires_extra_confirm", {"chars": len(patch_text or "")})
        return PolicyDecision(True, requires_extra_confirm=requires)

    def check_command(self, command: str) -> PolicyDecision:
        if self.is_safe_mode():
            return PolicyDecision(False, "safe mode is enabled (commands disabled)")

        rl = self._rate_limit_check(self.COMMAND_WINDOW_KEY, Config.POLICY_RATE_LIMIT_COMMANDS_PER_MINUTE)
        if not rl.allowed:
            return rl

        count = int(self.db.get_state(self.COMMAND_COUNT_KEY, 0) or 0)
        self.db.set_state(self.COMMAND_COUNT_KEY, count + 1)
        return PolicyDecision(True)
