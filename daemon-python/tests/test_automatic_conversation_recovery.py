"""Actual protected recovery controller, HTTP client and idempotent history boundaries."""

import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest
import requests
from rich.console import Console

from arcanos.backend_client import BackendApiClient
from arcanos.cli import cli as cli_module, state
from arcanos.cli.conversation_recovery import ConversationRecovery
from arcanos.cli_session import SessionContext
from arcanos.config import Config
from arcanos.continuation_store import ContinuationStorageError
from arcanos.rate_limiter import RateLimiter
from arcanos.schema import Memory

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Actual Windows user-bound protected storage required")
JOB = "4a858089-b030-4596-abd2-aa0115df0001"
OTHER_JOB = "4a858089-b030-4596-abd2-aa0115df0002"
CAPABILITY = "v1." + "R" * 43
WRITING_TOKEN = "synthetic-recovery-writing-auth-1234567890"
CONTROL_TOKEN = "synthetic-recovery-control-auth-1234567890"
DAEMON_TOKEN = "synthetic-recovery-daemon-auth-1234567890"
ANSWER = "Original **complete answer**.\n\n### Audit Summary\nRequested public report — café 雪."


def _response(status, value):
    """Represent one actual client transport response without opening an external socket."""
    return SimpleNamespace(status_code=status, headers={}, text=json.dumps(value), json=lambda: value)


@pytest.mark.parametrize("boundary", ["cache", "ownership"])
def test_failed_startup_does_not_leave_restored_legacy_context_or_owner(recovery_profile, monkeypatch, boundary):
    """A failed controller cannot retain native claims or expose restored work to legacy resume."""
    make_cli, _ = recovery_profile
    original = make_cli(instance="shared-installation")
    original.handle_ask("what can u do?")
    original._conversation_recovery.stop()
    reopened = make_cli(instance="shared-installation", recovery=False)
    stores = []
    from arcanos.cli import conversation_recovery as module
    real_store = module.ContinuationStore

    def captured(*args, **kwargs):
        store = real_store(*args, **kwargs)
        stores.append(store)
        return store

    monkeypatch.setattr(module, "ContinuationStore", captured)
    monkeypatch.setattr(ConversationRecovery, "_sync_usage", lambda self: (_ for _ in ()).throw(RuntimeError("unavailable history")))
    try:
        reopened._start_conversation_recovery()
        assert reopened._conversation_recovery is None
        if boundary == "cache":
            assert JOB not in reopened._pending_backend_conversations
        else:
            contender = real_store(Config.DATA_DIR, reopened.backend_client.continuation_identity())
            stores.append(contender)
            assert contender.acquire_ownership(JOB)
    finally:
        for store in stores:
            store.release_ownerships()


def _completed(job_id=JOB, answer=ANSWER):
    """Use the existing jobs result envelope with server-owned presentation provenance."""
    return {"jobId": job_id, "status": "completed", "jobStatus": "completed", "lifecycleStatus": "completed",
            "result": {"ok": True, "presentation": "public-answer-v1", "_route": {"gptId": "arcanos-daemon"},
                       "result": {"result": answer, "tokens": 17, "cost": 0.0123, "model": "controlled-provider"}}}


def _wait_for(predicate, seconds=5):
    """Bound real worker waiting while preserving native process clocks."""
    deadline = time.monotonic() + seconds
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert predicate()


