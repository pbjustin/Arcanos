"""
v2 Trust Verification — Graceful Shutdown

Registers signal handlers to cleanly disconnect Redis before exit.
Uses a flag-based approach to avoid deadlocking the audit logger's
threading.Lock when a signal fires during log_event().

On Windows, SIGTERM registration is best-effort since Windows does not
support full POSIX signal semantics.
"""

import signal
import sys
import logging
import os

from .redis_client import disconnect

logger = logging.getLogger("arcanos.v2.shutdown")

_registered = False
_shutting_down = False


def register_shutdown_hooks() -> None:
    global _registered
    if _registered:
        return
    _registered = True

    def _handler(signum, frame):
        global _shutting_down
        if _shutting_down:
            return  # guard against re-entrancy
        _shutting_down = True

        sig_name = signal.Signals(signum).name
        # Write directly to stderr instead of using log_event
        # to avoid deadlocking on the audit logger's lock
        sys.stderr.write(f'{{"type":"SHUTDOWN","signal":"{sig_name}"}}\n')
        sys.stderr.flush()

        try:
            disconnect()
        except Exception:
            pass

        sys.exit(0)

    signal.signal(signal.SIGINT, _handler)

    # SIGTERM may not behave reliably on Windows
    if os.name != "nt":
        signal.signal(signal.SIGTERM, _handler)
    else:
        try:
            signal.signal(signal.SIGTERM, _handler)
        except (OSError, ValueError):
            logger.debug("SIGTERM handler not supported on this platform")
