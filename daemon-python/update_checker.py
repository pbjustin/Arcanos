"""
In-app update checker for ARCANOS Windows daemon.
Checks GitHub Releases for a newer version and returns download info for ARCANOS-Setup.exe.
"""

from __future__ import annotations

import logging
from typing import Any

import requests
from packaging.version import parse as parse_version

logger = logging.getLogger(__name__)

RELEASES_API = "https://api.github.com/repos/{repo}/releases/latest"
RELEASES_LIST = "https://api.github.com/repos/{repo}/releases"


def _is_newer(latest: str, current: str) -> bool:
    """True if latest > current."""
    return parse_version(latest) > parse_version(current)


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
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as e:
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
