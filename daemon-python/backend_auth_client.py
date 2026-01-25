"""
Backend authentication helpers for daemon URLs.
"""

from __future__ import annotations


def normalize_backend_url(base_url: str) -> str:
    """
    Purpose: Normalize backend base URL for request building.
    Inputs/Outputs: base_url string; returns normalized URL without trailing slash.
    Edge cases: Empty input returns empty string.
    """
    # //audit assumption: URL is a string; risk: trailing slash duplication; invariant: no trailing slash; strategy: rstrip.
    return base_url.strip().rstrip("/")
