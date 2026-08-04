from __future__ import annotations

import http.client
import json
import subprocess
import threading
import time
from typing import Any
from unittest.mock import MagicMock

import pytest

import arcanos.cli.local_bridge as local_bridge
from arcanos.cli.local_bridge import (
    BRIDGE_TOKEN_HEADER,
    BridgeJob,
    BridgePatchJob,
    LocalBridge,
    _BridgeJobLifecycle,
    _hash_proposal,
)


def _post(server, path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    connection = http.client.HTTPConnection(
        "127.0.0.1", server.server_address[1], timeout=5
    )
    connection.request(
        "POST",
        path,
        body=json.dumps(payload),
        headers={
            "Content-Type": "application/json",
            BRIDGE_TOKEN_HEADER: "test-bridge-token",
        },
    )
    response = connection.getresponse()
    body = json.loads(response.read().decode("utf-8"))
    connection.close()
    return response.status, body


def _build_bridge_without_worker(monkeypatch, tmp_path):
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_TOKEN", "test-bridge-token")
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(local_bridge, "_coerce_timeout", lambda _value: 0.05)
    monkeypatch.setattr(local_bridge, "RESPONSE_GRACE_SECONDS", 0)
    bridge = LocalBridge(port=0)
    server = bridge._build_server()
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    return bridge, server, server_thread


def _stop_bridge(bridge, server, server_thread) -> None:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=5)
    if bridge._worker.is_alive():
        bridge.jobs.put_nowait(None)
        bridge._worker.join(timeout=5)
    if server_thread.is_alive() or bridge._worker.is_alive():
        raise AssertionError("local bridge test threads did not stop")


def _initialize_workspace(tmp_path) -> str:
    subprocess.run(
        ["git", "init"], cwd=tmp_path, check=True, capture_output=True
    )
    return str(tmp_path.resolve())


def test_timed_out_queued_command_is_never_executed(monkeypatch, tmp_path) -> None:
    cwd = _initialize_workspace(tmp_path)
    bridge, server, server_thread = _build_bridge_without_worker(monkeypatch, tmp_path)
    run_command = MagicMock(return_value=("late", "", 0))
    monkeypatch.setattr(bridge, "_run_command", run_command)
    command = "git status --short"
    proposal_id = _hash_proposal(
        {"kind": "command", "command": command, "cwd": cwd}
    )

    try:
        status, body = _post(
            server,
            "/commands/run",
            {
                "command": command,
                "cwd": cwd,
                "proposalId": proposal_id,
                "timeout": 1,
            },
        )
        assert status == 504
        assert body["status"] == "timeout"

        bridge._worker.start()
        bridge.jobs.put_nowait(None)
        bridge._worker.join(timeout=5)
        run_command.assert_not_called()
    finally:
        _stop_bridge(bridge, server, server_thread)


def test_timed_out_queued_patch_is_never_applied(monkeypatch, tmp_path) -> None:
    cwd = _initialize_workspace(tmp_path)
    (tmp_path / "sample.txt").write_text("old\n", encoding="utf-8")
    patch = "\n".join(
        [
            "diff --git a/sample.txt b/sample.txt",
            "--- a/sample.txt",
            "+++ b/sample.txt",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "",
        ]
    )
    bridge, server, server_thread = _build_bridge_without_worker(monkeypatch, tmp_path)
    apply_patch = MagicMock(return_value=("late", "", 0))
    monkeypatch.setattr(bridge, "_apply_patch", apply_patch)
    proposal_id = _hash_proposal({"kind": "patch", "patch": patch, "cwd": cwd})

    try:
        status, body = _post(
            server,
            "/patches/apply",
            {
                "patch": patch,
                "cwd": cwd,
                "proposalId": proposal_id,
                "timeout": 1,
            },
        )
        assert status == 504
        assert body["status"] == "timeout"

        bridge._worker.start()
        bridge.jobs.put_nowait(None)
        bridge._worker.join(timeout=5)
        apply_patch.assert_not_called()
        assert (tmp_path / "sample.txt").read_text(encoding="utf-8") == "old\n"
    finally:
        _stop_bridge(bridge, server, server_thread)


