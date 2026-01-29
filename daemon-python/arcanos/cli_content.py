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
