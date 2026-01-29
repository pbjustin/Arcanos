"""
HTTP helpers for backend CLI validation scripts.
"""

from __future__ import annotations

from typing import Dict, Optional


def build_debug_auth_headers(debug_token: Optional[str]) -> Dict[str, str]:
    """
    Purpose: Build authentication headers for debug server requests.
    Inputs/Outputs: optional debug token; returns headers dict.
    Edge cases: returns empty dict when token is missing.
    """
    headers: Dict[str, str] = {}
    if debug_token:
        # //audit assumption: token enables debug auth; risk: unauthorized request; invariant: header added; strategy: include bearer token.
        headers["Authorization"] = f"Bearer {debug_token}"
    return headers
