"""Audit logging helpers for protocol-exposed repository tools."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
from threading import Lock
from typing import Any


class RepoToolAuditLogger:
    """Append deterministic JSONL audit records for repo tool invocations."""

    def __init__(self, workspace_root: Path) -> None:
        configured_path = os.environ.get("ARCANOS_PROTOCOL_AUDIT_LOG")
        self._audit_path = (
            Path(configured_path).expanduser().resolve()
            if configured_path
            else (workspace_root / "logs" / "protocol-repo-tools.audit.jsonl")
        )
        self._lock = Lock()

    def record(
        self,
        *,
        request_id: str,
        tool_id: str,
        caller: dict[str, Any] | None,
        tool_input: dict[str, Any],
        ok: bool,
        error: str | None = None,
    ) -> None:
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "requestId": request_id,
            "toolId": tool_id,
            "caller": caller or {},
            "input": _summarize_tool_input(tool_id, tool_input),
            "ok": ok,
        }
        if error is not None:
            entry["error"] = error

        self._audit_path.parent.mkdir(parents=True, exist_ok=True)
        rendered_entry = json.dumps(entry, sort_keys=True)

        with self._lock:
            with self._audit_path.open("a", encoding="utf-8") as audit_file:
                audit_file.write(rendered_entry)
                audit_file.write("\n")


def _summarize_tool_input(tool_id: str, tool_input: dict[str, Any]) -> dict[str, Any]:
    if tool_id == "repo.readFile":
        return {
            "path": tool_input.get("path"),
            "range": tool_input.get("range"),
            "maxBytes": tool_input.get("maxBytes"),
        }
    if tool_id == "repo.listTree":
        return {
            "path": tool_input.get("path"),
            "depth": tool_input.get("depth"),
            "offset": tool_input.get("offset"),
            "limit": tool_input.get("limit"),
            "includeHidden": bool(tool_input.get("includeHidden", False)),
        }
    if tool_id == "repo.search":
        options = tool_input.get("options") or {}
        return {
            "query": tool_input.get("query"),
            "type": options.get("type"),
            "path": options.get("path"),
            "offset": options.get("offset"),
            "limit": options.get("limit"),
        }
    if tool_id == "repo.getLog":
        return {
            "limit": tool_input.get("limit"),
            "offset": tool_input.get("offset"),
        }
    if tool_id == "repo.getDiff":
        return {
            "base": tool_input.get("base"),
            "head": tool_input.get("head"),
            "contextLines": tool_input.get("contextLines"),
            "maxBytes": tool_input.get("maxBytes"),
        }
    return dict(tool_input)
