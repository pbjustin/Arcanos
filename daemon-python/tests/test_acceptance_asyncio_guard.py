"""The native terminal guard permits only asyncio's private self-wakeup pair."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.skipif(sys.platform != "win32", reason="Windows asyncio uses a loopback socketpair")
def test_asyncio_wakeup_is_allowed_without_allowing_other_loopback_sockets(tmp_path):
    """Permit the real stdlib pair while rejecting ordinary bind/connect and caller spoofing."""
    source = Path(__file__).resolve().parents[1] / "scripts"
    log = tmp_path / "network.jsonl"
    script = """
from local_action_acceptance.guard import install
install()
import asyncio, json, socket
loop = asyncio.new_event_loop()
loop.close()
denied = []
for operation in ('bind', 'connect', 'socketpair'):
    try:
        if operation == 'socketpair':
            pair = socket.socketpair()
            for connection in pair: connection.close()
        else:
            with socket.socket() as connection:
                getattr(connection, operation)(('127.0.0.1', 0 if operation == 'bind' else 9))
    except PermissionError:
        denied.append(operation)
print(json.dumps(denied))
"""
    env = {name: value for name, value in os.environ.items() if name.upper() in ("PATH", "SYSTEMROOT", "WINDIR")}
    env.update(PYTHONPATH=str(source), ACCEPTANCE_NETWORK_LOG=str(log), ACCEPTANCE_ALLOWED_PORTS="")
    result = subprocess.run([sys.executable, "-B", "-c", script], env=env,
                            capture_output=True, text=True, encoding="utf-8", timeout=10)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == ["bind", "connect", "socketpair"]
    events = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    allowed = [event for event in events if event.get("allowed") is True]
    assert len(allowed) == 2
    assert all(event.get("purpose") == "asyncio_wakeup" and event["host"] == "127.0.0.1" for event in allowed)
    assert {event["event"] for event in allowed} == {"socket.bind", "socket.connect"}
