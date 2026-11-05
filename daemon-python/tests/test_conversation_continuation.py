"""Foreground accepted-job delivery preserves generation, ownership and conversation sinks."""

from concurrent.futures import ThreadPoolExecutor
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
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    scenario["expire_during_get"] = True
    capsys.readouterr()
    cli.handle_resume(JOB)
    assert cli._trust_state.name == "DEGRADED"
    assert _execution_events(capsys.readouterr().out)[-1]["trust"] == "DEGRADED"
    assert scenario["posts"] == scenario["gets"] == 1


def test_bounded_private_contexts_prevent_more_acceptance_and_listing_never_reads(continuation_cli):
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
    cli, scenario, _, _ = continuation_cli
    cli.handle_ask("original question")
    cli.handle_ask("later question")
    cli.handle_resume(JOB)
    cli.memory.add_conversation.assert_called_once_with("original question", ANSWER, 17, 0.0123)


def test_capacity_does_not_block_existing_explicit_job_reads(continuation_cli, monkeypatch):
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
    cli, scenario, _, _ = continuation_cli
    if stage == "get":
        cli.handle_ask("original question")
    original_sender = cli.backend_client._request_sender

    def sender(method, url, **options):
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
    cli, _, _, _ = continuation_cli
    cli.handle_ask("original question")
    monkeypatch.setattr(Config, "BACKEND_SEND_UPDATES", True)
    monkeypatch.setattr(backend_ops, "send_backend_update", lambda *_: pytest.fail("update request"))
    cli.handle_resume(JOB)
    cli.memory.add_conversation.assert_called_once()
