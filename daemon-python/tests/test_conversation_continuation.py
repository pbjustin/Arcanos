"""Foreground accepted-job delivery preserves generation, ownership and conversation sinks."""

from concurrent.futures import ThreadPoolExecutor
import json
from threading import Event
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
import requests

from arcanos.cli import backend_ops, cli as cli_module
from arcanos.cli_runner import _dispatch_command, process_input
from arcanos.config import Config
from arcanos.cli.memory_ops import record_conversation_turn as record_actual_turn
from .test_cli_diagnostic_audit import diagnostic_cli, _execution_events, _response


JOB = "1e825578-e8f2-4711-974d-e544604595d7"
OTHER_JOB = "c1e8764b-aec0-4ddf-b64b-a762182b47be"
TOKEN = "v1." + "C" * 43
ANSWER = "Here is the original **complete answer**.\n\n```python\nprint('café 雪')\n```"


def accepted(job_id=JOB):
    """Use the current queued GPT wire shape, including its header-only capability."""
    return {"ok": True, "status": "timeout", "jobId": job_id, "result": {},
            "poll": f"/jobs/{job_id}/result", "jobReadToken": TOKEN,
            "jobReadTokenHeader": "x-arcanos-job-read-token"}


def completed(job_id=JOB):
    """Mirror the generic jobs API's stored dispatcher envelope and known usage."""
    return {"jobId": job_id, "status": "completed", "jobStatus": "completed",
            "result": {"ok": True, "_route": {"gptId": "arcanos-daemon"},
                       "result": {"response": ANSWER, "tokens": 17, "cost": 0.0123,
                                  "model": "controlled-provider"}}}


@pytest.fixture
def continuation_cli(diagnostic_cli, monkeypatch):
    """Keep the actual client, orchestration, translator and memory writer with fixture HTTP."""
    cli, scenario, observed, clock = diagnostic_cli
    original_sender = cli.backend_client._request_sender
    scenario.update(accepted=accepted(), lookup=completed(), lookup_http=200, gets=0, posts=0)
    monkeypatch.setattr(Config, "SHOW_STATS", False)
    monkeypatch.setattr(Config, "BACKEND_FALLBACK_TO_LOCAL", True)
    monkeypatch.setattr(cli_module.memory_ops, "record_conversation_turn", record_actual_turn)
    # Any inference, auth refresh, action or summary during continuation is a test failure.
    monkeypatch.setattr(backend_ops, "refresh_backend_credentials", lambda *_: pytest.fail("credential refresh"))
    monkeypatch.setattr(cli_module.memory_ops, "update_short_term_summary", lambda *_: pytest.fail("paid summary"))

    def sender(method, url, **options):
        """Count real client HTTP operations without recording bearer values in receipts."""
        path = urlsplit(url).path
        if path.startswith("/gpt/"):
            assert method == "post"
            scenario["posts"] += 1
            observed.append((method, path))
            body = scenario["accepted"]
            if callable(body):
                body = body(options["json"])
            return _response(202, body)
        if path.startswith("/jobs/"):
            assert method == "get" and options["json"] is None
            assert options["headers"]["x-arcanos-job-read-token"] == TOKEN
            assert TOKEN not in url
            scenario["gets"] += 1
            observed.append((method, path))
            if scenario.get("expire_during_get"):
                clock[0] += cli._registry_cache_ttl_seconds + 1
            if scenario.get("transport_failure"):
                raise requests.Timeout("synthetic timeout " + TOKEN)
            body = scenario["lookup"]
            return _response(scenario["lookup_http"], body(path) if callable(body) else body)
        return original_sender(method, url, **options)

    cli.backend_client._request_sender = sender
    return cli, scenario, observed, clock


