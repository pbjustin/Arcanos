from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Config


IGNORE_DIRS = {
    ".git", "node_modules", ".venv", "venv", "dist", "build",
    ".pytest_cache", ".mypy_cache", "__pycache__"
}


def find_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for _ in range(50):
        if (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            return start.resolve()
        cur = cur.parent
    return start.resolve()


@dataclass
class RepoIndex:
    root: str
    files_count: int
    languages: dict[str, int]
    key_files: list[str]
    sample_paths: list[str]


def _guess_language(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".py": "python",
        ".ts": "typescript",
        ".js": "javascript",
        ".json": "json",
        ".md": "markdown",
        ".yml": "yaml",
        ".yaml": "yaml",
        ".toml": "toml",
    }.get(ext, ext[1:] if ext.startswith(".") else "other")


def build_repo_index(cwd: Path | None = None) -> RepoIndex:
    cwd = (cwd or Path.cwd()).resolve()
    root = find_repo_root(cwd)

    languages: dict[str, int] = {}
    sample: list[str] = []
    key_files: list[str] = []
    files_count = 0

    key_candidates = {"README.md", "pyproject.toml", "package.json", "docker-compose.yml", "Dockerfile", "Makefile"}

    for p in root.rglob("*"):
        if files_count >= Config.REPO_INDEX_MAX_FILES:
            break
        if p.is_dir():
            continue
        if any(part in IGNORE_DIRS for part in p.parts):
            continue
        files_count += 1
        lang = _guess_language(p)
        languages[lang] = languages.get(lang, 0) + 1

        rel = str(p.relative_to(root))
        if p.name in key_candidates and rel not in key_files:
            key_files.append(rel)
        if len(sample) < 200:
            sample.append(rel)

    return RepoIndex(
        root=str(root),
        files_count=files_count,
        languages=dict(sorted(languages.items(), key=lambda kv: kv[1], reverse=True)),
        key_files=key_files,
        sample_paths=sample,
    )


def to_context_payload(index: RepoIndex) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "repoRoot": index.root,
        "filesCount": index.files_count,
        "languages": index.languages,
        "keyFiles": index.key_files,
        "samplePaths": index.sample_paths,
        "ts": int(time.time()),
        "cwd": os.getcwd(),
    }
    if len(str(payload)) > Config.REPO_INDEX_MAX_CHARS:
        payload["samplePaths"] = payload["samplePaths"][:50]
    return payload
