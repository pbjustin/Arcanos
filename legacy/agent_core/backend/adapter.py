from typing import Protocol, Optional
from agent_core.models.task import Task
from agent_core.models.result import TaskResult


class BackendAdapter(Protocol):
    async def register(self) -> None:
        ...

    async def heartbeat(self, state: str, health: float) -> None:
        ...

    async def get_task(self) -> Optional[Task]:
        ...

    async def submit_result(self, result: TaskResult) -> None:
        ...