@pytest.fixture
def recovery_profile(tmp_path, monkeypatch):
    """Isolate actual history/protection paths and all provider/action-adjacent configuration."""
    for name, value in {
        "DATA_DIR": tmp_path, "MEMORY_FILE": tmp_path / "memory.json", "HISTORY_DB_PATH": tmp_path / "history.db",
        "DEBUG_LOG_PATH": tmp_path / "debug.log", "LOG_DIR": tmp_path / "logs",
        "CONTROL_PLANE_ACCESS_TOKEN": CONTROL_TOKEN, "DAEMON_ACCESS_TOKEN": DAEMON_TOKEN,
        "BACKEND_ALLOW_GPT_ID_AUTH": False, "BACKEND_FALLBACK_TO_LOCAL": True,
        "AGENTIC_ENABLED": False, "STREAM_RESPONSES": False, "SPEAK_RESPONSES": False,
        "BACKEND_SEND_UPDATES": False, "REPO_INDEX_ENABLED": False, "SHOW_STATS": False,
        "CONVERSATION_RECOVERY_ENABLED": True,
    }.items():
        monkeypatch.setattr(Config, name, value)
    monkeypatch.setattr(cli_module.memory_ops, "update_short_term_summary", lambda *_: None)
    monkeypatch.setattr(cli_module.local_ops, "perform_local_conversation", lambda *_: pytest.fail("Recovery must not invoke fallback inference"))
    wire = {"posts": 0, "providers": 0, "gets": 0, "requests": [], "states": {}, "jobs": {}, "fault": None,
            "clock": [0.0], "response_answer": ANSWER, "immediate": False, "maximum_read_timeout": 2}
    request_lock = threading.Lock()
    controllers = []

    def sender(method, url, **options):
        """Count every generation/result operation and enforce fixed-header capabilities."""
        path = urlsplit(url).path
        with request_lock:
            wire["requests"].append((method, path))
            if path == "/system-state":
                assert options["headers"].get("Authorization") == "Bearer " + CONTROL_TOKEN
                return _response(200, {"mode": "system_state", "intent": {"intentId": None},
                                       "routing": {"preferred": "backend"},
                                       "backend": {"connected": True, "registryAvailable": True},
                                       "stateFreshness": {"intent": "unknown", "backend": "fresh"},
                                       "generatedAt": "2026-11-05T00:00:00Z"})
            if path == "/api/daemon/registry":
                assert options["headers"].get("x-arcanos-daemon-token") == DAEMON_TOKEN
                return _response(200, {"version": 1, "updatedAt": "2026-11-05T00:00:00Z", "endpoints": [],
                                       "modules": [], "daemonTools": [], "core": []})
            if path == "/gpt/arcanos-daemon":
                assert method == "post"
                wire["posts"] += 1
                wire["providers"] += 1
                if wire["immediate"]:
                    return _response(200, {"response": ANSWER, "presentation": "public-answer-v1", "tokens": 17, "cost": 0.0123})
                job_id = JOB if wire["posts"] == 1 else OTHER_JOB
                wire["jobs"][job_id] = options["json"]["prompt"]
                wire["states"].setdefault(job_id, ["pending", "completed"])
                return _response(202, {"ok": True, "status": "queued", "jobId": job_id, "result": {},
                                       "poll": f"/jobs/{job_id}/result", "jobReadToken": CAPABILITY,
                                       "jobReadTokenHeader": "x-arcanos-job-read-token"})
            if path.startswith("/jobs/"):
                assert method == "get" and options["json"] is None
                assert 0 < options["timeout"] <= wire["maximum_read_timeout"]
                assert options["headers"].get("x-arcanos-job-read-token") == CAPABILITY
                assert not options["headers"].get("x-arcanos-daemon-token")
                assert CAPABILITY not in url
                wire["gets"] += 1
                if wire["fault"] == "offline":
                    raise requests.ConnectionError("synthetic offline " + CAPABILITY)
                if wire["fault"] in (401, 403, 503):
                    return _response(wire["fault"], {"error": CAPABILITY})
                job_id = path.split("/")[2]
                states = wire["states"].setdefault(job_id, ["completed"])
                status = states.pop(0) if len(states) > 1 else states[0]
                if status == "empty":
                    return _response(200, {})
                if status == "completed":
                    return _response(200, _completed(job_id, wire["response_answer"]))
                if status == "lost":
                    return _response(200, {"jobId": job_id, "status": "failed", "jobStatus": "completed",
                                           "error": {"code": "JOB_RESULT_UNAVAILABLE"}, "result": None})
                return _response(200, {"jobId": job_id, "status": "failed" if status == "cancelled" else status,
                                       "jobStatus": "cancelled" if status == "cancelled" else status,
                                       "result": None})
        raise AssertionError("Unexpected operation outside the recovery fixture")

    def make_cli(instance="first-process", base_url="https://recovery.example.invalid", credential=WRITING_TOKEN,
                 *, monitor_clock=None, recovery=True):
        """Construct actual CLI services without installed profiles, devices or daemon threads."""
        cli = cli_module.ArcanosCLI.__new__(cli_module.ArcanosCLI)
        cli.console = Console(file=io.StringIO(), width=220, color_system=None, force_terminal=False)
        cli.backend_client = BackendApiClient(base_url, lambda: credential, timeout_seconds=5,
                                             request_sender=sender, daemon_access_token_provider=lambda: DAEMON_TOKEN)
        state.initialize_runtime_state(cli)
        cli.instance_id, cli.client_id = instance, "automatic-recovery-fixture"
        cli.session = SessionContext(session_id=instance)
        cli.memory = Memory(Config.MEMORY_FILE)
        cli.rate_limiter = RateLimiter()
        cli.audio = MagicMock()
        cli._append_activity = MagicMock()
        cli._last_response = None
        cli._conversation_recovery = None
        cli.system_prompt = state.build_system_prompt(cli)
        if recovery:
            controller = ConversationRecovery(cli, clock=monitor_clock or (lambda: wire["clock"][0]))
            cli._conversation_recovery = controller
            controllers.append(controller)
        return cli

    yield make_cli, wire
    for controller in controllers:
        controller.stop()


