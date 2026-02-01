"""
Text content builders for the ARCANOS CLI.
"""


def build_welcome_markdown(version: str) -> str:
    """
    Purpose: Build the welcome message markdown for the CLI.
    Inputs/Outputs: version string; returns formatted markdown string.
    Edge cases: version may be empty, which will still render a generic header.
    """
    return f"""
# ?? Welcome to ARCANOS v{version}

**Your AI-powered terminal companion**

I can chat, see your screen, hear your voice, and help with commands!

Type **help** for available commands or just start chatting naturally.
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
# ?? ARCANOS Commands

### Conversation
- Just type naturally to chat with ARCANOS
- **help** - Show this help message
- **exit** / **quit** - Exit ARCANOS
- **deep <prompt>** / **backend <prompt>** - Force backend routing
- **deep:** / **backend:** - Prefix for backend routing in hybrid mode

### Vision
- **see** - Analyze screenshot
- **see camera** - Analyze webcam image
- **see backend** - Analyze screenshot via backend
- **see camera backend** - Analyze webcam image via backend

### Voice
- **voice** - Use voice input (one-time)
- **voice backend** - Use backend transcription
- **ptt** - Start push-to-talk mode (hold SPACEBAR)
- **speak** - Replay the last response (TTS)

### Terminal
- **run <command>** - Execute shell command (PowerShell on Windows, bash/sh on macOS/Linux)
  Examples: `run Get-Process` (Windows), `run ls -la` (macOS/Linux)

### System
- **stats** - Show usage statistics
- **clear** - Clear conversation history
- **reset** - Reset statistics
- **update** - Check for updates and download installer (if GITHUB_RELEASES_REPO is set)

### Examples
```
You: hey arcanos, what's the weather like today?
You: see
You: run Get-Date
You: voice
You: ptt
```
    """
