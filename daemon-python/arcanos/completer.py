"""
In-REPL tab completion for ARCANOS slash commands.

Uses Python's readline module to provide tab completion inside the
interactive session.  Falls back gracefully when readline is unavailable
(e.g. Windows without pyreadline3).
"""

from __future__ import annotations

# All top-level slash commands available in the REPL.
SLASH_COMMANDS: list[str] = [
    "/backend",
    "/bye",
    "/clear",
    "/deep",
    "/exit",
    "/help",
    "/ptt",
    "/quit",
    "/reset",
    "/run",
    "/see",
    "/speak",
    "/stats",
    "/update",
    "/voice",
]

# Subcommands keyed by parent command.
SUBCOMMANDS: dict[str, list[str]] = {
    "/see": ["camera", "screen"],
}


def _complete(text: str, state: int) -> str | None:
    """Readline completer callback.

    ``text`` is the current token being completed.
    ``state`` is the index into the list of matches (called repeatedly
    until ``None`` is returned).
    """
    try:
        import readline
    except ImportError:  # pragma: no cover
        return None

    line = readline.get_line_buffer().lstrip()
    parts = line.split()

    # Completing first token — match slash commands.
    if len(parts) <= 1 and not line.endswith(" "):
        matches = [cmd for cmd in SLASH_COMMANDS if cmd.startswith(text)]
    else:
        # Completing a subcommand (e.g. "/see c<TAB>").
        parent = parts[0] if parts else ""
        subs = SUBCOMMANDS.get(parent, [])
        prefix = text
        matches = [s for s in subs if s.startswith(prefix)]

    return matches[state] if state < len(matches) else None


def install_completion() -> None:
    """Set up readline tab completion for the REPL.

    Safe to call on any platform — silently does nothing when readline
    is not available.
    """
    try:
        import readline
    except ImportError:  # pragma: no cover
        return

    readline.set_completer(_complete)
    readline.set_completer_delims(" \t")

    # GNU readline (Linux/macOS) vs libedit (macOS default).
    if "libedit" in (readline.__doc__ or ""):
        readline.parse_and_bind("bind ^I rl_complete")
    else:
        readline.parse_and_bind("tab: complete")
