from __future__ import annotations

import http.client
import json
import logging
import subprocess
import threading

from arcanos.cli.local_bridge import BRIDGE_TOKEN_HEADER, LocalBridge, _hash_proposal
from tests.credential_observation import assert_no_credential_material


def _start_bridge(monkeypatch, tmp_path):
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_TOKEN", "test-bridge-token")
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    bridge = LocalBridge(port=0)
    bridge._worker.start()
    server = bridge._build_server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return bridge, server, thread


def _stop_bridge(bridge, server, thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    bridge.jobs.put_nowait(None)
    bridge._worker.join(timeout=5)
    if thread.is_alive() or bridge._worker.is_alive():
        raise AssertionError("local bridge test threads did not stop")


def _post(server, path: str, payload: dict, token: str | None = "test-bridge-token", content_type: str = "application/json"):
    conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
    headers = {"Content-Type": content_type}
    if token is not None:
        headers[BRIDGE_TOKEN_HEADER] = token
    conn.request("POST", path, body=json.dumps(payload), headers=headers)
    response = conn.getresponse()
    body = json.loads(response.read().decode("utf-8"))
    conn.close()
    return response.status, body


def test_bridge_rejects_missing_token_and_unsupported_content_type(monkeypatch, tmp_path) -> None:
    bridge, server, thread = _start_bridge(monkeypatch, tmp_path)
    try:
        status, body = _post(server, "/commands/run", {}, token=None)
        assert status == 403
        assert body["status"] == "forbidden"

        status, body = _post(server, "/commands/run", {}, content_type="text/plain")
        assert status == 415
        assert body["status"] == "unsupported_media_type"
    finally:
        _stop_bridge(bridge, server, thread)


def test_bridge_refuses_enabled_startup_without_token(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_ENABLED", "true")
    monkeypatch.delenv("ARCANOS_CLI_BRIDGE_TOKEN", raising=False)
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))

    try:
        LocalBridge(port=0)
    except ValueError as exc:
        assert "ARCANOS_CLI_BRIDGE_TOKEN" in str(exc)
    else:
        raise AssertionError("enabled bridge startup without token should fail")


def test_bridge_uses_exact_unicode_safe_credential_verification(monkeypatch, tmp_path, capsys, caplog) -> None:
    credential = "".join(("opaque", "-bridge-雪-", "credential-marker"))
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_TOKEN", credential)
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    bridge = LocalBridge(port=0)

    with caplog.at_level(logging.DEBUG):
        assert bridge._is_authorized(credential) is True
        assert bridge._is_authorized(credential + "x") is False
        assert bridge._is_authorized(credential[:-1] + "x") is False
        assert bridge._is_authorized(f" {credential} ") is False
        assert bridge._is_authorized(None) is False

    captured = capsys.readouterr()
    assert_no_credential_material(credential, captured.out, captured.err, caplog.text)


def test_bridge_requires_matching_command_proposal_id(monkeypatch, tmp_path) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    bridge, server, thread = _start_bridge(monkeypatch, tmp_path)
    cwd = str(tmp_path.resolve())
    command = "git status --short"
    proposal_id = _hash_proposal({"kind": "command", "command": command, "cwd": cwd})
    try:
        status, body = _post(server, "/commands/run", {"command": command, "cwd": cwd})
        assert status == 400
        assert body["status"] == "proposal_required"

        status, body = _post(server, "/commands/run", {"command": command, "cwd": cwd, "proposalId": "cli-wrong"})
        assert status == 400
        assert body["status"] == "proposal_mismatch"

        status, body = _post(server, "/commands/run", {"command": command, "cwd": cwd, "proposalId": proposal_id})
        assert status == 200
        assert body["status"] == "completed"
    finally:
        _stop_bridge(bridge, server, thread)


def test_bridge_denies_dangerous_command_even_with_matching_proposal(monkeypatch, tmp_path) -> None:
    bridge, server, thread = _start_bridge(monkeypatch, tmp_path)
    cwd = str(tmp_path.resolve())
    command = "rm -rf ."
    proposal_id = _hash_proposal({"kind": "command", "command": command, "cwd": cwd})
    try:
        status, body = _post(server, "/commands/run", {"command": command, "cwd": cwd, "proposalId": proposal_id})
        assert status == 400
        assert body["status"] == "denied"
    finally:
        _stop_bridge(bridge, server, thread)


def test_bridge_rejects_secret_patch_and_patch_proposal_mismatch(monkeypatch, tmp_path) -> None:
    bridge, server, thread = _start_bridge(monkeypatch, tmp_path)
    cwd = str(tmp_path.resolve())
    patch = "\n".join([
        "diff --git a/.env b/.env",
        "--- a/.env",
        "+++ b/.env",
        "@@ -1 +1 @@",
        "-OLD=1",
        "+TO" + "KEN=placeholder-redaction-value",
    ])
    proposal_id = _hash_proposal({"kind": "patch", "patch": patch, "cwd": cwd})
    try:
        status, body = _post(server, "/patches/apply", {"patch": patch, "cwd": cwd, "proposalId": "cli-wrong"})
        assert status == 400
        assert body["status"] == "proposal_mismatch"

        status, body = _post(server, "/patches/apply", {"patch": patch, "cwd": cwd, "proposalId": proposal_id})
        assert status == 400
        assert body["status"] == "denied"
    finally:
        _stop_bridge(bridge, server, thread)
