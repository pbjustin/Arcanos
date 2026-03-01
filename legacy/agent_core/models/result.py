from dataclasses import dataclass
from typing import Any


@dataclass
class TaskResult:
    agent_id: str
    task_id: str
    success: bool
    output: Any
    error: str | None
