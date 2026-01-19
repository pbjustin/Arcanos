"""
Telemetry System for ARCANOS
Opt-in anonymous analytics and crash reporting.
"""

import uuid
import platform
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional
from config import Config

try:
    import sentry_sdk
    SENTRY_AVAILABLE = True
except ImportError:
    SENTRY_AVAILABLE = False


class Telemetry:
    """Manages anonymous telemetry and analytics"""

    def __init__(self):
        self.enabled = Config.TELEMETRY_ENABLED
        self.session_id = str(uuid.uuid4())
        self.user_id = self._get_or_create_user_id()

        # Initialize Sentry if enabled
        if self.enabled and SENTRY_AVAILABLE and Config.SENTRY_DSN:
            self._init_sentry()

    def _get_or_create_user_id(self) -> str:
        """Get or create anonymous user ID"""
        user_id_file = Config.TELEMETRY_DIR / "user_id.txt"
        Config.TELEMETRY_DIR.mkdir(parents=True, exist_ok=True)

        if user_id_file.exists():
            with open(user_id_file, "r") as f:
                return f.read().strip()
        else:
            user_id = str(uuid.uuid4())
            with open(user_id_file, "w") as f:
                f.write(user_id)
            return user_id

    def _init_sentry(self) -> None:
        """Initialize Sentry SDK"""
        try:
            sentry_sdk.init(
                dsn=Config.SENTRY_DSN,
                traces_sample_rate=0.1,
                environment="production",
                release=f"arcanos@{Config.VERSION}",
                before_send=self._filter_event
            )

            # Set user context
            sentry_sdk.set_user({
                "id": self.user_id,
                "session_id": self.session_id
            })

            # Set system context
            sentry_sdk.set_context("system", {
                "os": platform.system(),
                "os_version": platform.version(),
                "python_version": platform.python_version(),
                "arcanos_version": Config.VERSION
            })

        except Exception as e:
            print(f"⚠️  Failed to initialize telemetry: {e}")
            self.enabled = False

    def _filter_event(self, event: Dict[str, Any], hint: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Filter sensitive data from telemetry events
        Returns:
            Filtered event or None to drop event
        """
        # Remove API keys from environment
        if 'server_name' in event:
            event['server_name'] = 'redacted'

        # Remove file paths that might contain usernames
        if 'exception' in event and 'values' in event['exception']:
            for exc in event['exception']['values']:
                if 'stacktrace' in exc and 'frames' in exc['stacktrace']:
                    for frame in exc['stacktrace']['frames']:
                        if 'abs_path' in frame:
                            # Keep only filename, not full path
                            frame['abs_path'] = Path(frame['abs_path']).name

        return event

    def track_event(self, event_name: str, properties: Optional[Dict[str, Any]] = None) -> None:
        """
        Track an analytics event
        Args:
            event_name: Name of the event (e.g., "conversation_started")
            properties: Optional event properties
        """
        if not self.enabled:
            return

        try:
            # Create event data
            event_data = {
                "event": event_name,
                "timestamp": datetime.now().isoformat(),
                "session_id": self.session_id,
                "user_id": self.user_id,
                "properties": properties or {}
            }

            # Log to file (for local debugging)
            log_file = Config.TELEMETRY_DIR / "events.log"
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(f"{event_data}\n")

            # Send to Sentry as breadcrumb
            if SENTRY_AVAILABLE:
                sentry_sdk.add_breadcrumb(
                    category=event_name,
                    message=f"Event: {event_name}",
                    data=properties,
                    level="info"
                )

        except Exception:
            pass  # Fail silently

    def track_error(self, error: Exception, context: Optional[Dict[str, Any]] = None) -> None:
        """
        Track an error
        Args:
            error: Exception object
            context: Optional error context
        """
        if not self.enabled or not SENTRY_AVAILABLE:
            return

        try:
            with sentry_sdk.push_scope() as scope:
                if context:
                    scope.set_context("error_context", context)

                sentry_sdk.capture_exception(error)

        except Exception:
            pass  # Fail silently

    def track_performance(self, operation: str, duration_ms: float) -> None:
        """
        Track performance metric
        Args:
            operation: Operation name (e.g., "gpt_request")
            duration_ms: Duration in milliseconds
        """
        if not self.enabled:
            return

        self.track_event("performance", {
            "operation": operation,
            "duration_ms": duration_ms
        })

    def flush(self) -> None:
        """Flush telemetry data (call before exit)"""
        if self.enabled and SENTRY_AVAILABLE:
            try:
                sentry_sdk.flush(timeout=2.0)
            except Exception:
                pass