def _assert_saved_once(cli, question="original question", answer=ANSWER):
    """Check visible history, durable accounting and local quota hydration agree exactly once."""
    rows = cli.memory.get_recent_conversations()
    assert len(rows) == 1 and rows[0]["user"] == question and rows[0]["ai"] == answer
    assert cli.memory.get_statistics()["total_requests"] == 1
    assert cli.memory.get_statistics()["total_tokens"] == 17
    assert cli.memory.get_statistics()["total_cost"] == pytest.approx(0.0123)
    assert cli.rate_limiter.tokens_today == 17
    assert cli.rate_limiter.cost_today == pytest.approx(0.0123)


def test_default_worker_automatically_delivers_original_answer_without_resume(recovery_profile):
    """The background controller observes pending then completion without any manual command."""
    make_cli, wire = recovery_profile
    cli = make_cli(monitor_clock=time.monotonic)
    cli._conversation_recovery.start()
    cli.handle_ask("original question")
    _wait_for(lambda: cli.memory.get_statistics()["total_requests"] == 1 and not cli._conversation_recovery.store.load())
    cli._conversation_recovery.stop()
    assert wire["posts"] == wire["providers"] == 1
    assert wire["gets"] == 2
    _assert_saved_once(cli)
    assert ANSWER in cli.console.file.getvalue()
    cli.audio.speak.assert_not_called()


