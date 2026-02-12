import uuid
import time


def generate_trace_id() -> str:
    return f"{uuid.uuid4()}-{int(time.time())}"