def test_original_answer_delivered_once_with_original_history_usage_and_audit(continuation_cli, capsys):
    """Deliver and account for the original answer once without replaying its generation."""
    cli, scenario, observed, _ = continuation_cli
    cli.handle_ask("what can u do?")
    cli.memory.add_conversation.assert_not_called()
    assert scenario["posts"] == 1 and scenario["gets"] == 0
    pending_events = _execution_events(capsys.readouterr().out)
    assert pending_events[-1]["event"] == "execute_unconfirmed"
    assert JOB in cli._pending_backend_conversations
    assert TOKEN not in repr(cli._pending_backend_conversations)
    before = len(observed)
    _dispatch_command(cli, "resume " + JOB)
    assert observed[before:] == [("get", f"/jobs/{JOB}/result")]
    cli.memory.add_conversation.assert_called_once_with("what can u do?", ANSWER, 17, 0.0123)
    cli.rate_limiter.record_request.assert_called_once_with(17, 0.0123)
    assert cli._last_response == ANSWER
    events = _execution_events(capsys.readouterr().out)
    assert [e["event"] for e in events] == ["execute_attempt", "execute_success"]
    assert all(e["command"] == "resume" for e in events)
    assert events[-1]["job_id"] == JOB
    for dispatch in (_dispatch_command, process_input):
        dispatch(cli, ("resume " if dispatch is _dispatch_command else "/resume ") + JOB)
    assert scenario["posts"] == scenario["gets"] == 1
    cli.memory.add_conversation.assert_called_once()
    assert not cli._pending_backend_conversations
    assert TOKEN not in cli.console.file.getvalue() + capsys.readouterr().out


@pytest.mark.parametrize("status,job_status,word", [
    ("pending", "running", "pending"), ("failed", "failed", "failed"),
    ("failed", "cancelled", "cancelled"), ("expired", "expired", "expired"),
    ("not_found", None, "unavailable"),
])
def test_nonanswers_never_create_history_success_or_fallback(continuation_cli, capsys, status, job_status, word):
    """Keep pending and terminal failure states distinct from completed conversations."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    capsys.readouterr()
    scenario["lookup"] = {"jobId": JOB, "status": status, "jobStatus": job_status,
                          "result": {"response": "Tempting nonterminal text"}, "error": {"message": TOKEN}}
    cli.handle_resume(JOB)
    cli.memory.add_conversation.assert_not_called()
    assert word in cli.console.file.getvalue().lower()
    assert TOKEN not in cli.console.file.getvalue()
    events = _execution_events(capsys.readouterr().out)
    assert not any(e["event"] == "execute_success" for e in events)
    assert (JOB in cli._pending_backend_conversations) is (status == "pending")
    assert scenario["posts"] == scenario["gets"] == 1


@pytest.mark.parametrize("fault", ["http401", "http403", "http503", "timeout", "wrong_job", "empty", "incomplete"])
def test_read_errors_fail_closed_without_retry_or_sensitive_error_disclosure(continuation_cli, capsys, fault):
    """Withhold invalid reads and redact errors without retrying or invoking fallback."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    capsys.readouterr()
    if fault.startswith("http"):
        scenario["lookup_http"] = int(fault[4:])
        scenario["lookup"] = {"error": TOKEN}
    elif fault == "timeout":
        scenario["transport_failure"] = True
    elif fault == "wrong_job":
        scenario["lookup"] = completed(OTHER_JOB)
    elif fault == "empty":
        scenario["lookup"]["result"]["result"] = {}
    else:
        scenario["lookup"]["result"]["result"]["incomplete"] = True
    cli.handle_resume(JOB)
    cli.memory.add_conversation.assert_not_called()
    assert scenario["gets"] == scenario["posts"] == 1
    output = cli.console.file.getvalue() + capsys.readouterr().out
    assert TOKEN not in output
    assert not any(e["event"] == "execute_success" for e in _execution_events(output))


@pytest.mark.parametrize("fault", ["missing_token", "invalid_token", "missing_id", "unsafe_url"])
def test_202_without_safe_coordinates_remains_unconfirmed(continuation_cli, capsys, fault):
    """Reject unusable accepted-job coordinates before result transport or completion."""
    cli, scenario, _, _ = continuation_cli
    if fault == "missing_token":
        del scenario["accepted"]["jobReadToken"]
    elif fault == "invalid_token":
        scenario["accepted"]["jobReadToken"] = "invalid"
    elif fault == "missing_id":
        del scenario["accepted"]["jobId"]
    else:
        scenario["accepted"]["poll"] = "https://another.example.invalid/jobs/" + JOB
    cli.handle_ask("original question")
    cli.handle_resume(JOB)
    assert not cli._pending_backend_conversations
    assert scenario["posts"] == 1 and scenario["gets"] == 0
    cli.memory.add_conversation.assert_not_called()
    assert not any(e["event"] == "execute_success" for e in _execution_events(capsys.readouterr().out))


