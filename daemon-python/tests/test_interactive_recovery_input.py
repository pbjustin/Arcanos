"""Interactive recovery keeps its worker inside the terminal redraw boundary."""

from contextlib import contextmanager, nullcontext
import asyncio
import io
from pathlib import Path
import secrets
import sys
from types import SimpleNamespace

import pytest
from rich.console import Console

from arcanos import cli_runner
from arcanos import interactive_input as terminal_input
from arcanos.config import Config


class TtyStream(io.StringIO):
    """Expose a TTY identity without touching the test runner's real console."""

    def isatty(self):
        """Select the same editor path as a real interactive Windows terminal."""
        return True


@pytest.mark.parametrize("stage", ["dependency", "console", "app_session", "completer", "session", "stdout"])
def test_optional_editor_setup_failure_keeps_plain_interactive_cli(monkeypatch, capsys, stage):
    """Unwind optional editor setup before ordinary input without starting unsafe writes."""
    order = []
    answers = iter(["ordinary question", "/exit"])
    private_error = "synthetic-private-editor-detail"

    def fail_if(selected):
        """Inject failures only before the first prompt can contain user input."""
        if stage == selected:
            raise OSError(private_error)

    @contextmanager
    def console():
        order.append("console_enter")
        try:
            fail_if("console")
            yield
        finally:
            order.append("console_exit")

    @contextmanager
    def app_session():
        order.append("app_enter")
        try:
            fail_if("app_session")
            yield SimpleNamespace(output=object())
        finally:
            order.append("app_exit")

    @contextmanager
    def patched_stdout(*, raw):
        assert raw is True
        order.append("stdout_enter")
        try:
            fail_if("stdout")
            yield
        finally:
            order.append("stdout_exit")

    def completer(_commands):
        fail_if("completer")

    def session(**_kwargs):
        fail_if("session")
        return SimpleNamespace(prompt=lambda *_args, **_kwargs: pytest.fail("Failed setup used the editor"))

    def ordinary_input(_prompt):
        assert "start" not in order
        for resource in ("console", "app", "stdout"):
            if f"{resource}_enter" in order:
                assert f"{resource}_exit" in order
        order.append("input")
        return next(answers)

    monkeypatch.setattr(Config, "CONVERSATION_RECOVERY_ENABLED", True)
    monkeypatch.setattr(terminal_input, "sys", SimpleNamespace(
        platform="win32", stdin=TtyStream(), stdout=TtyStream(), audit=sys.audit,
    ))
    monkeypatch.setattr(terminal_input, "_readable_windows_console", console)
    monkeypatch.setitem(sys.modules, "prompt_toolkit", None if stage == "dependency" else SimpleNamespace(PromptSession=session))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.application", SimpleNamespace(create_app_session=app_session))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.completion", SimpleNamespace(
        NestedCompleter=SimpleNamespace(from_nested_dict=completer),
    ))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.patch_stdout", SimpleNamespace(patch_stdout=patched_stdout))
    monkeypatch.setattr("builtins.input", ordinary_input)
    monkeypatch.setattr(cli_runner, "install_completion", lambda: None)
    cli = SimpleNamespace(
        console=Console(file=io.StringIO()), show_welcome=lambda: None,
        handle_ask=lambda value: order.append("ask:" + value),
        _start_conversation_recovery=lambda: order.append("start"),
        _stop_conversation_recovery=lambda: order.append("stop"),
        _stop_daemon_service=lambda: order.append("daemon_stop"),
    )
    cli_runner.run_interactive_mode(cli)
    output = capsys.readouterr().out
    assert "Automatic conversation recovery is unavailable" in output
    assert private_error not in output
    assert "ask:ordinary question" in order
    assert "start" not in order
    assert order[-1] == "daemon_stop"


