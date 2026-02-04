"""
Helpers for CLI debug server setup.
"""

from typing import Optional


def resolve_debug_port(debug_server_port: int, daemon_debug_port: Optional[int], default_port: int) -> int:
    """
    Purpose: Resolve the debug server port with preference for explicit settings.
    Inputs/Outputs: debug_server_port, daemon_debug_port, default_port; returns resolved port int.
    Edge cases: Returns default_port when explicit settings are missing or invalid.
    """
    if debug_server_port > 0:
        # //audit assumption: explicit debug server port is valid; risk: misconfig; invariant: return explicit port; strategy: honor config.
        return debug_server_port
    if daemon_debug_port and daemon_debug_port > 0:
        # //audit assumption: legacy port configured; risk: outdated config; invariant: return legacy port; strategy: fallback to legacy.
        return daemon_debug_port
    # //audit assumption: no explicit port; risk: collision; invariant: use default; strategy: return default_port.
    return default_port


def build_debug_marker(stdout_encoding: str) -> str:
    """
    Purpose: Select a safe debug marker based on stdout encoding.
    Inputs/Outputs: stdout_encoding string; returns ASCII-safe marker when needed.
    Edge cases: Empty encoding falls back to Unicode marker.
    """
    if stdout_encoding and "utf" not in stdout_encoding.lower():
        # //audit assumption: non-UTF encoding may reject Unicode; risk: UnicodeEncodeError; invariant: ASCII marker; strategy: fallback.
        return "[OK]"
    # //audit assumption: UTF encoding supports Unicode; risk: none; invariant: return unicode marker; strategy: use checkmark.
    return "✓"
