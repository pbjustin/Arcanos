"""Run the existing focused native fixtures in Windows Python CI."""
from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest


pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Native Windows acceptance requires ConPTY and PowerShell")
SOURCE_ROOT = Path(__file__).resolve().parents[2]


def test_native_powershell_hashtable_sentinel_and_literal_controls(tmp_path, monkeypatch, capsys):
    monkeypatch.syspath_prepend(str(SOURCE_ROOT / "daemon-python/scripts"))
    from local_action_acceptance import powershell

    receipt = powershell.run(tmp_path / "powershell", SOURCE_ROOT)
    if receipt["failed"]:
        with capsys.disabled():
            print(json.dumps({"native_policy_failures": [case for case in receipt["cases"] if case["status"] != "PASS"]}))
    assert receipt["failed"] == 0, receipt
    assert receipt["all_child_processes_exited"]
    assert receipt["all_native_processes_exited"]
    cases = {case["name"]: case for case in receipt["cases"]}
    denied = cases["hashtable_file_creation"]
    assert denied["status"] == "PASS"
    assert denied["result"]["exception_category"] == "policy_rejected"
    assert denied["result"]["exit_code"] is None
    assert denied["result"]["sentinel_existed_before"] is False
    assert denied["result"]["sentinel_exists_after"] is False
    assert denied["sentinel_absent"] is True
    assert denied["result"]["native_popen_count"] == denied["guard_popen_count"] == 0
    for name in ("single_quoted_hashtable_literal", "double_quoted_hashtable_literal"):
        literal = cases[name]
        assert literal["status"] == "PASS"
        assert literal["result"]["output_intact"] is True
        assert literal["result"]["native_popen_count"] == literal["guard_popen_count"] == 1
    with capsys.disabled():
        print(json.dumps({"native_hashtable_acceptance": "PASS", "cases_passed": receipt["passed"],
                          "sentinel_absent_before_and_after": True, "native_dispatch_count": 0,
                          "quoted_literal_controls": "PASS",
                          "powershell_executable": denied["result"]["explicit_shell_executable"],
                          "source_terminal_sha256": receipt["source_terminal_sha256"]}))


def test_native_cli_hashtable_rejected_before_dispatch(tmp_path, monkeypatch, capsys):
    monkeypatch.syspath_prepend(str(SOURCE_ROOT / "daemon-python/scripts"))
    from local_action_acceptance.cli import DaemonFixture, _hashtable_blocked

    fixture = DaemonFixture(tmp_path / "cli", SOURCE_ROOT, extra_env={"COMMAND_WHITELIST": "Write-Output"})
    try:
        fixture.start()
        result = _hashtable_blocked(fixture)
        assert result["status"] == "PASS", result
        assert result["whitelist_rejection_observed"] is True
        assert result["command_history_unchanged"] is True
        assert result["execution_status"] == "blocked"
        assert result["exit_code"] is None
        assert result["native_dispatch_count"] == 0
        assert result["sentinel_existed_before"] is result["sentinel_exists_after"] is False
        assert not (fixture.repository / "sentinel.txt").exists()
    except Exception:
        from arcanos.voice_boundary import sanitize_tool_output
        from local_action_acceptance.cli import _receipt

        transcript = fixture.console.transcript if fixture.console else ""
        for credential in (fixture.backend.token, fixture.backend.daemon_token):
            transcript = transcript.replace(credential, "[REDACTED]")
        with capsys.disabled():
            print(json.dumps({"native_cli_failure": _receipt(fixture),
                              "console": sanitize_tool_output(transcript)[-4000:]}))
        raise
    finally:
        fixture.close()
    assert fixture.cleanup["job_closed"]
    assert fixture.cleanup["backend_thread_stopped"]
    assert fixture.cleanup["forced_termination"] is False
    assert fixture.cleanup["wrapper_exit_code"] == 0
    with capsys.disabled():
        print(json.dumps({"native_cli_hashtable_acceptance": "PASS", **result}))