@pytest.mark.parametrize("owner_change", ["instance", "session", "client"])
def test_another_session_or_client_cannot_use_a_retained_handle(continuation_cli, owner_change):
    """Bind private continuation use to its originating client, instance and session."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    if owner_change == "instance":
        cli.instance_id = "another-instance"
    elif owner_change == "session":
        cli.session.session_id = "another-session"
    else:
        cli.backend_client = object()
    cli.handle_resume(JOB)
    assert scenario["gets"] == 0
    cli.memory.add_conversation.assert_not_called()


def test_two_overlapping_questions_and_concurrent_replay_keep_their_owners(continuation_cli):
    """Keep overlapping questions paired with their own answers and consume each once."""
    cli, scenario, _, _ = continuation_cli
    question_jobs = {"first question": JOB, "second question": OTHER_JOB}
    scenario["accepted"] = lambda body: accepted(question_jobs[body["prompt"]])
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(cli.handle_ask, question_jobs))
    scenario["lookup"] = lambda path: completed(path.split("/")[2])
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(cli.handle_resume, [OTHER_JOB, OTHER_JOB]))
    cli.handle_resume(JOB)
    assert scenario["posts"] == scenario["gets"] == 2
    assert [call.args[:2] for call in cli.memory.add_conversation.call_args_list] == [
        ("second question", ANSWER), ("first question", ANSWER),
    ]


def test_expired_full_trust_does_not_refresh_authority_or_authorize_actions(continuation_cli, capsys):
    """Read an accepted answer without refreshing expired trust or granting action authority."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    scenario["expire_during_get"] = True
    capsys.readouterr()
    cli.handle_resume(JOB)
    assert cli._trust_state.name == "DEGRADED"
    assert _execution_events(capsys.readouterr().out)[-1]["trust"] == "DEGRADED"
    assert scenario["posts"] == scenario["gets"] == 1


def test_bounded_private_contexts_prevent_more_acceptance_and_listing_never_reads(continuation_cli):
    """Bound accepted work while allowing a private ID listing without any result GET."""
    cli, scenario, _, _ = continuation_cli
    ids = [f"00000000-0000-4000-8000-{i:012d}" for i in range(cli_module.MAX_PENDING_CONVERSATIONS)]
    for job_id in ids:
        scenario["accepted"] = accepted(job_id)
        cli.handle_ask("original question")
    cli.handle_ask("must not create another job")
    cli.handle_resume()
    assert len(cli._pending_backend_conversations) == cli_module.MAX_PENDING_CONVERSATIONS
    assert scenario["posts"] == cli_module.MAX_PENDING_CONVERSATIONS
    assert scenario["gets"] == 0
    assert TOKEN not in cli.console.file.getvalue()


def test_duplicate_accepted_job_does_not_replace_original_question(continuation_cli):
    """Keep the first question associated with a deduplicated accepted job."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    cli.handle_ask("later question")
    cli.handle_resume(JOB)
    cli.memory.add_conversation.assert_called_once_with("original question", ANSWER, 17, 0.0123)


def test_capacity_does_not_block_existing_explicit_job_reads(continuation_cli, monkeypatch):
    """Keep existing non-generating job reads available at full continuation capacity."""
    cli, scenario, _, _ = continuation_cli
    monkeypatch.setattr(Config, "ARCANOS_JOB_READ_TOKEN", TOKEN)
    for number in range(cli_module.MAX_PENDING_CONVERSATIONS):
        scenario["accepted"] = accepted(f"00000000-0000-4000-8000-{number:012d}")
        cli.handle_ask("original question")
    result = backend_ops.perform_backend_conversation(cli, f"GET /jobs/{JOB}/result")
    assert result.model == "backend-jobs"
    assert scenario["posts"] == cli_module.MAX_PENDING_CONVERSATIONS
    assert scenario["gets"] == 1
    assert len(cli._pending_backend_conversations) == cli_module.MAX_PENDING_CONVERSATIONS


def test_translator_withheld_result_never_records_resume_success(continuation_cli, capsys):
    """Persist only the translator-approved text and never report withheld text as success."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    scenario["lookup"]["result"]["result"]["response"] = '<vbl severity="3" />\nprivate-audit-fixture'
    capsys.readouterr()
    cli.handle_resume(JOB)
    assert cli.memory.add_conversation.call_args.args[1] == ""
    assert not any(e["event"] == "execute_success" for e in _execution_events(capsys.readouterr().out))


