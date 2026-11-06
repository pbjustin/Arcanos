"""
Memory Schema for ARCANOS
JSON-based persistent storage for conversations and user preferences.
"""

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Optional, Union, Dict, List
from datetime import datetime
from .config import Config

JsonValue = Union[str, int, float, bool, None, List["JsonValue"], Dict[str, "JsonValue"]]


class Memory:
    """Manages persistent conversation memory"""

    def __init__(self, file_path: Optional[Path] = None):
        self.file_path = file_path or Config.MEMORY_FILE
        self.data = self._load()
        self._recovery_db = None
        self._recovery_profile_matches = (
            file_path is None or self.file_path.resolve() == Config.MEMORY_FILE.resolve()
            or self.file_path.parent.resolve() == Config.HISTORY_DB_PATH.parent.resolve()
        )

    def _recovery_history(self, create: bool = False):
        """Lazily attach existing approved history independently of job monitoring.

        A read-only schema probe keeps JSON-only callers from creating SQLite
        state. Custom memory files must belong to the configured history profile
        before ordinary getters consult it; an explicit recovery write binds it.
        """
        if self._recovery_db is not None:
            return self._recovery_db
        if not create:
            if not self._recovery_profile_matches or not Config.HISTORY_DB_PATH.is_file():
                return None
            uri = Config.HISTORY_DB_PATH.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True, timeout=0.25)) as connection:
                table = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_deliveries'"
                ).fetchone()
            if table is None:
                return None
        from .agentic.history_db import HistoryDB
        self._recovery_db = HistoryDB(Config.HISTORY_DB_PATH, recovery=True)
        return self._recovery_db

    def record_recovered_conversation(
        self, delivery_id: str, session_id: str, user: str, response: str,
        tokens: int, cost: float,
    ) -> bool:
        """Commit approved same-job history, accounting, and audit once without JSON mirroring."""
        return self._recovery_history(create=True).record_recovered_conversation(
            delivery_id, session_id, user, response, tokens, cost
        )

    def get_recovered_conversation(self, delivery_id: str) -> Optional[dict[str, Any]]:
        """Read a previously committed answer and its terminal-delivery receipts."""
        db = self._recovery_history()
        return db.get_recovered_conversation(delivery_id) if db else None

    def mark_recovered_displayed(self, delivery_id: str) -> None:
        """Persist successful terminal output after the approved answer was displayed."""
        from .agentic.history_db import RecoveredConversationStorageError
        db = self._recovery_history()
        if db is None:
            raise RecoveredConversationStorageError("Completed conversation receipt is unavailable.")
        db.mark_recovered_displayed(delivery_id)

    def claim_recovered_audit(self, delivery_id: str) -> bool:
        """Claim one console completion event while keeping the durable SQL audit intact."""
        db = self._recovery_history()
        return db.claim_recovered_audit(delivery_id) if db else False

    def get_recovered_usage(self) -> list[dict[str, Any]]:
        """Load recent authoritative usage once at recovery startup, without creating state."""
        db = self._recovery_history()
        return db.get_recovered_usage() if db else []

    def _load(self) -> dict[str, Any]:
        """Load memory from file"""
        if self.file_path.exists():
            try:
                with open(self.file_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return self._default_data()
        return self._default_data()

    def _default_data(self) -> dict[str, Any]:
        """Create default memory structure"""
        return {
            "version": "1.0",
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
            "user": {
                "name": None,
                "preferences": {}
            },
            "conversations": [],
            "statistics": {
                "total_requests": 0,
                "total_tokens": 0,
                "total_cost": 0.0,
                "vision_requests": 0,
                "voice_requests": 0,
                "terminal_commands": 0
            },
            "settings": {
                "telemetry_consent": None,  # None = not asked, True/False = consent
                "first_run": True,
                "instance_id": None  # Persistent daemon instance ID
            }
        }

    def save(self) -> bool:
        """Save memory to file"""
        try:
            self.data["updated_at"] = datetime.now().isoformat()
            # //audit assumption: memory path parent may not exist for custom/test file paths; failure risk: persistence silently fails with FileNotFoundError; expected invariant: parent directory exists before write; handling strategy: create parent directories eagerly.
            self.file_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.file_path, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, ensure_ascii=False)
            return True
        except IOError as e:
            print(f"❌ Failed to save memory: {e}")
            return False

    def add_conversation(self, user_message: str, ai_response: str, tokens: int, cost: float) -> None:
        """Add a conversation to memory"""
        self.data["conversations"].append({
            "timestamp": datetime.now().isoformat(),
            "user": user_message,
            "ai": ai_response,
            "tokens": tokens,
            "cost": cost
        })

        # Keep only last 100 conversations
        if len(self.data["conversations"]) > 100:
            self.data["conversations"] = self.data["conversations"][-100:]

        # Update statistics
        self.data["statistics"]["total_requests"] += 1
        self.data["statistics"]["total_tokens"] += tokens
        self.data["statistics"]["total_cost"] += cost

        self.save()

    def get_recent_conversations(self, limit: int = 10) -> list[dict]:
        """Get recent conversations for context"""
        conversations = list(self.data["conversations"])
        recovery_db = self._recovery_history()
        if recovery_db is not None:
            for record in recovery_db.get_recent_recovered_conversations(max(100, limit)):
                conversations.append({
                    "timestamp": datetime.fromtimestamp(record["created_at"]).isoformat(),
                    "user": record["user"], "ai": record["ai"],
                    "tokens": record["tokens"], "cost": record["cost"],
                    "delivery_id": record["delivery_id"],
                })
            conversations.sort(key=lambda record: record.get("timestamp", ""))
        return conversations[-limit:]

    def get_statistics(self) -> dict[str, Any]:
        """Get usage statistics"""
        statistics = dict(self.data["statistics"])
        recovery_db = self._recovery_history()
        if recovery_db is not None:
            for key, value in recovery_db.get_recovered_statistics().items():
                statistics[key] = statistics.get(key, 0) + value
        return statistics

    def increment_stat(self, stat_name: str, amount: int = 1) -> None:
        """Increment a statistic counter"""
        if stat_name in self.data["statistics"]:
            self.data["statistics"][stat_name] += amount
            self.save()

    def set_user_preference(self, key: str, value: "JsonValue") -> None:
        """Set a user preference"""
        self.data["user"]["preferences"][key] = value
        self.save()

    def get_user_preference(self, key: str, default: Optional["JsonValue"] = None) -> Optional["JsonValue"]:
        """Get a user preference"""
        return self.data["user"]["preferences"].get(key, default)

    def set_setting(self, key: str, value: "JsonValue") -> None:
        """Set a system setting"""
        self.data["settings"][key] = value
        self.save()

    def get_setting(self, key: str, default: Optional["JsonValue"] = None) -> Optional["JsonValue"]:
        """Get a system setting"""
        return self.data["settings"].get(key, default)

    def clear_conversations(self) -> None:
        """Clear saved history, deferring undisplayed recovery payloads until acknowledgement."""
        recovery_db = self._recovery_history()
        if recovery_db is not None:
            recovery_db.clear_recovered_history()
        self.data["conversations"] = []
        self.save()

    def reset_statistics(self) -> None:
        """Reset all statistics"""
        recovery_db = self._recovery_history()
        if recovery_db is not None:
            recovery_db.reset_recovered_statistics()
        self.data["statistics"] = self._default_data()["statistics"]
        self.save()

    def export_backup(self, backup_path: Path) -> bool:
        """Export memory to backup file"""
        try:
            # //audit assumption: backup destination parent may be missing; failure risk: backup export fails unexpectedly; expected invariant: destination parent exists before write; handling strategy: create parent directories eagerly.
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            with open(backup_path, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, ensure_ascii=False)
            return True
        except IOError:
            return False

    def import_backup(self, backup_path: Path) -> bool:
        """Import memory from backup file"""
        try:
            with open(backup_path, "r", encoding="utf-8") as f:
                self.data = json.load(f)
            self.save()
            return True
        except (json.JSONDecodeError, IOError):
            return False
