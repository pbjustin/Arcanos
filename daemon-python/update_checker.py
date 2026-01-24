"""
In-app update checker for ARCANOS Windows daemon.
Checks GitHub Releases for a newer version and returns download info for ARCANOS-Setup.exe.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

RELEASES_API = "https://api.github.com/repos/{repo}/releases/latest"
RELEASES_LIST = "https://api.github.com/repos/{repo}/releases"


def _parse_version(s: str) -> tuple[int, ...]:
    """Parse 'v1.2.3' or '1.2.3' into (1, 2, 3). Non-numeric parts are treated as 0."""
    s = s.strip().lstrip("vV")
    parts = re.split(r"[\\.-]", s)
    out = []
    for p in parts[:4]:  # limit to major.minor.patch
        try:
            out.append(int(re.sub(r"[^0-9].*", "", p) or "0"))
        except ValueError:
            out.append(0)
    return tuple(out)


def _is_newer(latest: str, current: str) -> bool:
    """True if latest > current."""
    a = _parse_version(latest)
    b = _parse_version(current)
    return a > b


def _find_installer_url(assets: list[dict[str, Any]]) -> str | None:
    """Prefer ARCANOS-Setup.exe, else ARCANOS.exe."""
    for name in ("ARCANOS-Setup.exe", "ARCANOS.exe"):
        for a in assets:
            if (a.get("name") or "").strip() == name:
                url = a.get("browser_download_url")
                if url:
                    return url
    return None


def check_for_updates(
    current_version: str,
    repo: str,
) -> dict[str, Any] | None:
    """
    Check GitHub Releases for a newer version.

    Args:
        current_version: e.g. from config.VERSION
        repo: GitHub "owner/repo", e.g. "arcanos-hybrid/arcanos-hybrid"

    Returns:
        {"available": True, "tag": "v1.0.3", "download_url": "...", "body": "..."}
        or None if up to date, on error, or if repo is empty.
    """
    if not (repo or "").strip():
        return None
    url = RELEASES_API.format(repo=repo.strip())
    try:
        req = urllib.request.Request(url)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        logger.debug("Update check failed: %s", e)
        return None

    tag = (data.get("tag_name") or "").strip()
    if not tag or not _is_newer(tag, current_version):
        return None

    assets = data.get("assets") or []
    download_url = _find_installer_url(assets)
    if not download_url:
        logger.debug("No ARCANOS-Setup.exe or ARCANOS.exe in release assets")
        return None

    return {
        "available": True,
        "tag": tag,
        "download_url": download_url,
        "body": (data.get("body") or "").strip() or None,
    }
