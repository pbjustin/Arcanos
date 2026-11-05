"""Provider-free registry and public CLI acceptance against a loopback Express server."""

from dataclasses import is_dataclass
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from urllib.parse import urlsplit


def canonical_marker_text(value: str) -> str:
    """Compare synthetic markers across terminal ANSI decoration and invisible separators."""
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    return re.sub(r"[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]", "", value)


def registry_client(daemon_root: str, base_url: str, count: int) -> None:
    """Preserve the original direct-client HTTP matrix without loading operator profiles."""
    sys.path.insert(0, daemon_root)
    import arcanos.env as runtime_env

    runtime_env._BOOTSTRAPPED = True
    runtime_env._BASE_DIR = Path(os.environ["DATA_DIR"])
    from arcanos.backend_client import BackendApiClient
    from arcanos.config import Config

    def unrelated_credential():
        """Fail if registry transport attempts to borrow another credential purpose."""
        raise AssertionError("Registry reads must not select unrelated credentials")

    client = BackendApiClient(
        base_url, unrelated_credential, timeout_seconds=5,
        daemon_access_token_provider=lambda: Config.DAEMON_ACCESS_TOKEN,
    )
    results = []
    for _ in range(count):
        response = client.request_registry()
        results.append({
            "ok": response.ok,
            "kind": response.error.kind if response.error else None,
            "status": response.error.status_code if response.error else None,
            "version": response.value.get("version") if response.value else None,
        })
    print(json.dumps(results))


