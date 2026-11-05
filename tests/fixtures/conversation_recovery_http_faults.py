"""Real loopback HTTP, DPAPI and SQLite recovery faults; no provider or device I/O.

The native ConPTY harness covers the public entrypoint separately. This fixture
injects only local completion-commit/render failures and starts fresh CLI objects
without installed profiles, startup services, actions, summaries or audio devices.
"""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import site
import sqlite3
import sys
import threading
import time
from urllib.parse import urlsplit


def main(startup_diagnostics: io.StringIO) -> dict:
    """Run one bounded fault phase; a later process can use the same protected profile."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True,
                        choices=("duplicate_worker", "before_commit", "after_commit", "partial_render", "recover"))
    parser.add_argument("--daemon-root", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    address = urlsplit(args.base_url)
    if os.name != "nt" or address.scheme != "http" or address.hostname != "127.0.0.1" or not address.port:
        raise RuntimeError("This fixture requires native Windows and an explicit loopback backend.")
    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ.update(DATA_DIR=str(data_dir), MEMORY_FILE=str(data_dir / "memory.json"),
                      HISTORY_DB_PATH=str(data_dir / "history.db"), LOG_DIR=str(data_dir / "logs"),
                      DEBUG_LOG_PATH=str(data_dir / "logs/debug.log"), BACKEND_ALLOW_HTTP="true")
    user_site = os.environ.get("ACCEPTANCE_PYTHON_USER_SITE")
    if user_site:
        site.addsitedir(user_site)
    extra_site = os.environ.get("ACCEPTANCE_EXTRA_PYTHON_SITE")
    if extra_site:
        site.addsitedir(extra_site)
    sys.path.insert(0, args.daemon_root)
    import arcanos.env as runtime_env

    # Do not inspect or override the operator's installed .env or runtime state.
    runtime_env._BOOTSTRAPPED = True
    runtime_env._BASE_DIR = data_dir
    import requests
    from rich.console import Console
    from arcanos.backend_client import BackendApiClient
    from arcanos.cli import cli as cli_module, state
    from arcanos.cli.conversation_recovery import ConversationRecovery
    from arcanos.cli_session import SessionContext
    from arcanos.config import Config
    from arcanos.rate_limiter import RateLimiter
    from arcanos.schema import Memory

    credentials = [os.environ.get(name, "") for name in (
        "ARCANOS_GPT_ACCESS_TOKEN", "ARCANOS_DAEMON_ACCESS_TOKEN", "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN")]
    if any(not value for value in credentials) or len(set(credentials)) != 3:
        raise RuntimeError("Purpose-distinct synthetic fixture credentials are required.")
    for key, value in {
        "DATA_DIR": data_dir, "MEMORY_FILE": data_dir / "memory.json", "HISTORY_DB_PATH": data_dir / "history.db",
        "LOG_DIR": data_dir / "logs", "DEBUG_LOG_PATH": data_dir / "logs/debug.log",
        "CONTROL_PLANE_ACCESS_TOKEN": credentials[2], "DAEMON_ACCESS_TOKEN": credentials[1],
        "BACKEND_ALLOW_GPT_ID_AUTH": False, "BACKEND_ALLOW_HTTP": True,
        "BACKEND_FALLBACK_TO_LOCAL": False, "BACKEND_SEND_UPDATES": False,
        "AGENTIC_ENABLED": False, "STREAM_RESPONSES": False, "SPEAK_RESPONSES": False,
        "REPO_INDEX_ENABLED": False, "SHOW_STATS": False, "CONVERSATION_RECOVERY_ENABLED": True,
    }.items():
        setattr(Config, key, value)

    def forbidden(*_args, **_kwargs):
        """Any recovery fallback, summary or speech is an acceptance failure."""
        raise AssertionError("Unexpected provider, action, summary or speech in recovery fixture.")

    cli_module.local_ops.perform_local_conversation = forbidden
    cli_module.memory_ops.update_short_term_summary = forbidden
    request_counts = {"generation_posts": 0, "result_gets": 0, "second_worker_gets": 0}
    request_lock = threading.Lock()
    captured = io.StringIO()
    capabilities = set()
    controllers = []

    def make_cli(label):
        """Use actual client requests, protected records, memory and quota accounting."""
        def sender(method, url, **options):
            """Permit only real HTTP to this controlled server and count its operations."""
            parsed = urlsplit(url)
            if (parsed.scheme, parsed.netloc) != (address.scheme, address.netloc):
                raise AssertionError("Recovery attempted an unexpected backend.")
            with request_lock:
                if method.lower() == "post" and parsed.path == "/gpt/arcanos-daemon":
                    request_counts["generation_posts"] += 1
                elif method.lower() == "get" and parsed.path.startswith("/jobs/"):
                    request_counts["result_gets"] += 1
                    request_counts["second_worker_gets"] += int(label == "second")
                    if options.get("timeout", 100) > 2 or parsed.query:
                        raise AssertionError("Recovery read exceeded its supported bounds.")
                elif parsed.path not in ("/system-state", "/api/daemon/registry"):
                    raise AssertionError("Recovery attempted an unexpected operation.")
            options["allow_redirects"] = False
            return requests.request(method, url, **options)

        cli = cli_module.ArcanosCLI.__new__(cli_module.ArcanosCLI)
        cli.console = Console(file=io.StringIO(), width=240, color_system=None, force_terminal=False)
        cli.backend_client = BackendApiClient(args.base_url, lambda: credentials[0], timeout_seconds=5,
                                             request_sender=sender, daemon_access_token_provider=lambda: credentials[1])
        state.initialize_runtime_state(cli)
        cli.instance_id, cli.client_id = f"fresh-http-fixture-{os.getpid()}-{label}", "recovery-http-fault-fixture"
        cli.session = SessionContext(session_id=cli.instance_id)
        cli.memory = Memory(Config.MEMORY_FILE)
        cli.rate_limiter = RateLimiter()
        cli.audio = type("NoSpeech", (), {"speak": staticmethod(forbidden)})()
        cli._append_activity = lambda *_args, **_kwargs: None
        cli._last_response = None
        cli._conversation_recovery = None
        cli.system_prompt = state.build_system_prompt(cli)
        cli._conversation_recovery = ConversationRecovery(cli)
        controllers.append(cli._conversation_recovery)
        capabilities.update(record["job_read_token"] for record in cli._conversation_recovery.store.load())
        return cli

    def wait_until(predicate, seconds=15):
        """Fail predictably if the real recovery worker or HTTP server cannot complete."""
        deadline = time.monotonic() + seconds
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.025)
        if not predicate():
            raise AssertionError("Bounded recovery fixture did not reach its expected state.")

    fault = {"triggered": False}
    with redirect_stdout(captured):
        cli = make_cli("first")
        controller = cli._conversation_recovery
        if args.mode == "recover" and len(controller.store.load()) != 1:
            raise AssertionError("Fresh-process recovery requires one original protected job.")
        if args.mode != "recover":
            cli.handle_ask("what can u do?")
            records = controller.store.load()
            if len(records) != 1:
                raise AssertionError("The original HTTP request did not retain exactly one accepted job.")
            capabilities.update(record["job_read_token"] for record in records)

        if args.mode == "duplicate_worker":
            second = make_cli("second")
            controller.start()
            wait_until(lambda: request_counts["result_gets"] >= 1)
            second._conversation_recovery.start()
            wait_until(lambda: not controller.store.load())
        elif args.mode == "recover":
            controller.tick()
            if controller.store.load():
                raise AssertionError("Existing completed work did not recover in one bounded read.")
        else:
            if args.mode == "before_commit":
                database = cli.memory._recovery_history(create=True)

                class InterruptedConnection(sqlite3.Connection):
                    """Crash after history/totals writes but before the transaction's audit write."""

                    def execute(self, statement, parameters=()):
                        if "INSERT INTO policy_events" in statement:
                            fault["triggered"] = True
                            raise sqlite3.OperationalError("Synthetic interrupted completion transaction.")
                        return super().execute(statement, parameters)

                database._conn = lambda: sqlite3.connect(str(Config.HISTORY_DB_PATH), factory=InterruptedConnection)
            elif args.mode == "after_commit":
                record_completed = cli.memory.record_recovered_conversation

                def interrupted_after_commit(*values, **fields):
                    """Leave the actual committed SQL receipt and protected pending record intact."""
                    record_completed(*values, **fields)
                    fault["triggered"] = True
                    raise RuntimeError("Synthetic process loss after completion commit.")

                cli.memory.record_recovered_conversation = interrupted_after_commit
            else:
                def interrupted_render(_cli, text, **_fields):
                    """Write real initial output bytes before simulating terminal failure."""
                    cli.console.print(text[:20], markup=False)
                    fault["triggered"] = True
                    raise RuntimeError("Synthetic process loss during terminal output.")

                cli_module.ui_ops.speak_to_user = interrupted_render
            deadline = time.monotonic() + 15
            while not fault["triggered"] and time.monotonic() < deadline:
                controller.tick()
                time.sleep(0.025)
            if not fault["triggered"]:
                raise AssertionError("The controlled local failure was never reached.")

        for active in controllers:
            active.stop()
        history = cli.memory.get_recent_conversations(limit=20)
        statistics = cli.memory.get_statistics()
        pending_count = len(controller.store.load())

    displayed_count = durable_audits = 0
    if Config.HISTORY_DB_PATH.exists():
        with sqlite3.connect(Config.HISTORY_DB_PATH) as connection:
            displayed_count = connection.execute("SELECT COUNT(*) FROM conversation_deliveries WHERE displayed=1").fetchone()[0]
            durable_audits = connection.execute("SELECT COUNT(*) FROM policy_events WHERE event='conversation.completed'").fetchone()[0]
    audit_events = []
    for line in captured.getvalue().splitlines():
        try:
            event = json.loads(line.removeprefix("[AUDIT] "))
        except ValueError:
            continue
        if isinstance(event, dict):
            audit_events.append(event)
    rendered = cli.console.file.getvalue()
    private_markers = [value.encode("utf-8") for value in (*credentials, *capabilities)]
    no_leaks = all(not any(marker in path.read_bytes() for marker in private_markers)
                   for path in data_dir.rglob("*") if path.is_file())
    diagnostics = startup_diagnostics.getvalue()
    no_leaks = no_leaks and all(marker.decode("utf-8") not in rendered + captured.getvalue() + diagnostics
                               for marker in private_markers)
    return {"mode": args.mode, "process_id": os.getpid(), **request_counts,
                      "fault_triggered": fault["triggered"], "history": history, "statistics": statistics,
                      "pending_count": pending_count, "displayed_count": displayed_count,
                      "limiter_tokens_today": cli.rate_limiter.tokens_today,
                      "limiter_cost_today": cli.rate_limiter.cost_today,
                      "durable_completion_audits": durable_audits,
                      "console_success_audits": sum(event.get("event") == "execute_success"
                                                    and event.get("command") == "conversation_recovery" for event in audit_events),
                      "rendered_output": rendered, "no_capability_leaks": no_leaks,
                      "startup_diagnostics_present": bool(diagnostics)}


if __name__ == "__main__":
    startup_output = io.StringIO()
    with redirect_stdout(startup_output):
        receipt = main(startup_output)
    print(json.dumps(receipt, ensure_ascii=False))
