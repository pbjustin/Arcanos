"""Two real Windows CLI consoles sharing one protected recovery profile."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from urllib.parse import urlsplit


def main() -> None:
    """Observe delivery ownership without replacing input, HTTP, authorization or recovery."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--daemon-root", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--sandbox", required=True)
    parser.add_argument("--mode", choices=("live", "same_session", "exit", "crash", "restart", "quota"), required=True)
    args = parser.parse_args()
    address = urlsplit(args.base_url)
    if os.name != "nt" or address.scheme != "http" or address.hostname != "127.0.0.1" or not address.port:
        raise RuntimeError("Native ownership acceptance requires an explicit loopback backend.")
    daemon = Path(args.daemon_root).resolve()
    sandbox = Path(args.sandbox).resolve()
    sys.path[:0] = [str(daemon / "scripts"), str(Path(__file__).resolve().parent)]
    from local_action_acceptance.common import clean_env, read_jsonl
    from local_action_acceptance.conpty import ConsoleProcess

    credentials = {label: os.environ[name] for label, name in (
        ("gpt", "ARCANOS_GPT_ACCESS_TOKEN"), ("daemon", "ARCANOS_DAEMON_ACCESS_TOKEN"),
        ("control", "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN"),
    )}
    profile = sandbox / "shared-profile"
    profile.mkdir(parents=True, exist_ok=True)
    consoles = {}
    roots = {}
    exits = {}
    closed = set()
    question = "what can u do?"
    answer_marker = "I can explain ideas and help you plan."

    def events(label):
        """Read only this real process's bounded observational events."""
        return read_jsonl(roots[label] / "observations.jsonl")

    def output(label):
        """Read producer output independently of ConPTY cursor redraws."""
        target = roots[label] / "printed-stdout.txt"
        observed = target.read_text(encoding="utf-8") if target.exists() else ""
        return observed + "\n" + consoles[label].transcript

    def wait(predicate, seconds=15):
        """Bound every terminal and lifecycle wait using the real monotonic clock."""
        deadline = time.monotonic() + seconds
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.02)
        if not predicate():
            raise TimeoutError("The native ownership observation did not complete.")

    def launch(label):
        """Launch the unchanged public CLI in a distinct actual Windows pseudo-console."""
        root = sandbox / label
        roots[label] = root
        env = clean_env(root, daemon.parent, args.base_url, extra={
            "BACKEND_TOKEN": credentials["gpt"], "ARCANOS_GPT_ACCESS_TOKEN": credentials["gpt"],
            "ARCANOS_DAEMON_ACCESS_TOKEN": credentials["daemon"],
            "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN": credentials["control"],
            "CONVERSATION_RECOVERY_ENABLED": "true", "SHOW_WELCOME": "false",
            "AGENTIC_ENABLED": "false", "REPO_INDEX_ENABLED": "false", "SHOW_STATS": "false",
            "BACKEND_REQUEST_TIMEOUT": "5", "BACKEND_FALLBACK_TO_LOCAL": "false",
            "TERM": "dumb", "NO_COLOR": "1", "COLUMNS": "240",
        })
        memory_name = "memory.json" if args.mode == "same_session" else "memory-" + label + ".json"
        env.update(DATA_DIR=str(profile), MEMORY_FILE=str(profile / memory_name),
                   HISTORY_DB_PATH=str(profile / "history.db"))
        if args.mode == "quota":
            env["MAX_REQUESTS_PER_HOUR"] = "1"
        env["PYTHONPATH"] += os.pathsep + str(Path(__file__).resolve().parent)
        for key in ("ACCEPTANCE_PYTHON_USER_SITE", "ACCEPTANCE_EXTRA_PYTHON_SITE"):
            if os.environ.get(key):
                env["PYTHONPATH"] += os.pathsep + os.environ[key]
        scenario = root / "scenario.json"
        scenario.write_text(json.dumps({"credentials": credentials, "heartbeat": False}), encoding="utf-8")
        env["ACCEPTANCE_NATIVE_SCENARIO"] = str(scenario)
        bootstrap = root / "observer.py"
        bootstrap.write_text('''from daemon_registry_client import install_native_observers
install_native_observers()
from contextlib import contextmanager
import hashlib,json,os,time
from pathlib import Path
from urllib.parse import urlsplit
from arcanos.cli.cli import ArcanosCLI
from arcanos.continuation_store import ContinuationStore,_current_user_sid
import requests
root=Path(os.environ["ACCEPTANCE_CASE_ROOT"])
def observe(event,**fields):
    with (root/"observations.jsonl").open("a",encoding="utf-8") as stream:
        stream.write(json.dumps({"event":event,"pid":os.getpid(),"at":time.monotonic(),**fields})+"\\n")
original_init=ArcanosCLI.__init__
def initialized(cli,*args,**kwargs):
    original_init(cli,*args,**kwargs)
    observe("owner_identity",session_hash=hashlib.sha256(cli.session.session_id.encode()).hexdigest(),sid_hash=hashlib.sha256(_current_user_sid().encode()).hexdigest())
ArcanosCLI.__init__=initialized
original_ask=ArcanosCLI.handle_ask
def asked(cli,*args,**kwargs):
    result=original_ask(cli,*args,**kwargs)
    observe("quota_observation",usage=cli.rate_limiter.get_usage_stats(),history_count=len(cli.memory.get_recent_conversations()))
    return result
ArcanosCLI.handle_ask=asked
original_claim=ContinuationStore.claim
@contextmanager
def claimed(store,job_id):
    with original_claim(store,job_id) as acquired:
        if job_id=="__monitor__" and acquired:
            observe("monitor_leader")
        yield acquired
ContinuationStore.claim=claimed
original_request=requests.Session.request
def requested(session,method,url,**options):
    if urlsplit(url).path.startswith("/jobs/"):
        observe("job_read_started")
    return original_request(session,method,url,**options)
requests.Session.request=requested
original_stop=ArcanosCLI._stop_conversation_recovery
def stopped(cli):
    observe("owner_stop_started")
    original_stop(cli)
    observe("owner_stopped")
ArcanosCLI._stop_conversation_recovery=stopped
''', encoding="utf-8")
        env["ACCEPTANCE_FAULT_BOOTSTRAP"] = str(bootstrap)
        (root / "profile/pyreadlineconfig.ini").write_text("disable_readline(True)\n", encoding="utf-8")
        child = ConsoleProcess([sys.executable, "-u", "-m", "arcanos.cli"], cwd=root, env=env, columns=240, rows=80)
        consoles[label] = child
        wait(lambda: any(event.get("event") == "builtins.input" for event in read_jsonl(root / "logs/network.jsonl")))
        return child

    def enter(label, text):
        """Type text and a separate genuine Enter key event through ConPTY."""
        consoles[label].send(text)
        time.sleep(0.1)
        consoles[label].send("\r")

    def close(label):
        """Exit cleanly while allowing any eligible remaining foreground process to recover."""
        if consoles[label].returncode is None:
            enter(label, "/exit")
        exits[label] = consoles[label].wait(timeout=10)

    failure = None
    try:
        if args.mode != "quota":
            launch("observer")
            # Establish the existing native leader before the submitter arrives.
            time.sleep(0.5)
        launch("origin")
        enter("origin", question)
        wait(lambda: any(event.get("event") == "accepted_response" for event in events("origin")))
        wait(lambda: sum(event.get("event") == "builtins.input" for event in read_jsonl(roots["origin"] / "logs/network.jsonl")) >= 2)
        if args.mode == "quota":
            enter("origin", "a second question while the original job is pending")
            wait(lambda: len([event for event in events("origin") if event.get("event") == "quota_observation"]) >= 2)
            wait(lambda: "Rate limit:" in output("origin"))
            (sandbox / "owner-provider-release").write_text("release", encoding="utf-8")
        elif args.mode not in ("live", "same_session"):
            if args.mode == "crash":
                consoles["origin"].close()
                closed.add("origin")
                exits["origin"] = "terminated_owned_console_job"
            else:
                close("origin")
            if args.mode == "restart":
                close("observer")
                (sandbox / "owner-provider-release").write_text("release", encoding="utf-8")
                launch("restarted")
            (sandbox / "owner-provider-release").write_text("release", encoding="utf-8")
        labels = tuple(consoles)
        wait(lambda: any(answer_marker in output(label) for label in labels))
        time.sleep(0.3)
    except Exception as error:
        failure = {"type": type(error).__name__, "message": str(error)}
    finally:
        for label, child in consoles.items():
            if label in closed:
                continue
            try:
                if child.returncode is None:
                    close(label)
            finally:
                child.close()

    receipt = {"mode": args.mode, "failure": failure, "actual_public_entrypoint": True,
               "actual_conpty_processes": len(consoles), "exits": exits, "processes": {}}
    for label, child in consoles.items():
        process_events = events(label)
        audit_path = roots[label] / "audit-producer-output.txt"
        audits = [json.loads(line.removeprefix("[AUDIT] ")) for line in audit_path.read_text(encoding="utf-8").splitlines()] if audit_path.exists() else []
        receipt["processes"][label] = {"events": process_events, "stdout": output(label),
            "answer_displayed": answer_marker in output(label), "audits": audits,
            "job_reads": sum(event.get("event") == "job_read_started" for event in process_events),
            "recovery_successes": sum(event.get("event") == "execute_success" and event.get("command") == "conversation_recovery" for event in audits)}
    # Early console failures can precede SQLite initialization. Preserve that
    # primary failure; unavailable history is not evidence of zero saved turns.
    receipt["history"] = None
    receipt["durable_successes"] = None
    receipt["history_failure"] = None
    history_path = profile / "history.db"
    if failure is None or history_path.exists():
        try:
            with sqlite3.connect(history_path) as connection:
                rows = connection.execute("SELECT session_id,user_text,answer_text,tokens,cost,displayed FROM conversation_deliveries").fetchall()
                receipt["history"] = [{"session_hash": hashlib.sha256(row[0].encode()).hexdigest(),
                    "user": row[1], "ai": row[2], "tokens": row[3], "cost": row[4], "displayed": bool(row[5])} for row in rows]
                receipt["durable_successes"] = connection.execute("SELECT COUNT(*) FROM policy_events WHERE event='conversation.completed'").fetchone()[0]
        except sqlite3.Error as error:
            if failure is None:
                raise
            receipt["history_failure"] = {"type": type(error).__name__, "message": "Recovery history evidence is unavailable."}
    combined = json.dumps(receipt, ensure_ascii=False)
    receipt["credential_leaks"] = any(value in combined for value in credentials.values())
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == "__main__":
    main()
