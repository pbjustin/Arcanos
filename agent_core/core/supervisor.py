import asyncio
import os


def _read_positive_interval_seconds(env_name: str, default_seconds: float) -> float:
    """
    Read a positive polling interval from environment with fallback.
    Inputs: environment variable name and default value in seconds.
    Outputs: validated positive interval.
    Edge case behavior: invalid, missing, or non-positive values fall back to default.
    """
    raw_value = os.getenv(env_name)
    # //audit assumption: missing env configuration should not break runtime startup.
    if raw_value is None:
        return default_seconds

    try:
        interval = float(raw_value)
    except ValueError:
        # //audit handling: parsing failures fall back to stable defaults to keep supervisor alive.
        return default_seconds

    # //audit invariant: scheduler sleeps must stay positive to avoid tight loops or runtime exceptions.
    if interval <= 0:
        return default_seconds

    return interval


class Supervisor:
    def __init__(self, kernel):
        """
        Build supervisor loops around the provided kernel.
        Inputs: kernel dependency implementing backend register, heartbeat, and task cycle APIs.
        Outputs: configured supervisor instance.
        Edge case behavior: defaults to conservative intervals when env overrides are invalid.
        """
        self.kernel = kernel
        self.heartbeat_interval_seconds = _read_positive_interval_seconds(
            "AGENT_HEARTBEAT_INTERVAL_SECONDS",
            5.0
        )
        self.task_poll_interval_seconds = _read_positive_interval_seconds(
            "AGENT_TASK_POLL_INTERVAL_SECONDS",
            2.0
        )

    async def start(self):
        """Start registration and run heartbeat/task loops concurrently."""
        await self.kernel.backend.register()

        async with asyncio.TaskGroup() as tg:
            tg.create_task(self._heartbeat_loop())
            tg.create_task(self._task_loop())

    async def _heartbeat_loop(self):
        """Send periodic heartbeats to backend-service."""
        while True:
            await asyncio.sleep(self.heartbeat_interval_seconds)
            await self.kernel.send_heartbeat()

    async def _task_loop(self):
        """Poll backend-service for tasks and process each cycle."""
        while True:
            await asyncio.sleep(self.task_poll_interval_seconds)
            await self.kernel.process_task_cycle()