@pytest.mark.parametrize("end", ["exit", "interrupt", "start_failure", "prompt_failure"])
def test_recovery_starts_and_stops_inside_stdout_redraw_context(monkeypatch, end):
    """Keep worker output protected until shutdown, including startup/input failures."""
    order = []
    answers = iter(["hello", "exit"])

    class Session:
        """Observe the actual prompt API boundary without reading operator stdin."""

        def __init__(self, **_kwargs):
            """Record terminal editor construction before its stdout proxy opens."""
            order.append("session")

        def prompt(self, value, *, pre_run):
            """Supply controlled input or an actual input interrupt to the runner."""
            assert value == "> "
            async def ready():
                pre_run()
                await asyncio.sleep(0)
            asyncio.run(ready())
            order.append("input")
            if end == "prompt_failure" and order.count("input") == 1:
                raise OSError("synthetic editor failure after partial input")
            if end == "interrupt":
                raise KeyboardInterrupt
            return next(answers)

    @contextmanager
    def patched_stdout(*, raw):
        """Expose proxy lifetime so worker ordering is independently observable."""
        assert raw is True
        order.append("patch_enter")
        try:
            yield
        finally:
            order.append("patch_exit")

    @contextmanager
    def app_session():
        """Keep native console objects scoped to this invocation."""
        yield SimpleNamespace(output=object())

    def start():
        """Simulate controller startup, including a partially started failure."""
        order.append("start")
        if end == "start_failure":
            raise RuntimeError("synthetic controller startup failure")

    monkeypatch.setattr(Config, "CONVERSATION_RECOVERY_ENABLED", True, raising=False)
    monkeypatch.setattr(terminal_input, "sys", SimpleNamespace(
        platform="win32", stdin=TtyStream(), stdout=TtyStream(), audit=sys.audit,
    ))
    monkeypatch.setattr(terminal_input, "_readable_windows_console", nullcontext)
    monkeypatch.setitem(sys.modules, "prompt_toolkit", SimpleNamespace(PromptSession=Session))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.completion", SimpleNamespace(
        NestedCompleter=SimpleNamespace(from_nested_dict=lambda _: None),
    ))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.patch_stdout", SimpleNamespace(patch_stdout=patched_stdout))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.application", SimpleNamespace(create_app_session=app_session))
    monkeypatch.setattr(cli_runner, "install_completion", lambda: None)
    monkeypatch.setattr("builtins.input", lambda *_args: pytest.fail("Active editor switched to plain input"))
    cli = SimpleNamespace(
        console=Console(file=io.StringIO()), show_welcome=lambda: None,
        handle_ask=lambda message: order.append("ask:" + message),
        _start_conversation_recovery=start,
        _stop_conversation_recovery=lambda: order.append("stop"),
        _stop_daemon_service=lambda: order.append("daemon_stop"),
        _append_activity=lambda *_args: order.append("error"),
    )
    if end == "start_failure":
        with pytest.raises(RuntimeError, match="synthetic controller"):
            cli_runner.run_interactive_mode(cli)
    else:
        cli_runner.run_interactive_mode(cli)
    assert order.index("patch_enter") < order.index("start")
    assert order.index("start") < order.index("stop") < order.index("patch_exit") < order.index("daemon_stop")
    if end == "exit":
        assert "ask:hello" in order
    if end == "prompt_failure":
        assert order.count("input") == 1
        assert "ask:hello" not in order


def test_permanent_active_reader_failure_exits_once_without_replaying_partial_input(monkeypatch):
    """A broken active editor must not spin or switch to another input implementation."""
    calls = []
    lifecycle = []
    output = io.StringIO()

    def failed_reader(_prompt):
        calls.append("read")
        if len(calls) > 3:
            raise KeyboardInterrupt  # Bound the failing-before reproduction.
        raise RuntimeError("synthetic-private-partially-entered-input")

    failed_reader._arcanos_redraw_safe = True

    @contextmanager
    def editor():
        lifecycle.append("editor_enter")
        try:
            yield failed_reader
        finally:
            lifecycle.append("editor_exit")

    monkeypatch.setattr(cli_runner, "interactive_input", editor)
    monkeypatch.setattr(cli_runner, "install_completion", lambda: None)
    monkeypatch.setattr("builtins.input", lambda *_args: pytest.fail("Active reader fell back to plain input"))
    cli = SimpleNamespace(
        console=Console(file=output), show_welcome=lambda: None,
        handle_ask=lambda _value: pytest.fail("Failed input became a conversation"),
        _start_conversation_recovery=lambda: lifecycle.append("start"),
        _stop_conversation_recovery=lambda: lifecycle.append("stop"),
        _stop_daemon_service=lambda: lifecycle.append("daemon_stop"),
        _append_activity=lambda *_args: None,
    )
    cli_runner.run_interactive_mode(cli)
    assert calls == ["read"]
    assert "Interactive input failed; restart the CLI to continue." in output.getvalue()
    assert "synthetic-private-partially-entered-input" not in output.getvalue()
    assert lifecycle == ["editor_enter", "start", "stop", "editor_exit", "daemon_stop"]