def test_worker_rejects_expired_jobs_before_mutation(monkeypatch, tmp_path) -> None:
    cwd = _initialize_workspace(tmp_path)
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_TOKEN", "test-bridge-token")
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    bridge = LocalBridge(port=0)
    run_command = MagicMock()
    apply_patch = MagicMock()
    monkeypatch.setattr(bridge, "_run_command", run_command)
    monkeypatch.setattr(bridge, "_apply_patch", apply_patch)
    command_lifecycle = _BridgeJobLifecycle(time.monotonic() - 1)
    patch_lifecycle = _BridgeJobLifecycle(time.monotonic() - 1)
    bridge.jobs.put_nowait(BridgeJob(
        audit_id="expired-command",
        command="git status --short",
        proposal_id="cli-command",
        timeout=1,
        cwd=cwd,
        lifecycle=command_lifecycle,
    ))
    bridge.jobs.put_nowait(BridgePatchJob(
        audit_id="expired-patch",
        patch="diff --git a/a b/a\n",
        proposal_id="cli-patch",
        timeout=1,
        cwd=cwd,
        lifecycle=patch_lifecycle,
    ))
    bridge.jobs.put_nowait(None)

    bridge._worker.start()
    bridge._worker.join(timeout=5)

    run_command.assert_not_called()
    apply_patch.assert_not_called()
    assert command_lifecycle.snapshot()[0] == "cancelled"
    assert patch_lifecycle.snapshot()[0] == "cancelled"


def test_claim_and_cancellation_are_mutually_exclusive() -> None:
    for _iteration in range(25):
        lifecycle = _BridgeJobLifecycle(time.monotonic() + 5)
        barrier = threading.Barrier(3)
        outcomes: list[tuple[str, bool]] = []

        def claim() -> None:
            barrier.wait()
            outcomes.append(("claim", lifecycle.try_claim()))

        def cancel() -> None:
            barrier.wait()
            outcomes.append(("cancel", lifecycle.cancel_if_queued()))

        claim_thread = threading.Thread(target=claim)
        cancel_thread = threading.Thread(target=cancel)
        claim_thread.start()
        cancel_thread.start()
        barrier.wait()
        claim_thread.join(timeout=2)
        cancel_thread.join(timeout=2)

        assert sorted(result for _name, result in outcomes) == [False, True]
        winner = next(name for name, result in outcomes if result)
        expected_phase = "running" if winner == "claim" else "cancelled"
        assert lifecycle.snapshot()[0] == expected_phase


def test_running_job_is_not_reported_as_admission_timeout(monkeypatch, tmp_path) -> None:
    cwd = _initialize_workspace(tmp_path)
    bridge, server, server_thread = _build_bridge_without_worker(monkeypatch, tmp_path)
    started = threading.Event()
    release = threading.Event()

    def run_command(_job: BridgeJob):
        started.set()
        if not release.wait(timeout=2):
            raise TimeoutError("test release was not signalled")
        return "completed", "", 0

    monkeypatch.setattr(bridge, "_run_command", run_command)
    bridge._worker.start()
    command = "git status --short"
    proposal_id = _hash_proposal(
        {"kind": "command", "command": command, "cwd": cwd}
    )
    response_holder: list[tuple[int, dict[str, Any]]] = []
    request_thread = threading.Thread(
        target=lambda: response_holder.append(_post(
            server,
            "/commands/run",
            {
                "command": command,
                "cwd": cwd,
                "proposalId": proposal_id,
                "timeout": 1,
            },
        ))
    )

    try:
        request_thread.start()
        assert started.wait(timeout=2)
        time.sleep(0.08)
        assert request_thread.is_alive()
        release.set()
        request_thread.join(timeout=5)

        assert response_holder[0][0] == 200
        assert response_holder[0][1]["status"] == "completed"
    finally:
        release.set()
        request_thread.join(timeout=5)
        _stop_bridge(bridge, server, server_thread)