def test_immediate_http200_keeps_existing_delivery_behavior(recovery_profile):
    """Synchronous answers display once without creating a protected pending record."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    wire["immediate"] = True
    cli.handle_ask("ordinary immediate question")
    assert wire["posts"] == wire["providers"] == 1 and wire["gets"] == 0
    assert cli._conversation_recovery.store.load() == []
    assert cli.memory.get_recent_conversations()[0]["user"] == "ordinary immediate question"
    assert ANSWER in cli.console.file.getvalue()


def test_fresh_cli_identity_restores_original_conversation_and_delivers_once(recovery_profile):
    """Restart recovery anchors to user/backend identity rather than the previous process ID."""
    make_cli, wire = recovery_profile
    first = make_cli()
    first.handle_ask("original question")
    first._conversation_recovery.tick()
    assert wire["gets"] == 1
    first._conversation_recovery.stop()
    restarted = make_cli(instance="fresh-process-after-restart", monitor_clock=time.monotonic)
    restarted._conversation_recovery.start()
    _wait_for(lambda: restarted.memory.get_statistics()["total_requests"] == 1 and not restarted._conversation_recovery.store.load())
    restarted._conversation_recovery.stop()
    _assert_saved_once(restarted)
    record = restarted.memory.get_recovered_conversation(restarted._conversation_recovery._delivery_id(JOB))
    assert record["session_id"] == "first-process"
    again = make_cli(instance="another-new-process")
    again._conversation_recovery.tick()
    _assert_saved_once(again)
    assert wire["posts"] == wire["providers"] == 1 and wire["gets"] == 2


@pytest.mark.parametrize("fault", ["offline", 503])
def test_offline_and_503_reads_back_off_without_fallback_or_new_generation(recovery_profile, fault):
    """Transient failures retain protected work and cap automatic polling at sixty seconds."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    controller = cli._conversation_recovery
    wire["fault"] = fault
    for expected in range(1, 10):
        controller.tick()
        assert wire["gets"] == expected
        for _ in range(5):
            controller.tick()
        assert wire["gets"] == expected
        due, _ = controller.schedule[JOB]
        assert 0 < due - wire["clock"][0] <= 60
        wire["clock"][0] = due
    assert len(controller.store.load()) == 1
    wire["fault"] = None
    wire["states"][JOB] = ["completed"]
    controller.tick()
    _assert_saved_once(cli)
    assert wire["posts"] == wire["providers"] == 1
    assert CAPABILITY not in cli.console.file.getvalue()


def test_empty_http200_result_retains_original_job_for_later_completion(recovery_profile):
    """A malformed empty response is retryable, rather than authoritative job absence."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    wire["states"][JOB] = ["empty", "completed"]
    controller = cli._conversation_recovery
    controller.tick()
    assert len(controller.store.load()) == 1
    assert cli.memory.get_recent_conversations() == []
    assert cli.memory.get_statistics()["total_requests"] == 0
    assert wire["posts"] == wire["providers"] == wire["gets"] == 1
    wire["clock"][0] = controller.schedule[JOB][0]
    controller.tick()
    _assert_saved_once(cli)
    assert controller.store.load() == []
    assert wire["posts"] == wire["providers"] == 1
    assert wire["gets"] == 2
    assert ANSWER in cli.console.file.getvalue()


@pytest.mark.parametrize("terminal,word", [("expired", "expired"), ("cancelled", "cancelled"),
                                         ("failed", "failed"), ("not_found", "unavailable"),
                                         ("lost", "no retained output")])
def test_authoritative_terminal_results_retire_without_invented_answer(recovery_profile, terminal, word, capsys):
    """Expired, denied, failed and genuinely lost output remain truthful terminal outcomes."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    wire["states"][JOB] = [terminal]
    capsys.readouterr()
    cli._conversation_recovery.tick()
    assert word in cli.console.file.getvalue().lower()
    assert cli._conversation_recovery.store.load() == []
    assert cli.memory.get_recent_conversations() == []
    assert cli.memory.get_statistics()["total_requests"] == 0
    assert '"event": "execute_success"' not in capsys.readouterr().out
    assert wire["posts"] == wire["providers"] == wire["gets"] == 1