def test_command_failure_keeps_active_editor_usable(monkeypatch):
    """Fatal reader handling must not turn ordinary command failures into CLI exits."""
    answers = iter(["first question", "second question", "/exit"])
    asked = []

    def read(_prompt):
        return next(answers)

    read._arcanos_redraw_safe = True

    @contextmanager
    def editor():
        yield read

    def ask(value):
        asked.append(value)
        if len(asked) == 1:
            raise RuntimeError("synthetic conversation failure")

    monkeypatch.setattr(cli_runner, "interactive_input", editor)
    monkeypatch.setattr(cli_runner, "install_completion", lambda: None)
    cli = SimpleNamespace(
        console=Console(file=io.StringIO()), show_welcome=lambda: None,
        handle_ask=ask, _append_activity=lambda *_args: None,
        _stop_daemon_service=lambda: None,
    )
    cli_runner.run_interactive_mode(cli)
    assert asked == ["first question", "second question"]


@pytest.mark.skipif(sys.platform != "win32", reason="Acceptance requires a real Windows ConPTY")
@pytest.mark.parametrize("stage", ["console", "session", "stdout"])
def test_native_cli_survives_optional_editor_setup_failure(monkeypatch, tmp_path, stage):
    """Actual Windows input and HTTP 200 chat remain usable without background output."""
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    from local_action_acceptance.cli import DaemonFixture, SyntheticBackend
    from local_action_acceptance.common import read_jsonl

    bootstrap = tmp_path / "editor_fault.py"
    bootstrap.write_text('''from contextlib import contextmanager
import importlib, os, sys
from pathlib import Path
printed = Path(os.environ['ACCEPTANCE_CASE_ROOT']) / 'printed.txt'
class ObservedOutput:
    def __init__(self, original):
        self.original = original
    def __getattr__(self, name):
        return getattr(self.original, name)
    def write(self, value):
        with printed.open('a', encoding='utf-8') as stream:
            stream.write(value)
        return self.original.write(value)
    def flush(self):
        return self.original.flush()
sys.stdout = ObservedOutput(sys.stdout)
sys.stderr = ObservedOutput(sys.stderr)
from arcanos.cli.cli import ArcanosCLI
from arcanos.cli import memory_ops
from arcanos import interactive_input as terminal_input
ArcanosCLI._start_daemon_threads = lambda self: None
memory_ops.update_short_term_summary = lambda *args, **kwargs: None
def unexpected_monitor(self):
    raise AssertionError("Plain input must not start automatic recovery")
ArcanosCLI._start_conversation_recovery = unexpected_monitor
def failed_editor(*args, **kwargs):
    raise OSError("synthetic-private-editor-detail")
@contextmanager
def failed_context(*args, **kwargs):
    failed_editor()
    yield
''' + {
        "console": "terminal_input._readable_windows_console = failed_context\n",
        "session": "import prompt_toolkit\nprompt_toolkit.PromptSession = failed_editor\n",
        "stdout": "importlib.import_module('prompt_toolkit.patch_stdout').patch_stdout = failed_context\n",
    }[stage], encoding="utf-8")
    with SyntheticBackend() as backend:
        control_token = secrets.token_urlsafe(32)
        backend.purpose_bound_tokens["/system-state"] = control_token
        fixture = DaemonFixture(tmp_path / "case", scripts.parent.parent, backend=backend, extra_env={
            "ACCEPTANCE_FAULT_BOOTSTRAP": str(bootstrap),
            "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN": control_token,
            "CONVERSATION_RECOVERY_ENABLED": "true", "AGENTIC_ENABLED": "false",
            "LOCAL_AGENT_ENABLED": "false", "SELF_HEALING_ENABLED": "false",
        })
        try:
            fixture.start()
            assert "Automatic conversation recovery is unavailable" in (fixture.case_root / "printed.txt").read_text(encoding="utf-8")
            fixture.control("ordinary synthetic question")
            assert "Acceptance backend ready." in (fixture.case_root / "printed.txt").read_text(encoding="utf-8")
        finally:
            fixture.close()
        assert fixture.cleanup["forced_termination"] is False
        transcript = fixture.console.transcript + (fixture.case_root / "printed.txt").read_text(encoding="utf-8")
        assert "synthetic-private-editor-detail" not in transcript
        for credential in (backend.token, backend.daemon_token, control_token):
            assert credential not in transcript
        generation = [request for request in backend.requests if request["method"] == "POST" and request["path"].startswith("/gpt/")]
        assert len(generation) == 1
        assert all(request["authenticated"] for request in backend.requests)
        assert not any(request["path"].startswith("/jobs/") or request["path"] == "/api/daemon/commands" for request in backend.requests)
        events = read_jsonl(fixture.case_root / "logs/network.jsonl")
        assert any(event.get("stdin_isatty") is True for event in events if event["event"] == "guard_installed")
        # urllib3 probes IPv6 support during import; the guard rejects that bind.
        denied = [event for event in events if event.get("allowed") is False]
        assert all(event["event"] == "socket.bind" and event["host"] == "::1" and event["port"] == 0 for event in denied)