@pytest.mark.parametrize("stage", ["post", "get"])
@pytest.mark.parametrize("owner_change", ["instance", "session", "client"])
def test_ownership_cannot_change_while_http_is_inflight(continuation_cli, stage, owner_change):
    """Fail closed when an original POST or result GET outlives its owner's identity."""
    cli, scenario, _, _ = continuation_cli
    if stage == "get":
        cli.handle_ask("original question")
    original_sender = cli.backend_client._request_sender

    def sender(method, url, **options):
        """Change ownership after real transport returns to expose response-time races."""
        response = original_sender(method, url, **options)
        if method == stage:
            if owner_change == "instance":
                cli.instance_id = "another-instance"
            elif owner_change == "session":
                cli.session.session_id = "another-session"
            else:
                cli.backend_client = object()
        return response

    cli.backend_client._request_sender = sender
    if stage == "post":
        cli.handle_ask("original question")
        assert not cli._pending_backend_conversations
    else:
        cli.handle_resume(JOB)
    cli.memory.add_conversation.assert_not_called()
    assert scenario["posts"] == 1
    assert scenario["gets"] == (1 if stage == "get" else 0)


def test_resume_never_sends_usage_updates_or_requests_a_summary(continuation_cli, monkeypatch):
    """Keep continuation retrieval free of update POSTs and summary inference."""
    cli, _, _, _ = continuation_cli
    cli.handle_ask("original question")
    monkeypatch.setattr(Config, "BACKEND_SEND_UPDATES", True)
    monkeypatch.setattr(backend_ops, "send_backend_update", lambda *_: pytest.fail("update request"))
    cli.handle_resume(JOB)
    cli.memory.add_conversation.assert_called_once()


@pytest.mark.parametrize("fault", ["malformed_json", "nonobject", "wrong_job"])
def test_explicit_retry_after_parse_failure_preserves_original_answer(continuation_cli, monkeypatch, fault):
    """Retain a readable job after a bad transport body and retry only on explicit input."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    original_sender = cli.backend_client._request_sender

    def invalid_json():
        """Simulate a truncated JSON response independently of the durable job state."""
        return json.loads("not json")

    def sender(method, url, **options):
        """Count the original GET before substituting its malformed response body."""
        response = original_sender(method, url, **options)
        if urlsplit(url).path.startswith("/jobs/"):
            if fault == "malformed_json":
                return SimpleNamespace(status_code=200, headers={}, text=TOKEN, json=invalid_json)
            if fault == "nonobject":
                return _response(200, [TOKEN])
            return _response(200, completed(OTHER_JOB))
        return response

    with monkeypatch.context() as patch:
        patch.setattr(cli.backend_client, "_request_sender", sender)
        cli.handle_resume(JOB)
    assert JOB in cli._pending_backend_conversations
    cli.memory.add_conversation.assert_not_called()
    assert scenario["gets"] == 1 and scenario["posts"] == 1
    cli.handle_resume(JOB)
    cli.handle_resume(JOB)
    assert scenario["gets"] == 2 and scenario["posts"] == 1
    cli.memory.add_conversation.assert_called_once_with("original question", ANSWER, 17, 0.0123)
    assert TOKEN not in cli.console.file.getvalue()


@pytest.mark.parametrize("stage", ["translate", "render", "partial_render"])
def test_delivery_failure_before_recording_retains_manual_retry(continuation_cli, monkeypatch, capsys, stage):
    """Restore only unrecorded delivery, allowing explicit retry after partial terminal output."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    capsys.readouterr()

    def fail_delivery(*args, **kwargs):
        """Raise at a controlled display boundary, optionally after partial terminal output."""
        if stage == "partial_render":
            cli.console.print("Partial display before the synthetic render failure.")
        raise RuntimeError("synthetic delivery failure")

    with monkeypatch.context() as patch:
        if stage == "translate":
            patch.setattr(cli_module, "translate", fail_delivery)
        else:
            patch.setattr(cli_module.ui_ops, "speak_to_user", fail_delivery)
        cli.handle_resume(JOB)
    assert JOB in cli._pending_backend_conversations
    cli.memory.add_conversation.assert_not_called()
    cli.rate_limiter.record_request.assert_not_called()
    assert not any(e["event"] == "execute_success" for e in _execution_events(capsys.readouterr().out))
    assert scenario["gets"] == 1 and scenario["posts"] == 1
    cli.handle_resume(JOB)
    cli.handle_resume(JOB)
    assert scenario["gets"] == 2 and scenario["posts"] == 1
    cli.memory.add_conversation.assert_called_once_with("original question", ANSWER, 17, 0.0123)
    cli.rate_limiter.record_request.assert_called_once_with(17, 0.0123)


