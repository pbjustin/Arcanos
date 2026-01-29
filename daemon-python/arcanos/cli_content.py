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