@pytest.mark.parametrize("status", [401, 403])
def test_authorization_failure_never_refreshes_or_retries_generation(recovery_profile, status):
    """Denied job access is terminal without borrowing another credential or refreshing auth."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    wire["fault"] = status
    cli._conversation_recovery.tick()
    assert cli._conversation_recovery.store.load() == []
    assert cli.memory.get_recent_conversations() == []
    assert wire["posts"] == wire["providers"] == wire["gets"] == 1
    assert CAPABILITY not in cli.console.file.getvalue()


def test_duplicate_controllers_cannot_read_a_live_owners_job(recovery_profile):
    """Two CLI controllers cannot both poll the same accepted job."""
    make_cli, wire = recovery_profile
    first = make_cli()
    first.handle_ask("original question")
    wire["states"][JOB] = ["pending"]
    second = make_cli(instance="second-live-process")
    first._conversation_recovery.start()
    second._conversation_recovery.start()
    _wait_for(lambda: wire["gets"] == 1)
    time.sleep(0.1)
    second._conversation_recovery.stop()
    first._conversation_recovery.stop()
    assert wire["gets"] == 1
    assert wire["posts"] == wire["providers"] == 1
    assert first.memory.get_recent_conversations() == []


def test_unwritable_recovery_store_retains_process_private_manual_fallback(recovery_profile, monkeypatch):
    """A failed protected write keeps the original in-memory handle usable without generation."""
    make_cli, wire = recovery_profile
    cli = make_cli()

    def unavailable(*_args, **_kwargs):
        """Fail persistence without placing the capability in an exception message."""
        raise ContinuationStorageError("Protected continuation storage is unavailable.")

    monkeypatch.setattr(cli._conversation_recovery.store, "add", unavailable)
    cli.handle_ask("original question")
    assert "manual /resume recovery" in cli.console.file.getvalue()
    assert cli._conversation_recovery.store.load() == []
    wire["states"][JOB] = ["completed"]
    wire["maximum_read_timeout"] = 5  # Existing explicit manual read uses the original client's bound.
    cli.handle_resume(JOB)
    _assert_saved_once(cli)
    assert wire["posts"] == wire["providers"] == wire["gets"] == 1
    assert CAPABILITY not in cli.console.file.getvalue()


def test_post_commit_unlock_fault_cannot_duplicate_history_after_process_restart(recovery_profile, monkeypatch):
    """An ambiguously returned DPAPI commit must still use the durable delivery ledger."""
    import msvcrt
    from arcanos import continuation_store as storage
    make_cli, wire = recovery_profile
    cli = make_cli()
    controller = cli._conversation_recovery
    replace, native_locking = storage._atomic_replace, msvcrt.locking
    fault = {"armed": False, "triggered": False, "fd": None}

    def committed(source, destination):
        """Commit real protected bytes before arming the one-off native unlock failure."""
        replace(source, destination)
        fault["armed"] = True

    def locking(fd, mode, size):
        """Simulate a cleanup error after successful acceptance persistence, once only."""
        if mode == msvcrt.LK_UNLCK and fault["armed"] and not fault["triggered"]:
            fault.update(triggered=True, fd=fd)
            raise OSError("Synthetic post-commit unlock failure")
        return native_locking(fd, mode, size)

    monkeypatch.setattr(storage, "_atomic_replace", committed)
    monkeypatch.setattr(msvcrt, "locking", locking)
    try:
        cli.handle_ask("original question")
        assert fault["triggered"]
        wire["states"][JOB] = ["completed"]
        wire["maximum_read_timeout"] = 5  # The legacy fallback has the original client's bound.
        cli.handle_resume(JOB)
        _assert_saved_once(cli)
        assert wire["posts"] == wire["providers"] == wire["gets"] == 1
    finally:
        # Simulate the process-exit release even on the unfixed implementation;
        # the restarted child must observe exactly the durable on-disk evidence.
        local = storage._THREAD_LOCKS[(str(controller.store.lock_path).casefold(), 0)]
        if local.locked():
            os.close(fault["fd"])
            local.release()
    command = r'''
import io,json,os,sys
from contextlib import redirect_stdout
from pathlib import Path
with redirect_stdout(io.StringIO()):
    profile=Path(sys.argv[2])
    os.environ.update(DATA_DIR=str(profile),MEMORY_FILE=str(profile/'memory.json'),LOG_DIR=str(profile/'logs'),HISTORY_DB_PATH=str(profile/'history.db'))
    sys.path.insert(0,sys.argv[1])
    import arcanos.env as runtime_env
    runtime_env._BOOTSTRAPPED=True
    runtime_env._BASE_DIR=profile
    from pytest import MonkeyPatch
    from tests.test_automatic_conversation_recovery import recovery_profile
    patch=MonkeyPatch()
    fixture=recovery_profile.__wrapped__(profile,patch)
    make_cli,wire=next(fixture)
    cli=make_cli(instance='actual-fresh-process-after-unlock-fault')
    cli._conversation_recovery.tick()
    receipt={'pid':os.getpid(),'gets':wire['gets'],'posts':wire['posts'],'providers':wire['providers'],
             'history_count':len(cli.memory.get_recent_conversations()),'statistics':cli.memory.get_statistics(),
             'quota_tokens':cli.rate_limiter.tokens_today,'quota_cost':cli.rate_limiter.cost_today}
    try:
        next(fixture)
    except StopIteration:
        pass
    patch.undo()
print(json.dumps(receipt))
'''
    child = subprocess.run([sys.executable, "-B", "-c", command, str(Path(__file__).resolve().parents[1]), str(Config.DATA_DIR)],
                           capture_output=True, text=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
    assert child.returncode == 0 and child.stderr == ""
    result = json.loads(child.stdout)
    assert result["pid"] != os.getpid()
    assert result["gets"] == result["posts"] == result["providers"] == 0
    assert result["history_count"] == result["statistics"]["total_requests"] == 1
    assert result["statistics"]["total_tokens"] == result["quota_tokens"] == 17
    assert result["statistics"]["total_cost"] == result["quota_cost"] == pytest.approx(0.0123)
    assert CAPABILITY not in child.stdout + child.stderr + cli.console.file.getvalue()


def test_owned_ambiguous_commit_cannot_fall_back_when_snapshot_read_fails(recovery_profile, monkeypatch):
    """A protected native claim remains authoritative during a subsequent snapshot outage."""
    import msvcrt
    from arcanos import continuation_store as storage
    make_cli, wire = recovery_profile
    cli = make_cli()
    controller = cli._conversation_recovery
    replace, native_locking = storage._atomic_replace, msvcrt.locking
    fault = {"armed": False, "triggered": False}

    def committed(source, destination):
        """Arm only after a real DPAPI snapshot has been durably replaced."""
        replace(source, destination)
        fault["armed"] = True

    def locking(fd, mode, size):
        """Make acceptance return ambiguously without undoing its protected owner."""
        if mode == msvcrt.LK_UNLCK and fault["armed"] and not fault["triggered"]:
            fault["triggered"] = True
            raise OSError("Synthetic post-commit unlock failure")
        return native_locking(fd, mode, size)

    monkeypatch.setattr(storage, "_atomic_replace", committed)
    monkeypatch.setattr(msvcrt, "locking", locking)
    cli.handle_ask("original question")
    assert fault["triggered"] and controller.store.owns(JOB)
    assert JOB not in controller._protected_jobs
    wire["states"][JOB] = ["completed"]
    wire["maximum_read_timeout"] = 5  # Expose an erroneous legacy read as a history violation.

    def unavailable():
        """Reject one phase of protected reads without disclosing its private coordinates."""
        raise ContinuationStorageError("Protected continuation storage is unavailable.")

    with monkeypatch.context() as failure:
        failure.setattr(controller.store, "load", unavailable)
        cli.handle_resume(JOB)
    controller.tick()
    assert cli.memory.data["conversations"] == []
    _assert_saved_once(cli)
    assert wire["posts"] == wire["providers"] == wire["gets"] == 1


@pytest.mark.parametrize("fault", ["before_commit", "after_commit", "partial_render"])
def test_restart_after_history_or_terminal_failure_keeps_one_turn_and_one_charge(recovery_profile, monkeypatch, fault):
    """Crashes can repeat display but cannot duplicate committed history, audit or accounting."""
    make_cli, wire = recovery_profile
    first = make_cli()
    first.handle_ask("original question")
    wire["states"][JOB] = ["completed"]
    original_record = first.memory.record_recovered_conversation

    def failed_record(*args, **kwargs):
        """Simulate process loss on either side of the atomic completion-history commit."""
        if fault == "after_commit":
            original_record(*args, **kwargs)
        raise RuntimeError("synthetic history process loss")

    def partial_render(*args, **kwargs):
        """Fail after real terminal output begins; restart may repeat these initial bytes."""
        first.console.print(ANSWER[:20], markup=False)
        raise RuntimeError("synthetic interrupted terminal output")

    with monkeypatch.context() as patch:
        if fault == "partial_render":
            patch.setattr(cli_module.ui_ops, "speak_to_user", partial_render)
        else:
            patch.setattr(first.memory, "record_recovered_conversation", failed_record)
        first._conversation_recovery.tick()
    assert len(first._conversation_recovery.store.load()) == 1
    # Ending the original foreground releases its OS ownership claim. A second
    # live controller is not a process restart until that boundary is crossed.
    first._conversation_recovery.stop()
    restarted = make_cli(instance="fresh-process-after-crash")
    restarted._conversation_recovery.tick()
    restarted._conversation_recovery.tick()
    _assert_saved_once(restarted)
    assert wire["posts"] == wire["providers"] == 1
    assert wire["gets"] == (2 if fault == "before_commit" else 1)
    with sqlite3.connect(Config.HISTORY_DB_PATH) as connection:
        assert connection.execute("SELECT COUNT(*) FROM conversation_deliveries").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM policy_events WHERE event='conversation.completed'").fetchone()[0] == 1
        rows = connection.execute("SELECT session_id,user_text,answer_text FROM conversation_deliveries").fetchall()
        assert all(CAPABILITY not in str(row) for row in rows)


def test_sql_transaction_rolls_back_history_and_usage_together(recovery_profile, monkeypatch):
    """A crash during the durable completion transaction leaves no partial history or usage."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    wire["states"][JOB] = ["completed"]
    db = cli.memory._recovery_history(create=True)

    class InterruptedConnection(sqlite3.Connection):
        """Inject failure after turn/totals writes but before the durable audit insert."""

        def execute(self, statement, parameters=()):
            """Force the existing SQLite transaction context to roll all earlier writes back."""
            if "INSERT INTO policy_events" in statement:
                raise sqlite3.OperationalError("synthetic interrupted transaction " + CAPABILITY)
            return super().execute(statement, parameters)

    def interrupted_connection():
        """Keep actual SQLite semantics while substituting the one failure-injection connection."""
        return sqlite3.connect(str(Config.HISTORY_DB_PATH), factory=InterruptedConnection)

    with monkeypatch.context() as patch:
        patch.setattr(db, "_conn", interrupted_connection)
        cli._conversation_recovery.tick()
    assert cli.memory.get_statistics()["total_requests"] == 0
    assert cli.memory.get_recent_conversations() == []
    wire["clock"][0] = cli._conversation_recovery.schedule[JOB][0]
    cli._conversation_recovery.tick()
    _assert_saved_once(cli)
    assert wire["gets"] == 2 and wire["posts"] == wire["providers"] == 1
    assert CAPABILITY not in cli.console.file.getvalue()


