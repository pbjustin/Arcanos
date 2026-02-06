"""
UI content and presentation helpers for the ARCANOS CLI.
"""

import re
from typing import Any, Mapping

from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table


def build_welcome_markdown(version: str) -> str:
    """
    Purpose: Build the welcome message markdown for the CLI.
    Inputs/Outputs: version string; returns formatted markdown string.
    Edge cases: version may be empty, which will still render a generic header.
    """
    return f"""
# Hey! Welcome to ARCANOS v{version}

I'm your AI assistant, right here in the terminal.

I can have conversations, see your screen, listen to your voice, run commands, and more.

Just type what's on your mind, or type **help** to see what I can do.
    """


def get_first_run_setup_header() -> str:
    """
    Purpose: Provide the first-run setup banner text.
    Inputs/Outputs: None; returns formatted header string.
    Edge cases: None.
    """
    return "\n[cyan]?? First time setup[/cyan]"


def get_telemetry_section_header() -> str:
    """
    Purpose: Provide the telemetry section header text.
    Inputs/Outputs: None; returns formatted header string.
    Edge cases: None.
    """
    return "\n[yellow]?? Telemetry & Crash Reporting[/yellow]"


def get_telemetry_description_lines() -> tuple[str, str]:
    """
    Purpose: Provide telemetry description lines for first-run setup.
    Inputs/Outputs: None; returns tuple of strings for printing.
    Edge cases: None.
    """
    return (
        "ARCANOS can send anonymous crash reports to help improve the software.",
        "No personal data, conversations, or API keys are collected.",
    )


def get_telemetry_prompt() -> str:
    """
    Purpose: Provide the telemetry consent prompt text.
    Inputs/Outputs: None; returns formatted prompt string.
    Edge cases: None.
    """
    return "\nEnable telemetry? (y/n): "


def get_help_markdown() -> str:
    """
    Purpose: Provide the help markdown content for CLI help display.
    Inputs/Outputs: None; returns markdown string for the help panel.
    Edge cases: Returns a non-empty string even if commands change.
    """
    return """
# What I can do

### Chat
Just type naturally — ask me anything, and I'll do my best to help.

- **deep <prompt>** — Send a question to the backend for deeper analysis
- **help** — Show this menu
- **exit** / **quit** / **bye** — End our conversation

### See things
- **see** — I'll look at your screen and tell you what I see
- **see camera** — Same thing, but with your webcam

### Listen & speak
- **voice** — Talk to me (one-shot microphone capture)
- **ptt** — Push-to-talk mode (hold SPACEBAR)
- **speak** — I'll read my last response out loud

### Run commands
- **run <command>** — I'll execute a shell command for you
  Example: `run Get-Process` or `run ls -la`

### Housekeeping
- **stats** — See usage stats
- **clear** — Clear conversation history
- **update** — Check for updates

### Try it out
```
You: what's the best way to learn Python?
You: see
You: run Get-Date
You: deep explain quantum computing
```
    """


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


def strip_markdown(text: str) -> str:
    """
    Purpose: Strip markdown formatting from text to produce clean plain text.
    Inputs/Outputs: raw markdown text; returns plain text with formatting removed.
    Edge cases: Empty text returns empty string; nested formatting may leave minor artifacts.
    """
    # Remove code block fences (```language ... ```)
    text = re.sub(r"```[^\n]*\n?", "", text)
    # Remove inline code backticks
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # Remove images ![alt](url) before links
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    # Convert links [text](url) to just text
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Remove bold+italic markers *** and ___
    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"\1", text)
    text = re.sub(r"___(.+?)___", r"\1", text)
    # Remove bold markers ** and __
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    # Remove italic markers * and _ (but not list bullets like "* item")
    text = re.sub(r"(?<!\w)\*([^\s*].*?)\*(?!\w)", r"\1", text)
    text = re.sub(r"(?<!\w)_([^\s_].*?)_(?!\w)", r"\1", text)
    # Remove heading markers
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # Remove horizontal rules
    text = re.sub(r"^[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    # Collapse excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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
        title="ARCANOS Help",
        border_style="cyan",
    )
