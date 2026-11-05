"""Keep asynchronous conversation output above an active interactive prompt."""

from __future__ import annotations

from contextlib import contextmanager, ExitStack
import asyncio
import os
import sys
from typing import Callable, Iterator

from .completer import SLASH_COMMANDS, SUBCOMMANDS
from .config import Config


@contextmanager
def _readable_windows_console() -> Iterator[None]:
    """Let the editor inspect a write-only ConPTY console, restoring its handle afterward.

    Shell redirection can expose a genuine CONOUT$ TTY with write-only access.
    The editor needs read access for screen geometry. Open the same console only
    when that specific access check fails; no launcher or persistent state changes.
    """
    if sys.platform != "win32":
        yield
        return

    import ctypes
    from ctypes import wintypes
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.argtypes, kernel.GetStdHandle.restype = [wintypes.DWORD], wintypes.HANDLE
    kernel.GetConsoleMode.argtypes, kernel.GetConsoleMode.restype = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL
    kernel.SetStdHandle.argtypes, kernel.SetStdHandle.restype = [wintypes.DWORD, wintypes.HANDLE], wintypes.BOOL
    original = kernel.GetStdHandle(-11)
    mode = wintypes.DWORD()
    if kernel.GetConsoleMode(original, ctypes.byref(mode)) or ctypes.get_last_error() != 5:
        yield
        return

    descriptor = os.open("CONOUT$", os.O_RDWR | os.O_BINARY)
    try:
        handle = msvcrt.get_osfhandle(descriptor)
        if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
            raise OSError("The interactive console cannot be inspected safely.")
        if not kernel.SetStdHandle(-11, handle):
            raise OSError("The interactive console cannot be selected safely.")
        try:
            yield
        finally:
            if not kernel.SetStdHandle(-11, original):
                raise OSError("The original interactive console could not be restored.")
    finally:
        os.close(descriptor)


@contextmanager
def interactive_input() -> Iterator[Callable[[str], str]]:
    """Use the Windows terminal editor only for automatic recovery in a real TTY.

    Pipe/debug consumers retain ordinary input behavior. The stdout proxy owns
    redraws while an answer is printed by the bounded recovery worker; no custom
    cursor handling or persistent input history is introduced.
    """
    if (
        sys.platform != "win32"
        or not getattr(Config, "CONVERSATION_RECOVERY_ENABLED", True)
        or not sys.stdin.isatty()
        or not sys.stdout.isatty()
    ):
        yield input
        return

    with ExitStack() as resources:
        try:
            from prompt_toolkit import PromptSession
            from prompt_toolkit.application import create_app_session
            from prompt_toolkit.completion import NestedCompleter
            from prompt_toolkit.patch_stdout import patch_stdout

            commands = {name: None for name in (*SLASH_COMMANDS, "/resume")}
            commands.update({name: dict.fromkeys(options) for name, options in SUBCOMMANDS.items()})
            resources.enter_context(_readable_windows_console())
            app_session = resources.enter_context(create_app_session())
            session = PromptSession(
                completer=NestedCompleter.from_nested_dict(commands),
                # A real Windows console supports redraw even when TERM is unset
                # or inherited as "dumb". Keep one scoped native output object for
                # both the editor and stdout proxy, then discard its console handle.
                output=app_session.output,
            )
            resources.enter_context(patch_stdout(raw=True))
        except Exception:
            # Only setup is optional. Unwind native handles/proxies before
            # ordinary input, and never reinterpret a partly entered prompt.
            resources.close()
            print("Automatic conversation recovery is unavailable in this terminal; use /resume for pending answers.")
            yield input
            return

        def read(prompt: str) -> str:
            """Read real terminal input while preserving the standard input audit boundary."""
            def ready() -> None:
                # The callback runs after the editor attaches its input reader.
                # Emitting before prompt() can race with native terminal setup.
                asyncio.get_running_loop().call_soon(sys.audit, "builtins.input", prompt)

            return session.prompt(prompt, pre_run=ready)

        # The runner must not start concurrent answer output for builtin input.
        read._arcanos_redraw_safe = True
        yield read
