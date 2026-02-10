from datetime import datetime, timezone


def record(event: str, **fields):
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    # Append to existing logger or simple file; do not add infra deps.
    print(f"[AUDIT] {entry}")
