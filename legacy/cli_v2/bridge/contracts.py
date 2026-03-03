from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any


class Action(BaseModel):
    type: str  # e.g., "shell", "read_file", "write_file"
    command: Optional[str] = None
    path: Optional[str] = None
    content: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class AnalysisRequest(BaseModel):
    runtime_version: str
    schema_version: str
    trace_id: str
    context: dict
    artifacts: List[dict]


class RawBackendResponse(BaseModel):
    result: str
    actions: List[Action] = Field(default_factory=list)
    contract_version: Optional[str] = None
    module: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None
