"""
Text content builders for the ARCANOS CLI.
Re-exported from cli_ui for backward compatibility.
"""

from .cli_ui import (
    build_welcome_markdown,
    get_first_run_setup_header,
    get_help_markdown,
    get_telemetry_description_lines,
    get_telemetry_prompt,
    get_telemetry_section_header,
)

__all__ = [
    "build_welcome_markdown",
    "get_first_run_setup_header",
    "get_help_markdown",
    "get_telemetry_description_lines",
    "get_telemetry_prompt",
    "get_telemetry_section_header",
]
