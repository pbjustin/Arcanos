"""
Startup, first-run setup, and update lifecycle helpers for the CLI.
"""

from __future__ import annotations

import sys
import threading
from typing import Optional, TYPE_CHECKING

from ..cli_debug_helpers import build_debug_marker, resolve_debug_port
from ..cli_ui import (
    build_welcome_markdown,
    get_first_run_setup_header,
    get_telemetry_description_lines,
    get_telemetry_prompt,
    get_telemetry_section_header,
)
from ..cli_config import DEFAULT_DEBUG_SERVER_PORT
from ..config import Config
from ..error_handler import ErrorHandler, logger as error_logger
from ..update_checker import check_for_updates
from cli.startup import startup_sequence

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def ensure_startup_sequence(cli: "ArcanosCLI") -> None:
    """
    Purpose: Validate startup persistence ordering before memory/session hydration.
    Inputs/Outputs: CLI instance; raises SystemExit on startup-sequence failures.
    Edge cases: Exits process with clear message when persistence validation fails.
    """
    try:
        startup_sequence(Config.MEMORY_FILE)
    except RuntimeError as exc:
        # //audit assumption: startup persistence checks are mandatory; risk: corrupted state progression; invariant: fail-fast before runtime initialization; strategy: print and exit.
        cli.console.print(f"[red]{exc}[/red]")
        sys.exit(1)


def show_welcome(cli: "ArcanosCLI") -> None:
    """
    Purpose: Display welcome panel and run first-time setup prompts.
    Inputs/Outputs: CLI instance; prints welcome UI and may mutate settings.
    Edge cases: No-op when SHOW_WELCOME is disabled.
    """
    from rich.markdown import Markdown
    from rich.panel import Panel

    if not Config.SHOW_WELCOME:
        return

    welcome_text = build_welcome_markdown(Config.VERSION)
    cli.console.print(
        Panel(
            Markdown(welcome_text),
            title="ARCANOS",
            border_style="cyan",
        )
    )

    if cli.memory.get_setting("first_run", True):
        first_run_setup(cli)


def first_run_setup(cli: "ArcanosCLI") -> None:
    """
    Purpose: Capture first-run user preferences like telemetry consent.
    Inputs/Outputs: CLI instance; updates persisted settings.
    Edge cases: Skips telemetry prompt when consent already stored.
    """
    cli.console.print(get_first_run_setup_header())

    if cli.memory.get_setting("telemetry_consent") is None:
        cli.console.print(get_telemetry_section_header())
        # //audit assumption: telemetry lines iterable; risk: missing lines; invariant: each description line printed; strategy: iterate descriptions.
        for line in get_telemetry_description_lines():
            cli.console.print(line)

        consent = input(get_telemetry_prompt()).lower().strip()
        cli.memory.set_setting("telemetry_consent", consent == "y")

        if consent == "y":
            Config.TELEMETRY_ENABLED = True
            ErrorHandler.initialize()
            cli.console.print("[green]? Telemetry enabled[/green]")
        else:
            cli.console.print("[green]? Telemetry disabled[/green]")

    cli.memory.set_setting("first_run", False)


def start_update_checker(cli: "ArcanosCLI") -> None:
    """
    Purpose: Spawn background release checker when release repo is configured.
    Inputs/Outputs: CLI instance; mutates _update_info when update exists.
    Edge cases: Silently ignores checker failures while preserving runtime.
    """
    cli._update_info = None
    if not Config.GITHUB_RELEASES_REPO:
        return

    def _check() -> None:
        try:
            info = check_for_updates(Config.VERSION, Config.GITHUB_RELEASES_REPO or "")
            if info:
                cli._update_info = info
                cli.console.print(
                    f"[yellow]Update available: {info['tag']}. Run 'update' to download and install.[/yellow]"
                )
        except Exception as exc:
            # //audit assumption: update checks are non-critical; risk: noisy startup failures; invariant: CLI remains usable; strategy: debug-log failure.
            error_logger.debug("Update check failed: %s", exc)

    threading.Thread(target=_check, daemon=True).start()


def start_debug_server_if_enabled(cli: "ArcanosCLI") -> None:
    """
    Purpose: Start IDE-agent debug server when configured.
    Inputs/Outputs: CLI instance; starts debug server and prints endpoint marker.
    Edge cases: Prints non-fatal warning on startup failure.
    """
    debug_enabled = (
        Config.DEBUG_SERVER_ENABLED
        or Config.IDE_AGENT_DEBUG
        or (Config.DAEMON_DEBUG_PORT and Config.DAEMON_DEBUG_PORT > 0)
    )
    if not debug_enabled:
        return

    try:
        port = resolve_debug_port(
            Config.DEBUG_SERVER_PORT,
            Config.DAEMON_DEBUG_PORT,
            DEFAULT_DEBUG_SERVER_PORT,
        )

        from ..debug_server import start_debug_server
        from arcanos.debug import get_debug_logger

        start_debug_server(cli, port)
        logger = get_debug_logger()
        logger.info(
            "Debug server started",
            extra={
                "port": port,
                "metrics_enabled": Config.DEBUG_SERVER_METRICS_ENABLED,
                "log_level": Config.DEBUG_SERVER_LOG_LEVEL,
            },
        )
        _enc = getattr(sys.stdout, "encoding", "") or ""
        _mark = build_debug_marker(_enc)
        cli.console.print(f"[green]{_mark}[/green] IDE agent debug server on 127.0.0.1:{port}")
    except Exception as exc:
        from arcanos.debug import get_debug_logger

        logger = get_debug_logger()
        logger.exception("Debug server startup failed", extra={"error": str(exc)})
        cli.console.print(f"[yellow]Debug server failed to start: {exc}[/yellow]")


def handle_update(cli: "ArcanosCLI") -> None:
    """
    Purpose: Display update availability and open release page when possible.
    Inputs/Outputs: CLI instance; prints update details and may open browser.
    Edge cases: Returns early when update repo or download URL is missing.
    """
    repo = Config.GITHUB_RELEASES_REPO or ""
    if not repo.strip():
        # //audit assumption: update checks need configured repo; risk: confusing empty checks; invariant: prompt for missing config; strategy: print guidance and return.
        cli.console.print("[yellow]Set GITHUB_RELEASES_REPO (owner/repo) to enable update checks.[/yellow]")
        return

    info = cli._update_info or check_for_updates(Config.VERSION, repo)
    if not info:
        cli.console.print("[green]You're up to date.[/green]")
        return

    url = info.get("download_url") or ""
    tag = info.get("tag", "latest")
    if not url:
        cli.console.print("[red]No download URL in release.[/red]")
        return

    cli.console.print(f"[cyan]Update available: {tag}[/cyan]")
    cli.console.print(f"[yellow]Download URL: {url}[/yellow]")
    cli.console.print("[yellow]Please download and install the update manually from the release page.[/yellow]")

    try:
        import webbrowser

        release_url = f"https://github.com/{repo}/releases/tag/{tag}"
        webbrowser.open(release_url)
        cli.console.print(f"[green]Opened release page in browser: {release_url}[/green]")
    except Exception as exc:
        cli.console.print(f"[yellow]Could not open browser: {exc}[/yellow]")


__all__ = [
    "ensure_startup_sequence",
    "first_run_setup",
    "handle_update",
    "show_welcome",
    "start_debug_server_if_enabled",
    "start_update_checker",
]
