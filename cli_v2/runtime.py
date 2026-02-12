from dataclasses import dataclass
import os


@dataclass
class Runtime:
    backend_url: str
    runtime_version: str
    schema_version: str
    trace_id: str
    mode: str = "CONNECTED"

    @staticmethod
    def from_env(trace_id: str) -> "Runtime":
        return Runtime(
            backend_url=os.getenv("ARCANOS_BACKEND_URL", "http://localhost:3000"),
            runtime_version="2.0.0",
            schema_version="1.0.0",
            trace_id=trace_id,
        )
