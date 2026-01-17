"""Daemon entrypoint for periodic memory synchronization."""

import time

from update_manager import UpdateManager


def run_daemon_loop(manager: UpdateManager, interval_seconds: int) -> None:
    """
    Run the periodic memory sync loop.

    Purpose:
        Invoke update runs on a fixed interval.
    Inputs/Outputs:
        manager: UpdateManager instance that performs updates.
        interval_seconds: Positive integer delay between runs.
        Returns None; runs indefinitely.
    Edge cases:
        If interval_seconds is non-positive, a ValueError is raised before looping.
    """

    if interval_seconds <= 0:
        # //audit Assumption: sync interval must be positive. Risk: zero/negative causes tight loop. Invariant: interval_seconds > 0. Handling: raise ValueError.
        raise ValueError("interval_seconds must be positive")

    print("[DAEMON] Starting memory sync loop...")
    while True:
        # //audit Assumption: manager.run_updates is idempotent. Risk: partial update on interruption. Invariant: update completes before sleep. Handling: propagate exceptions.
        manager.run_updates()
        time.sleep(interval_seconds)


if __name__ == "__main__":
    run_daemon_loop(UpdateManager(), interval_seconds=30)