@pytest.mark.parametrize("stage", ["limiter", "memory", "after_record"])
def test_recording_boundary_failure_never_restores_duplicate_turn(continuation_cli, monkeypatch, stage):
    """Consume a delivery once accounting/persistence starts, even if later bookkeeping fails."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")

    def fail_bookkeeping(*args, **kwargs):
        """Raise at the selected potentially non-atomic accounting or persistence boundary."""
        raise RuntimeError("synthetic bookkeeping failure")

    if stage == "limiter":
        monkeypatch.setattr(cli.rate_limiter, "record_request", fail_bookkeeping)
    elif stage == "memory":
        cli.memory.add_conversation.side_effect = fail_bookkeeping
    else:
        monkeypatch.setattr(cli_module.memory_ops, "remember_last_response", fail_bookkeeping)
    cli.handle_resume(JOB)
    assert JOB not in cli._pending_backend_conversations
    saves = cli.memory.add_conversation.call_count
    cli.handle_resume(JOB)
    assert cli.memory.add_conversation.call_count == saves
    assert scenario["gets"] == 1 and scenario["posts"] == 1


def test_optional_stats_failure_does_not_contradict_recorded_success(continuation_cli, monkeypatch, capsys):
    """Keep a completed delivery's success intact if optional post-completion stats fail."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    monkeypatch.setattr(Config, "SHOW_STATS", True)
    cli.memory.get_statistics.side_effect = RuntimeError("synthetic stats failure")
    capsys.readouterr()
    cli.handle_resume(JOB)
    outcomes = [event["event"] for event in _execution_events(capsys.readouterr().out)]
    assert outcomes == ["execute_attempt", "execute_success"]
    cli.memory.add_conversation.assert_called_once()
    cli.handle_resume(JOB)
    assert scenario["gets"] == 1 and scenario["posts"] == 1


def test_ordinary_completion_and_resume_serialize_history_writes(continuation_cli, monkeypatch):
    """Allow concurrent generation while serializing ordinary and resumed memory saves."""
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    normal_ready, release_normal = Event(), Event()
    resume_recording, release_resume, ordinary_recording = Event(), Event(), Event()
    original_perform = backend_ops.perform_backend_conversation

    def perform(*args, **kwargs):
        """Pause ordinary completion after backend work has released its admission reservation."""
        result = original_perform(*args, **kwargs)
        normal_ready.set()
        assert release_normal.wait(5)
        return result

    def record(cli_arg, message, *args):
        """Keep the resumed save open to detect any overlapping ordinary memory write."""
        if message == "original question":
            resume_recording.set()
            assert release_resume.wait(5)
        else:
            ordinary_recording.set()
        return record_actual_turn(cli_arg, message, *args)

    # A real synchronous result still goes through the normal CLI completion path.
    monkeypatch.setattr(cli.backend_client, "request_chat_completion", lambda **_: cli.backend_client._parse_chat_response({"response": "ordinary answer"}))
    monkeypatch.setattr(backend_ops, "perform_backend_conversation", perform)
    monkeypatch.setattr(cli_module.memory_ops, "record_conversation_turn", record)
    monkeypatch.setattr(cli_module.memory_ops, "update_short_term_summary", lambda *_: None)
    with ThreadPoolExecutor(max_workers=2) as pool:
        normal = pool.submit(cli.handle_ask, "ordinary question")
        resumed = None
        try:
            assert normal_ready.wait(5)
            resumed = pool.submit(cli.handle_resume, JOB)
            assert resume_recording.wait(5)
            release_normal.set()
            overlapping_save = ordinary_recording.wait(0.2)
        finally:
            release_normal.set()
            release_resume.set()
        normal.result(timeout=5)
        if resumed is not None:
            resumed.result(timeout=5)
    assert not overlapping_save
    assert [call.args[:2] for call in cli.memory.add_conversation.call_args_list] == [
        ("original question", ANSWER), ("ordinary question", "ordinary answer"),
    ]