@pytest.mark.parametrize("change", ["backend", "credential", "tamper"])
def test_restart_rejects_foreign_backend_or_tampered_coordinates_without_job_reads(recovery_profile, change):
    """Only matching authenticated backend coordinates can trigger automatic result reads."""
    make_cli, wire = recovery_profile
    first = make_cli()
    first.handle_ask("original question")
    if change == "tamper":
        ciphertext = bytearray(first._conversation_recovery.store.path.read_bytes())
        ciphertext[-20] ^= 0x40
        first._conversation_recovery.store.path.write_bytes(ciphertext)
        with pytest.raises(ContinuationStorageError):
            make_cli(instance="new-process-with-corrupt-store")
    else:
        kwargs = {"base_url": "https://another-backend.example.invalid"} if change == "backend" else {"credential": "synthetic-different-writing-auth-1234567890"}
        other = make_cli(instance="new-process-with-different-authority", **kwargs)
        other._conversation_recovery.tick()
        assert other._conversation_recovery.store.load() == []
    assert wire["gets"] == 0
    assert wire["posts"] == wire["providers"] == 1


def test_two_pending_questions_remain_isolated_and_secrets_stay_out_of_history(recovery_profile):
    """Resolve multiple original requests independently without leaking encrypted coordinates."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("first question")
    cli.handle_ask("second question")
    wire["states"][JOB] = ["completed"]
    wire["states"][OTHER_JOB] = ["completed"]
    wire["response_answer"] = ANSWER + "\nSynthetic sensitive capability " + CAPABILITY
    cli._conversation_recovery.tick()
    cli._conversation_recovery.tick()
    assert wire["posts"] == wire["providers"] == wire["gets"] == 2
    assert [row["user"] for row in cli.memory.get_recent_conversations()] == ["first question", "second question"]
    assert cli.memory.get_statistics()["total_requests"] == 2
    assert cli.rate_limiter.tokens_today == 34
    for path in Config.DATA_DIR.rglob("*"):
        if path.is_file():
            assert CAPABILITY.encode() not in path.read_bytes()
    assert CAPABILITY not in cli.console.file.getvalue()


@pytest.mark.parametrize("paused", ["identity", "stopped"])
def test_manual_resume_reports_paused_recovery_without_reading(recovery_profile, paused):
    """A diagnostic command must explain a denied read without revealing credentials."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    if paused == "identity":
        cli.backend_client._token_provider = lambda: "synthetic-changed-writing-authority-1234567890"
    else:
        cli._conversation_recovery.stop()
    cli.console.file.seek(0)
    cli.console.file.truncate(0)
    cli.handle_resume(JOB)
    assert "paused" in cli.console.file.getvalue().lower()
    assert CAPABILITY not in cli.console.file.getvalue()
    assert wire["gets"] == 0 and wire["posts"] == wire["providers"] == 1
    assert len(cli._conversation_recovery.store.load()) == 1