def test_non_tty_consumers_retain_builtin_input(monkeypatch):
    """Pipe consumers and existing input adapters do not require a terminal editor."""
    from arcanos.interactive_input import interactive_input

    monkeypatch.setattr(sys, "stdin", io.StringIO())
    reader = lambda _: "pipe input"
    monkeypatch.setattr("builtins.input", reader)
    with interactive_input() as read:
        assert read("> ") == "pipe input"


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_non_windows_tty_retains_builtin_input_without_loading_editor(monkeypatch, platform):
    """Windows DPAPI recovery must not change an ordinary Unix terminal session."""
    reader = lambda _: "ordinary terminal input"
    monkeypatch.setattr(Config, "CONVERSATION_RECOVERY_ENABLED", True)
    monkeypatch.setattr(terminal_input, "sys", SimpleNamespace(
        platform=platform, stdin=TtyStream(), stdout=TtyStream(),
    ))
    monkeypatch.setattr("builtins.input", reader)
    monkeypatch.setitem(sys.modules, "prompt_toolkit", None)
    with terminal_input.interactive_input() as read:
        assert read is reader
        assert read("> ") == "ordinary terminal input"


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_non_windows_recovery_start_keeps_normal_cli_without_warning(monkeypatch, platform):
    """Unsupported platforms neither construct a controller nor report storage failure."""
    from arcanos.cli import cli as cli_module
    from arcanos.cli import conversation_recovery

    started = []

    def unexpected_controller(_cli):
        """Expose any unintended recovery startup before storage or network activity."""
        started.append(True)
        raise RuntimeError("Windows protected storage is unavailable here")

    output = io.StringIO()
    cli = cli_module.ArcanosCLI.__new__(cli_module.ArcanosCLI)
    cli.console = Console(file=output)
    cli.backend_client = object()
    cli._conversation_recovery = None
    monkeypatch.setattr(Config, "CONVERSATION_RECOVERY_ENABLED", True)
    monkeypatch.setattr(cli_module, "sys", SimpleNamespace(platform=platform))
    monkeypatch.setattr(conversation_recovery, "ConversationRecovery", unexpected_controller)
    cli._start_conversation_recovery()
    assert started == []
    assert cli._conversation_recovery is None
    assert output.getvalue() == ""
