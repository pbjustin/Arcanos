"""
Crash Recovery System for ARCANOS
Auto-restart daemon on crash with intelligent limits.
"""

import sys
import time
import subprocess
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional
from config import Config


class CrashRecovery:
    """Manages crash detection and recovery"""

    def __init__(self, max_restarts: int = 5, time_window: int = 300):
        """
        Initialize crash recovery
        Args:
            max_restarts: Maximum restarts within time_window
            time_window: Time window in seconds (default: 5 minutes)
        """
        self.max_restarts = max_restarts
        self.time_window = time_window
        self.crash_log_file = Config.CRASH_REPORTS_DIR / "crash_log.txt"
        self.restart_history: list[datetime] = []

    def can_restart(self) -> bool:
        """Check if restart is allowed under limits"""
        now = datetime.now()
        cutoff = now - timedelta(seconds=self.time_window)

        # Remove old restart timestamps
        self.restart_history = [ts for ts in self.restart_history if ts > cutoff]

        # Check limit
        return len(self.restart_history) < self.max_restarts

    def log_crash(self, exception: Exception, context: str = "") -> None:
        """Log crash details"""
        Config.CRASH_REPORTS_DIR.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().isoformat()
        crash_info = f"""
{'='*80}
CRASH REPORT
Time: {timestamp}
Context: {context}
Exception: {type(exception).__name__}
Message: {str(exception)}
{'='*80}
"""

        # Write to log file
        with open(self.crash_log_file, "a", encoding="utf-8") as f:
            f.write(crash_info)

        # Also write individual crash report
        crash_file = Config.CRASH_REPORTS_DIR / f"crash_{timestamp.replace(':', '-')}.txt"
        with open(crash_file, "w", encoding="utf-8") as f:
            f.write(crash_info)
            f.write("\nStack Trace:\n")
            import traceback
            traceback.print_exc(file=f)

    def restart_daemon(self) -> bool:
        """
        Restart the ARCANOS daemon
        Returns:
            True if restarted successfully
        """
        if not self.can_restart():
            print(f"❌ Too many restarts ({self.max_restarts} in {self.time_window}s). Giving up.")
            return False

        print("🔄 Restarting ARCANOS...")
        self.restart_history.append(datetime.now())

        # Restart using same command
        try:
            python_exe = sys.executable
            script_path = Path(__file__).parent / "cli.py"

            # Start new process
            subprocess.Popen(
                [python_exe, str(script_path)],
                cwd=str(Path(__file__).parent),
                start_new_session=True
            )

            print("✅ Restart initiated")
            return True

        except Exception as e:
            print(f"❌ Failed to restart: {e}")
            return False


def run_with_recovery(main_function, *args, **kwargs):
    """
    Wrapper to run main function with crash recovery
    Usage: run_with_recovery(cli.run)
    """
    recovery = CrashRecovery()

    while True:
        try:
            # Run main function
            main_function(*args, **kwargs)

            # Normal exit (no crash)
            break

        except KeyboardInterrupt:
            # User interrupted (Ctrl+C) - normal exit
            print("\n👋 Goodbye!")
            break

        except Exception as e:
            # Crash detected
            print(f"\n❌ ARCANOS crashed: {type(e).__name__}: {str(e)}")

            # Log crash
            recovery.log_crash(e, context="main loop")

            # Ask user if they want to restart
            print("\n🤔 Would you like to restart ARCANOS?")
            print(f"   Restarts remaining: {recovery.max_restarts - len(recovery.restart_history)}/{recovery.max_restarts}")

            try:
                choice = input("Restart? (y/n): ").lower().strip()
                if choice != 'y':
                    print("❌ Not restarting. Goodbye!")
                    break

                # Attempt restart
                if not recovery.restart_daemon():
                    break

                # Wait before restart
                print("⏳ Restarting in 3 seconds...")
                time.sleep(3)

            except KeyboardInterrupt:
                print("\n❌ Restart cancelled. Goodbye!")
                break


if __name__ == "__main__":
    # Example usage
    from cli import ArcanosCLI

    cli = ArcanosCLI()
    run_with_recovery(cli.run)