def install_native_observers() -> None:
    """Observe the public child; inject labeled clock/input faults without replacing security logic."""
    import atexit
    import builtins
    import requests
    from arcanos.audio import AudioSystem
    from arcanos.cli import backend_ops, local_ops, state, ui_ops
    from arcanos.cli.cli import ArcanosCLI
    from arcanos import interactive_input as terminal_input

    root = Path(os.environ["ACCEPTANCE_CASE_ROOT"])
    scenario = json.loads(Path(os.environ["ACCEPTANCE_NATIVE_SCENARIO"]).read_text(encoding="utf-8"))
    observation = root / "observations.jsonl"
    stdout_observation = root / "printed-stdout.txt"
    audit_observation = root / "audit-producer-output.txt"
    clock = {"wall": 0.0, "mono": 0.0}
    cli_holder = []
    original_stdout_handle = []
    markers = [value for value in scenario["credentials"].values() if value] + scenario.get("sensitiveMarkers", [])
    real_time, real_monotonic = time.time, time.monotonic

    class ObservedStdout:
        """Tee real stdout before ConPTY redraws, preserving its stream and TTY interfaces."""

        def __init__(self, original, destination=stdout_observation):
            """Retain the native stream; never replace its terminal identity."""
            self.original = original
            self.destination = destination

        def __getattr__(self, name):
            """Delegate encoding, fileno, isatty, buffer, and other native stream attributes."""
            return getattr(self.original, name)

        def write(self, value):
            """Observe exactly the emitted bytes-as-text, then perform the original write."""
            with self.destination.open("a", encoding="utf-8") as stream:
                stream.write(value)
            return self.original.write(value)

        def flush(self):
            """Preserve the original stream's flush behavior."""
            return self.original.flush()

    sys.stdout = ObservedStdout(sys.stdout)
    sys.stderr = ObservedStdout(sys.stderr, root / "printed-stderr.txt")
    # Scope offsets to the registry clock owner; network deadlines/JWT/audit clocks stay real.
    state.time = SimpleNamespace(
        time=lambda: real_time() + clock["wall"],
        monotonic=lambda: real_monotonic() + clock["mono"],
        strftime=time.strftime, gmtime=time.gmtime,
    )

    def record(event: str, **fields) -> None:
        """Append observations without altering actual return values or output arguments."""
        with observation.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"event": event, **fields}, ensure_ascii=False, default=str) + "\n")

    if scenario.get("differentRecoveryOwner") is True:
        import arcanos.continuation_store as protected_recovery
        protected_recovery._current_user_sid = lambda: "S-1-5-21-111111111-222222222-333333333-4242"
        record("injected_fault", kind="different-recovery-owner-sid", native_windows_user_unchanged=True)

    def fault(kind: str) -> None:
        """Change elapsed inputs or explicitly invalidate authority; never grant trusted evidence."""
        cli = cli_holder[0] if cli_holder else None
        if kind in ("expire", "expire-after-read", "expire-at-render", "rollback-after-expiry"):
            seconds = (cli._registry_cache_ttl_seconds if cli else 60) + 1
            clock["mono"] += seconds
            clock["wall"] += 1 if kind == "rollback-after-expiry" else seconds
        elif cli and kind == "missing-anchor":
            cli._registry_cache_updated_monotonic_at = None
        elif cli and kind == "future-anchor":
            cli._registry_cache_updated_monotonic_at = state.time.monotonic() + 60
        elif cli and kind == "future-wall":
            cli._registry_cache_updated_at = state.time.time() + 60
        elif cli and kind == "missing-backend":
            cli.backend_client = None
        else:
            raise ValueError("Unsupported native acceptance fault")
        record("injected_fault", kind=kind)

    original_input = builtins.input

    def after_input(value):
        """Apply an explicitly scheduled fault only after real terminal input returns."""
        control = root / "next-input-fault.json"
        if control.exists():
            kind = json.loads(control.read_text(encoding="utf-8"))["fault"]
            control.unlink()
            fault(kind)
        return value

    def observed_input(*args, **kwargs):
        """Retain OS stdin and its TTY check, applying a scheduled fault after real input."""
        return after_input(original_input(*args, **kwargs))

    builtins.input = observed_input
    original_editor = terminal_input.interactive_input

    @contextmanager
    def observed_editor():
        """Observe the real editor input boundary without replacing terminal behavior."""
        with original_editor() as read:
            yield lambda *args, **kwargs: after_input(read(*args, **kwargs))

    from arcanos import cli_runner
    cli_runner.interactive_input = observed_editor
    original_print = builtins.print

    def observed_print(*args, **kwargs):
        """Observe actual serialized audit output before Rich wraps it; delegate print unchanged."""
        for item in args:
            if isinstance(item, str) and item.startswith("[AUDIT] "):
                with audit_observation.open("a", encoding="utf-8") as stream:
                    stream.write(item + "\n")
        return original_print(*args, **kwargs)

    builtins.print = observed_print

    def bounded_background(cli) -> None:
        """Replace optional background loops with at most one actual authenticated heartbeat."""
        record("background_boundary", polling=False, heartbeat=bool(scenario.get("heartbeat", scenario.get("tty"))))
        if scenario.get("heartbeat", scenario.get("tty")):
            response = backend_ops.request_daemon_heartbeat(cli, uptime=0)
            record("heartbeat", status=response.status_code)

    ArcanosCLI._start_daemon_threads = bounded_background
    original_init = ArcanosCLI.__init__

    def observed_init(cli, *args, **kwargs):
        """Retain the initialized real CLI for read-only lifecycle receipts."""
        original_init(cli, *args, **kwargs)
        cli_holder.append(cli)
        record("initialized", trust=cli._trust_state.name, stdin_isatty=sys.stdin.isatty(),
               source_file=str(Path(sys.modules[ArcanosCLI.__module__].__file__).resolve()),
               python_executable=sys.executable)
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes
            import msvcrt
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetStdHandle.argtypes, kernel.GetStdHandle.restype = [wintypes.DWORD], wintypes.HANDLE
            kernel.GetConsoleMode.argtypes, kernel.GetConsoleMode.restype = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL
            for name, identifier, stream in (("stdin", -10, sys.stdin), ("stdout", -11, sys.stdout)):
                std = kernel.GetStdHandle(identifier)
                if name == "stdout":
                    original_stdout_handle.append(std)
                crt = msvcrt.get_osfhandle(stream.fileno())
                mode = wintypes.DWORD()
                standard_ok = bool(kernel.GetConsoleMode(std, ctypes.byref(mode)))
                standard_error = 0 if standard_ok else ctypes.get_last_error()
                record("terminal_handle", stream=name, is_tty=stream.isatty(),
                       standard_console=standard_ok, standard_error=standard_error,
                       crt_console=bool(kernel.GetConsoleMode(crt, ctypes.byref(mode))),
                       standard_matches_crt=std == crt)

    ArcanosCLI.__init__ = observed_init
    original_ask = ArcanosCLI.handle_ask

    def result_metadata(value):
        """Observe only benign parsed metadata; internal answer text is not a public sink."""
        if not is_dataclass(value):
            return None
        metadata = {name: getattr(value, name) for name in ("tokens_used", "cost_usd", "model", "source")}
        for name, item in metadata.items():
            if isinstance(item, str) and any(canonical_marker_text(marker) in canonical_marker_text(item) for marker in markers):
                metadata[name] = "[INTERNAL_SYNTHETIC_MARKER_WITHHELD]"
        return metadata

    def observed_ask(cli, *args, **kwargs):
        """Observe existing caller arguments/results; never force a result-mode invocation."""
        value = original_ask(cli, *args, **kwargs)
        record("ask_result", value=result_metadata(value), observation="original caller result metadata",
               last_response=cli._last_response, trust=cli._trust_state.name)
        return value

    ArcanosCLI.handle_ask = observed_ask
    original_conversation = backend_ops.perform_backend_conversation

    def observed_conversation(*args, **kwargs):
        """Capture actual parsed backend metadata before ordinary CLI rendering/persistence."""
        value = original_conversation(*args, **kwargs)
        cli = args[0]
        record("conversation_result", value=result_metadata(value), observation="internal parsed metadata only",
               prompt_claims_fresh="daemon registry evidence: authenticated and fresh" in cli.system_prompt,
               prompt_leak=any(canonical_marker_text(marker) in canonical_marker_text(cli.system_prompt) for marker in markers))
        return value

    backend_ops.perform_backend_conversation = observed_conversation
    original_local = local_ops.perform_local_conversation
    original_streaming = local_ops.perform_local_conversation_streaming

    def observed_local(*args, **kwargs):
        """Count actual fallback/local generation attempts without replacing their implementation."""
        record("local_generation_attempt", streaming=False)
        return original_local(*args, **kwargs)

    def observed_streaming(*args, **kwargs):
        """Observe the streaming path too if a scenario explicitly enables it."""
        record("local_generation_attempt", streaming=True)
        return original_streaming(*args, **kwargs)

    local_ops.perform_local_conversation = observed_local
    local_ops.perform_local_conversation_streaming = observed_streaming

    def capture_speech(_audio, text: str, wait: bool = True) -> bool:
        """Replace only the physical audio emitter; CLI speech formatting remains unchanged."""
        record("speech", text=text, wait=wait)
        return True

    AudioSystem.speak = capture_speech
    original_builder = ui_ops.build_system_status_evidence
    render_fault_done = False

    def observed_evidence(*args, **kwargs):
        """Optionally advance time at rendering, then observe the unaltered evidence text."""
        nonlocal render_fault_done
        if scenario.get("fault") == "expire-at-render" and not render_fault_done:
            render_fault_done = True
            fault("expire-at-render")
        value = original_builder(*args, **kwargs)
        record("diagnostic_result", text=value, observation="actual public diagnostic rendering")
        return value

    ui_ops.build_system_status_evidence = observed_evidence
    original_session_init = requests.Session.__init__
    state_reads = 0

    def after_response(response, **_kwargs):
        """Advance only the registry clocks after a real blocking status HTTP read completes."""
        nonlocal state_reads
        if urlsplit(response.url).path.startswith("/gpt/") and response.status_code == 202:
            payload = response.json()
            token = payload.get("jobReadToken") if isinstance(payload, dict) else None
            record("accepted_response", job_id=payload.get("jobId"),
                   valid_capability=isinstance(token, str) and re.fullmatch(r"v1\.[A-Za-z0-9_-]{43}", token) is not None,
                   capability_header=payload.get("jobReadTokenHeader") == "x-arcanos-job-read-token")
        if urlsplit(response.url).path.startswith("/jobs/"):
            payload = response.json()
            record("job_read_response", status_code=response.status_code,
                   status=payload.get("status"), job_status=payload.get("jobStatus"),
                   job_id=payload.get("jobId"), has_result=payload.get("result") is not None)
        if urlsplit(response.url).path == "/system-state":
            state_reads += 1
            if scenario.get("fault") == "expire-after-read" and state_reads == 2:
                fault("expire-after-read")
        return response

    def observed_session_init(session, *args, **kwargs):
        """Attach a supported read-only response hook while preserving real HTTP transport."""
        original_session_init(session, *args, **kwargs)
        session.hooks["response"].append(after_response)

    requests.Session.__init__ = observed_session_init

    def final_state() -> None:
        """Record final local evidence without recomputing, refreshing, or changing trust."""
        if cli_holder:
            cli = cli_holder[0]
            restored = None
            if original_stdout_handle:
                import ctypes
                from ctypes import wintypes
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.GetStdHandle.argtypes, kernel.GetStdHandle.restype = [wintypes.DWORD], wintypes.HANDLE
                restored = kernel.GetStdHandle(-11) == original_stdout_handle[0]
            record("final_state", trust=cli._trust_state.name, registry_valid=state.registry_cache_is_valid(cli),
                   terminal_handle_restored=restored,
                   wall_anchor=cli._registry_cache_updated_at,
                   mono_anchor=cli._registry_cache_updated_monotonic_at,
                   prompt_claims_fresh="daemon registry evidence: authenticated and fresh" in cli.system_prompt,
                   prompt_leak=any(canonical_marker_text(marker) in canonical_marker_text(cli.system_prompt) for marker in markers),
                   prompt_sha256=hashlib.sha256(cli.system_prompt.encode()).hexdigest(),
                   last_confirmation_handled=cli._last_confirmation_handled,
                   current_intent=cli.session.current_intent, conversation_goal=cli.session.conversation_goal,
                   last_response=cli._last_response,
                   history=cli.memory.get_recent_conversations(limit=100))

    atexit.register(final_state)


