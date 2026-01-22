"""
Memory Schema for ARCANOS
JSON-based persistent storage for conversations and user preferences.
"""

import json
from pathlib import Path
from typing import Any, Optional
from datetime import datetime
from config import Config


class Memory:
    """Manages persistent conversation memory"""

    def __init__(self, file_path: Optional[Path] = None):
        self.file_path = file_path or Config.MEMORY_FILE
        self.data = self._load()

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
                "windows_integration_installed": False,
                "first_run": True
            }
        }

    def save(self) -> bool:
        """Save memory to file"""
        try:
            self.data["updated_at"] = datetime.now().isoformat()
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
        return self.data["conversations"][-limit:]

    def get_statistics(self) -> dict[str, Any]:
        """Get usage statistics"""
        return self.data["statistics"]

    def increment_stat(self, stat_name: str, amount: int = 1) -> None:
        """Increment a statistic counter"""
        if stat_name in self.data["statistics"]:
            self.data["statistics"][stat_name] += amount
            self.save()

    def set_user_preference(self, key: str, value: Any) -> None:
        """Set a user preference"""
        self.data["user"]["preferences"][key] = value
        self.save()

    def get_user_preference(self, key: str, default: Any = None) -> Any:
        """Get a user preference"""
        return self.data["user"]["preferences"].get(key, default)

    def set_setting(self, key: str, value: Any) -> None:
        """Set a system setting"""
        self.data["settings"][key] = value
        self.save()

    def get_setting(self, key: str, default: Any = None) -> Any:
        """Get a system setting"""
        return self.data["settings"].get(key, default)

    def clear_conversations(self) -> None:
        """Clear all conversation history"""
        self.data["conversations"] = []
        self.save()

    def reset_statistics(self) -> None:
        """Reset all statistics"""
        self.data["statistics"] = self._default_data()["statistics"]
        self.save()

    def export_backup(self, backup_path: Path) -> bool:
        """Export memory to backup file"""
        try:
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
