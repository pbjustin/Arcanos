"""
Presentation helpers for the ARCANOS CLI.
"""

from typing import Any, Mapping

from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

from .cli_content import get_help_markdown


def build_stats_table(
    stats: Mapping[str, Any],
    rate_stats: Mapping[str, Any],
    max_requests_per_hour: int,
    max_tokens_per_day: int,
    max_cost_per_day: float,
) -> Table:
    """
    Purpose: Build the usage statistics table for CLI display.
    Inputs/Outputs: stats/rate_stats mappings and limit values; returns a Rich Table.
    Edge cases: Missing keys can raise KeyError if statistics are incomplete.
    """
    table = Table(title="?? ARCANOS Statistics")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")

    # //audit assumption: stats keys exist; risk: KeyError; invariant: rows follow schema; strategy: rely on Memory stats schema.
    table.add_row("Total Requests", f"{stats.get('total_requests', 0):,}")
    table.add_row("Total Tokens", f"{stats.get('total_tokens', 0):,}")
    table.add_row("Total Cost", f"${stats.get('total_cost', 0.0):.4f}")
    table.add_row("Vision Requests", f"{stats.get('vision_requests', 0):,}")
    table.add_row("Voice Requests", f"{stats.get('voice_requests', 0):,}")
    table.add_row("Terminal Commands", f"{stats.get('terminal_commands', 0):,}")
    table.add_row("", "")
    # //audit assumption: rate_stats keys exist; risk: KeyError; invariant: limits displayed; strategy: rely on RateLimiter schema.
    table.add_row("Requests This Hour", f"{rate_stats.get('requests_this_hour', 0)}/{max_requests_per_hour}")
    table.add_row("Tokens Today", f"{rate_stats.get('tokens_today', 0):,}/{max_tokens_per_day:,}")
    table.add_row("Cost Today", f"${rate_stats.get('cost_today', 0.0):.4f}/${max_cost_per_day:.2f}")

    return table


def build_help_panel() -> Panel:
    """
    Purpose: Build the help panel for CLI display.
    Inputs/Outputs: None; returns a Rich Panel.
    Edge cases: Empty markdown still renders an empty panel.
    """
    help_markdown = get_help_markdown()
    # //audit assumption: markdown is valid; risk: render issues; invariant: panel returned; strategy: pass through Rich Markdown.
    return Panel(
        Markdown(help_markdown),
        title="?? ARCANOS Help",
        border_style="cyan",
    )