def native_cli(daemon_root: str, base_url: str, scenario_path: str, receipt_path: str) -> None:
    """Run one bounded actual module process using existing isolation, guard, and Windows TTY helpers."""
    daemon = Path(daemon_root).resolve()
    scenario_file = Path(scenario_path).resolve()
    receipt_file = Path(receipt_path).resolve()
    scenario = json.loads(scenario_file.read_text(encoding="utf-8"))
    sys.path.insert(0, str(daemon / "scripts"))
    from local_action_acceptance.common import clean_env, read_jsonl

    receipt_file.parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="native-cli-", dir=receipt_file.parent))
    credentials = scenario["credentials"]
    debug_port = None
    debug_response = None
    debug_env = {}
    if scenario.get("debugRequest"):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            debug_port = reservation.getsockname()[1]
        credentials["debug"] = "synthetic-native-debug-" + secrets.token_urlsafe(32)
        scenario_file = root / "native-scenario.json"
        scenario_file.write_text(json.dumps(scenario), encoding="utf-8")
        debug_env = {
            "DEBUG_SERVER_ENABLED": "true", "DEBUG_SERVER_PORT": str(debug_port),
            "DEBUG_SERVER_TOKEN": credentials["debug"], "ACCEPTANCE_ALLOWED_PORTS": str(debug_port),
        }
    env = clean_env(root, daemon.parent, base_url if scenario.get("backendEnabled", True) else None, extra={
        "BACKEND_TOKEN": credentials["gpt"], "ARCANOS_GPT_ACCESS_TOKEN": credentials["gpt"],
        "ARCANOS_DAEMON_ACCESS_TOKEN": credentials["daemon"],
        "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN": credentials["control"],
        "SHOW_WELCOME": "false", "REPO_INDEX_ENABLED": "false", "AGENTIC_ENABLED": "false",
        "TERM": "dumb", "NO_COLOR": "1", "COLUMNS": "240",
        "SPEAK_RESPONSES": str(bool(scenario.get("speak"))).lower(),
        "REGISTRY_CACHE_TTL_MINUTES": "1", "BACKEND_REQUEST_TIMEOUT": "5",
        "CONVERSATION_RECOVERY_ENABLED": "false",
        "ACCEPTANCE_NATIVE_SCENARIO": str(scenario_file),
        **scenario.get("extraEnv", {}),
        **debug_env,
    })
    profile = scenario.get("persistentProfile")
    if profile is not None:
        if not isinstance(profile, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,64}", profile) is None:
            raise ValueError("Expected a bounded isolated persistence profile name")
        shared = receipt_file.parent / ("native-profile-" + profile)
        shared.mkdir(parents=True, exist_ok=True)
        env.update(DATA_DIR=str(shared), MEMORY_FILE=str(shared / "memory.json"),
                   HISTORY_DB_PATH=str(shared / "history.db"))
    if sys.platform != "win32":
        # The reused native helper seeds Windows config. Other public entrypoint
        # platforms also need their isolated user config before resolving BASE_DIR.
        relative = "Library/Application Support/ARCANOS" if sys.platform == "darwin" else ".local/share/ARCANOS"
        user_config = root / "profile" / relative / ".env"
        user_config.parent.mkdir(parents=True, exist_ok=True)
        user_config.write_text("# Isolated synthetic acceptance profile\n", encoding="utf-8")
    env["PYTHONPATH"] += os.pathsep + str(Path(__file__).resolve().parent)
    dependency_site = os.environ.get("ACCEPTANCE_PYTHON_USER_SITE")
    if dependency_site:
        env["PYTHONPATH"] += os.pathsep + dependency_site
    extra_site = os.environ.get("ACCEPTANCE_EXTRA_PYTHON_SITE")
    if extra_site:
        env["PYTHONPATH"] += os.pathsep + extra_site
    bootstrap = root / "native-bootstrap.py"
    bootstrap.write_text("from daemon_registry_client import install_native_observers\ninstall_native_observers()\n", encoding="utf-8")
    env["ACCEPTANCE_FAULT_BOOTSTRAP"] = str(bootstrap)
    (root / "profile/pyreadlineconfig.ini").write_text("disable_readline(True)\n", encoding="utf-8")
    argv = [sys.executable, "-u", "-m", "arcanos.cli"]
    terminal = stderr = ""
    child = None
    process_job = None
    exit_code = None
    failure = None
    pipe_threads = []
    pipe_output = {"stdout": [], "stderr": []}
    cleanup = {"forced_termination": False}
    started = time.monotonic()

    def wait_input(count: int) -> None:
        """Wait for the existing audit-hook readiness marker, bounded by the actual child lifetime."""
        while sum(row.get("event") == "builtins.input" for row in read_jsonl(root / "logs/network.jsonl")) < count:
            code = child.returncode if scenario.get("tty") else child.poll()
            if code is not None:
                raise RuntimeError("Native CLI exited before the planned input")
            if time.monotonic() - started > 40:
                raise TimeoutError("Native CLI input readiness exceeded its deadline")
            time.sleep(0.02)

    try:
        if scenario.get("tty"):
            from local_action_acceptance.conpty import ConsoleProcess
            child = ConsoleProcess(argv, cwd=root, env=env, columns=240, rows=80)
        else:
            if os.name == "nt":
                from local_action_acceptance.process_job import ProcessJob
                process_job = ProcessJob()
            child = subprocess.Popen(argv, cwd=root, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                     creationflags=0x00000004 if process_job else 0)
            if process_job:
                process_job.attach_and_resume(child)
            def drain(stream, destination):
                """Drain real native pipe output concurrently so rendering cannot block input readiness."""
                try:
                    for line in stream:
                        destination.append(line)
                finally:
                    stream.close()

            for name in ("stdout", "stderr"):
                reader = threading.Thread(target=drain, args=(getattr(child, name), pipe_output[name]), daemon=True)
                reader.start()
                pipe_threads.append(reader)
        if debug_port is not None:
            wait_input(1)  # Public CLI initialization starts the actual debug HTTP server.
            connection = http.client.HTTPConnection("127.0.0.1", debug_port, timeout=10)
            try:
                connection.request("POST", "/debug/ask", json.dumps(scenario["debugRequest"]), headers={
                    "Authorization": "Bearer " + credentials["debug"], "Content-Type": "application/json",
                })
                response = connection.getresponse()
                body = response.read().decode("utf-8")
                debug_response = {"method": "POST", "path": "/debug/ask", "status": response.status,
                                  "payload": json.loads(body)}
            finally:
                connection.close()
        for index, step in enumerate(scenario["steps"], start=1):
            wait_input(index)
            delay = step.get("waitBeforeMs", 0)
            if not isinstance(delay, int) or not 0 <= delay <= 2000:
                raise ValueError("Native input delay must be bounded to two seconds")
            if delay:
                time.sleep(delay / 1000)
            if step.get("faultBefore"):
                (root / "next-input-fault.json").write_text(json.dumps({"fault": step["faultBefore"]}), encoding="utf-8")
            if step.get("typeBeforeWait") is not None:
                if not scenario.get("tty") or not isinstance(step["typeBeforeWait"], str):
                    raise ValueError("Partial input requires a native TTY and text")
                child.send(step["typeBeforeWait"])
            if step.get("waitForText") is not None:
                expected = step["waitForText"]
                expected_texts = expected if isinstance(expected, list) else [expected]
                if not 1 <= len(expected_texts) <= 8 or any(not isinstance(text, str) or len(text) > 4096 for text in expected_texts):
                    raise ValueError("Expected a bounded completion marker")
                deadline = time.monotonic() + 15
                stdout_file = root / "printed-stdout.txt"
                while not all(text in (stdout_file.read_text(encoding="utf-8") if stdout_file.exists() else "") or text in child.transcript for text in expected_texts):
                    if time.monotonic() >= deadline or child.returncode is not None:
                        raise TimeoutError("Automatic answer did not reach the actual terminal")
                    time.sleep(0.02)
            if scenario.get("tty"):
                if scenario.get("extraEnv", {}).get("CONVERSATION_RECOVERY_ENABLED") == "true":
                    # The Windows editor recognizes text + Enter in one input
                    # batch as pasted content. Type text, observe it on the real
                    # terminal, then press Enter as a separate key event.
                    child.send(step["input"])
                    deadline = time.monotonic() + 5
                    while step["input"] and step["input"] not in child.transcript:
                        if time.monotonic() >= deadline or child.returncode is not None:
                            raise TimeoutError("Typed input did not reach the actual terminal")
                        time.sleep(0.02)
                    time.sleep(0.1)
                    child.send("\r")
                else:
                    child.send_line(step["input"])
            else:
                child.stdin.write(step["input"] + "\n")
                child.stdin.flush()
        if scenario.get("tty"):
            exit_code = child.wait(timeout=15)
            terminal = child.raw_transcript
        else:
            child.stdin.close()
            child.wait(timeout=15)
            for reader in pipe_threads:
                reader.join(timeout=3)
            terminal, stderr = "".join(pipe_output["stdout"]), "".join(pipe_output["stderr"])
            exit_code = child.returncode
    except Exception as error:
        failure = {"type": type(error).__name__, "message": str(error)}
        (root / "controller-failure.json").write_text(json.dumps(failure), encoding="utf-8")
    finally:
        if child is not None:
            if scenario.get("tty"):
                cleanup["forced_termination"] = child.returncode is None
                exit_code = child.returncode if child.returncode is not None else 125
                child.close()
                terminal = child.raw_transcript
            elif child.poll() is None:
                cleanup["forced_termination"] = True
                child.kill()
                child.wait(timeout=10)
            for reader in pipe_threads:
                reader.join(timeout=3)
            if not scenario.get("tty"):
                exit_code = child.returncode
                terminal, stderr = "".join(pipe_output["stdout"]), "".join(pipe_output["stderr"])
        if process_job:
            process_job.close()
            cleanup["owned_windows_job_closed"] = True
        cleanup["child_closed"] = True
    events = read_jsonl(root / "observations.jsonl")
    stdout_file = root / "printed-stdout.txt"
    printed_output = stdout_file.read_text(encoding="utf-8") if stdout_file.exists() else terminal
    stderr_file = root / "printed-stderr.txt"
    captured_stderr = stderr_file.read_text(encoding="utf-8") if stderr_file.exists() else ""
    audit_file = root / "audit-producer-output.txt"
    audit_output = audit_file.read_text(encoding="utf-8") if audit_file.exists() else ""
    speech = [row["text"] for row in events if row["event"] == "speech"]
    results = [row for row in events if row["event"] in ("ask_result", "conversation_result", "diagnostic_result")]
    persisted = []
    memory_file = Path(env["MEMORY_FILE"])
    final_observation = next((row for row in reversed(events) if row["event"] == "final_state"), None)
    history = (final_observation or {}).get("history")
    if history is None:
        history = json.loads(memory_file.read_text(encoding="utf-8")).get("conversations", []) if memory_file.exists() else []
    for file in Path(env["DATA_DIR"]).rglob("*"):
        if file.is_file() and file.suffix in (".json", ".jsonl", ".txt"):
            persisted.append(file.read_text(encoding="utf-8", errors="replace"))
        elif file.is_file() and file.suffix == ".db":
            with sqlite3.connect(file) as connection:
                for (table,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                    persisted.append(repr(connection.execute('SELECT * FROM "' + table.replace('"', '""') + '"').fetchall()))
        elif file.is_file():
            persisted.append(file.read_bytes().decode("utf-8", errors="ignore"))
    logs = [file.read_text(encoding="utf-8", errors="replace") for file in (root / "logs").rglob("*") if file.is_file()]
    markers = [value for value in credentials.values() if value] + scenario.get("sensitiveMarkers", [])

    sinks = {"terminal": terminal + printed_output + stderr + captured_stderr, "audit": audit_output,
             "logs": "\n".join(logs), "history": "\n".join(persisted),
             "speech": "\n".join(speech), "results": json.dumps(results, ensure_ascii=False),
             "debug_json": json.dumps(debug_response, ensure_ascii=False),
             "context": json.dumps([row for row in events if row["event"] == "final_state"], ensure_ascii=False)}
    leaks = {name: any(canonical_marker_text(marker) in canonical_marker_text(value) for marker in markers) for name, value in sinks.items()}
    leaks["prompt"] = any(row.get("prompt_leak", False) for row in events)
    audits = []
    audit_parse_errors = 0
    for line in audit_output.splitlines():
        try:
            audits.append(json.loads(line.removeprefix("[AUDIT] ")))
        except json.JSONDecodeError:
            audit_parse_errors += 1

    def sanitized(value):
        """Withhold detected synthetic credentials from the machine-readable receipt after leak checks."""
        if isinstance(value, str):
            if any(canonical_marker_text(marker) in canonical_marker_text(value) for marker in markers):
                value = canonical_marker_text(value)
                for marker in sorted(markers, key=len, reverse=True):
                    value = value.replace(canonical_marker_text(marker), "[SYNTHETIC_CREDENTIAL_WITHHELD]")
            return value
        if isinstance(value, dict):
            return {key: sanitized(item) for key, item in value.items()}
        if isinstance(value, list):
            return [sanitized(item) for item in value]
        return value

    receipt = {
        "name": scenario["name"], "entrypoint": argv, "public_entrypoint": True,
        "transport": "Windows ConPTY" if scenario.get("tty") else "native stdin/stdout pipes",
        "exit_code": exit_code, "terminal": terminal, "rendered_terminal": child.transcript if scenario.get("tty") and child is not None else terminal,
        "stderr": stderr, "audits": audits,
        "captured_stderr": captured_stderr,
        "printed_output": printed_output,
        "audit_capture": "actual serialized producer output before Rich terminal wrapping",
        "failure": failure,
        "audit_parse_errors": audit_parse_errors,
        "speech": speech, "ask_results": results,
        "debug_response": debug_response,
        "history": history,
        "final_state": next((row for row in reversed(events) if row["event"] == "final_state"), None),
        "observations": events, "network": read_jsonl(root / "logs/network.jsonl"),
        "leaks": leaks, "cleanup": cleanup,
    }
    receipt_file.write_text(json.dumps(sanitized(receipt), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if failure:
        print("Native CLI failed; sanitized child output and lifecycle evidence are in the receipt.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    if sys.argv[1] == "--native":
        native_cli(*sys.argv[2:6])
    else:
        registry_client(sys.argv[1], sys.argv[2], int(sys.argv[3]))
