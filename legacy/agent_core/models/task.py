from dataclasses import dataclass
from typing import Dict, Any


@dataclass
class Task:
    task_id: str
    type: str
    payload: Dict[str, Any]
