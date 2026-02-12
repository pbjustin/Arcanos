import os
from pathlib import Path
from typing import Any

from .shell import run_shell


MAX_READ_BYTES = 64 * 1024


def _resolve_sandbox_root() -> Path:
    """
    Purpose: Resolve the local filesystem sandbox root for backend actions.
    Inputs/Outputs: None; returns an absolute sandbox root path.
    Edge cases: Missing env override defaults to current working directory.
    """
    configured_root = os.getenv("ARCANOS_V2_SANDBOX_ROOT", "").strip()
    # //audit Assumption: sandbox root must be local and explicit when provided; risk: unrestricted reads; invariant: absolute resolved root; handling: default to cwd.
    if not configured_root:
        return Path.cwd().resolve()
    return Path(configured_root).expanduser().resolve()


def _resolve_safe_read_path(raw_path: str, sandbox_root: Path) -> Path:
    """
    Purpose: Resolve and validate read target path inside sandbox boundaries.
    Inputs/Outputs: raw backend path + sandbox root; returns validated absolute path.
    Edge cases: Raises ValueError when path escapes sandbox root.
    """
    candidate = Path(raw_path).expanduser()
    resolved = (sandbox_root / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()

    try:
        resolved.relative_to(sandbox_root)
    except ValueError as error:
        # //audit Assumption: backend path is untrusted; risk: path traversal to sensitive files; invariant: resolved path stays within sandbox; handling: reject traversal.
        raise ValueError(
            f"Path '{raw_path}' is outside sandbox root '{sandbox_root}'."
        ) from error

    return resolved


def _read_file_with_limit(path: Path) -> dict[str, Any]:
    """
    Purpose: Read file content with a fixed response-size limit.
    Inputs/Outputs: path; returns content payload with truncation metadata.
    Edge cases: Content exceeding MAX_READ_BYTES is truncated safely.
    """
    with path.open("r", encoding="utf-8", errors="replace") as file_handle:
        content = file_handle.read(MAX_READ_BYTES + 1)

    truncated = len(content) > MAX_READ_BYTES
    if truncated:
        content = content[:MAX_READ_BYTES]

    return {
        "path": str(path),
        "content": content,
        "truncated": truncated,
        "max_bytes": MAX_READ_BYTES,
    }


def execute_actions(actions, trace_id: str) -> list[dict[str, Any]]:
    """
    Purpose: Execute structured backend actions with local trust-boundary enforcement.
    Inputs/Outputs: action list + trace id; returns ordered action result payloads.
    Edge cases: Unsupported actions and I/O failures return structured per-action errors.
    """
    results: list[dict[str, Any]] = []
    sandbox_root = _resolve_sandbox_root()

    for index, action in enumerate(actions):
        action_type = getattr(action, "type", "")
        # action is an Action model instance
        if action_type == "shell" and getattr(action, "command", None):
            print(f"[EXECUTOR][{trace_id}] Running shell action #{index + 1}")
            shell_result = run_shell(action.command)
            shell_result["trace_id"] = trace_id
            shell_result["action_index"] = index
            results.append(shell_result)
            continue

        if action_type == "read_file" and getattr(action, "path", None):
            try:
                safe_path = _resolve_safe_read_path(action.path, sandbox_root)
                results.append(
                    {
                        "trace_id": trace_id,
                        "action_index": index,
                        **_read_file_with_limit(safe_path),
                    }
                )
            except FileNotFoundError:
                # //audit Assumption: file may be absent at execution time; risk: stale backend context; invariant: explicit error payload; handling: report not found.
                results.append(
                    {
                        "trace_id": trace_id,
                        "action_index": index,
                        "error": f"File not found: {action.path}",
                    }
                )
            except PermissionError:
                # //audit Assumption: sandboxed files may still be permission-protected; risk: silent denial; invariant: explicit permission failure; handling: report denied.
                results.append(
                    {
                        "trace_id": trace_id,
                        "action_index": index,
                        "error": f"Permission denied: {action.path}",
                    }
                )
            except ValueError as error:
                # //audit Assumption: traversal checks can reject untrusted paths; risk: sandbox escape; invariant: no out-of-root reads; handling: reject and report.
                results.append(
                    {
                        "trace_id": trace_id,
                        "action_index": index,
                        "error": str(error),
                    }
                )
            except OSError as error:
                # //audit Assumption: filesystem errors are possible; risk: unhandled crash; invariant: action loop continues; handling: return structured OSError.
                results.append(
                    {
                        "trace_id": trace_id,
                        "action_index": index,
                        "error": f"I/O error: {error}",
                    }
                )
            continue

        # //audit Assumption: backend can emit unsupported/incomplete actions; risk: undefined behavior; invariant: unsupported actions are skipped safely; handling: explicit skipped payload.
        results.append(
            {
                "trace_id": trace_id,
                "action_index": index,
                "status": "skipped",
                "reason": f"Unsupported or incomplete action type '{action_type}'.",
            }
        )

    return results