def test_manual_resume_reports_busy_job_without_duplicate_read(recovery_profile):
    """An already claimed original job gives feedback without launching another read."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    cli.console.file.seek(0)
    cli.console.file.truncate(0)
    with cli._conversation_recovery.store.claim(JOB) as claimed:
        assert claimed
        cli.handle_resume(JOB)
    assert "already being recovered" in cli.console.file.getvalue()
    assert wire["gets"] == 0 and wire["posts"] == wire["providers"] == 1
    assert cli.memory.get_recent_conversations() == []


def test_manual_resume_reports_record_that_disappears_after_claim(recovery_profile, monkeypatch):
    """A retired record is not silently represented as pending or completed work."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    monkeypatch.setattr(cli._conversation_recovery.store, "load", lambda: [])
    cli.console.file.seek(0)
    cli.console.file.truncate(0)
    cli.handle_resume(JOB)
    assert "no longer retained" in cli.console.file.getvalue()
    assert wire["gets"] == 0 and wire["posts"] == wire["providers"] == 1
    assert cli.memory.get_recent_conversations() == []


def test_every_manual_resume_reports_still_pending_result(recovery_profile):
    """Only automatic monitoring deduplicates notices; each explicit read gets a status."""
    make_cli, wire = recovery_profile
    cli = make_cli()
    cli.handle_ask("original question")
    wire["states"][JOB] = ["pending"]
    for expected_reads in (1, 2):
        cli.console.file.seek(0)
        cli.console.file.truncate(0)
        cli.handle_resume(JOB)
        assert "still pending" in cli.console.file.getvalue()
        assert wire["gets"] == expected_reads
        assert cli.memory.get_recent_conversations() == []
    assert wire["posts"] == wire["providers"] == 1
