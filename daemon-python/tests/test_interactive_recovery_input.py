"""Interactive recovery keeps its worker inside the terminal redraw boundary."""

from contextlib import contextmanager
import asyncio
import io
import sys
from types import SimpleNamespace

import pytest
from rich.console import Console

from arcanos import cli_runner
from arcanos.config import Config


class TtyStream(io.StringIO):
    """Expose a TTY identity without touching the test runner's real console."""

    def isatty(self):
        """Select the same editor path as a real interactive Windows terminal."""
        return True


@pytest.mark.parametrize("end", ["exit", "interrupt", "start_failure"])
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
    monkeypatch.setattr(sys, "stdin", TtyStream())
    monkeypatch.setattr(sys, "stdout", TtyStream())
    monkeypatch.setitem(sys.modules, "prompt_toolkit", SimpleNamespace(PromptSession=Session))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.completion", SimpleNamespace(
        NestedCompleter=SimpleNamespace(from_nested_dict=lambda _: None),
    ))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.patch_stdout", SimpleNamespace(patch_stdout=patched_stdout))
    monkeypatch.setitem(sys.modules, "prompt_toolkit.application", SimpleNamespace(create_app_session=app_session))
    monkeypatch.setattr(cli_runner, "install_completion", lambda: None)
    cli = SimpleNamespace(
        console=Console(file=io.StringIO()), show_welcome=lambda: None,
        handle_ask=lambda message: order.append("ask:" + message),
        _start_conversation_recovery=start,
        _stop_conversation_recovery=lambda: order.append("stop"),
        _stop_daemon_service=lambda: order.append("daemon_stop"),
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


def test_non_tty_consumers_retain_builtin_input(monkeypatch):
    """Pipe consumers and existing input adapters do not require a terminal editor."""
    from arcanos.interactive_input import interactive_input

    monkeypatch.setattr(sys, "stdin", io.StringIO())
    reader = lambda _: "pipe input"
    monkeypatch.setattr("builtins.input", reader)
    with interactive_input() as read:
        assert read("> ") == "pipe input"
