"""Operator-controlled workspace id to local root resolution."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
import stat
from typing import Any, Mapping, Optional

WORKSPACE_MAP_ENV = "ARCANOS_LOCAL_AGENT_WORKSPACES_JSON"
MAX_WORKSPACE_MAP_BYTES = 16 * 1024
_WORKSPACE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_SECRET_FILE_NAMES = {
    ".envrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "auth.json",
    "credentials",
    "credentials.json",
    "docker-config.json",
    "id_dsa",
    "id_ed25519",
    "id_rsa",
    "known_hosts",
    "service-account.json",
}
_SECRET_SUFFIXES = {".jks", ".key", ".p12", ".pfx", ".pem"}
_SECRET_DIRECTORY_NAMES = {
    ".aws",
    ".azure",
    ".docker",
    ".git",
    ".gnupg",
    ".kube",
    ".ssh",
    "browsers",
    "credential-store",
    "credentials-store",
    "gcloud",
}
_SENSITIVE_NAME_FRAGMENT_RE = re.compile(
    r"(?:^|[._-])(?:credentials?|private[_-]?key|secrets?|"
    r"service[_-]?account|tokens?)(?:[._-]|$)",
    re.IGNORECASE,
)
_REPARSE_POINT_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class WorkspaceRegistryError(ValueError):
    """Raised when a local workspace mapping cannot be trusted."""


class RegisteredWorkspaceRegistry:
    """Immutable registry populated only from operator-controlled configuration."""

    def __init__(self, workspaces: Mapping[str, Path | str]) -> None:
        if not isinstance(workspaces, Mapping) or not workspaces:
            raise WorkspaceRegistryError(
                "At least one registered workspace is required"
            )
        roots: dict[str, Path] = {}
        root_identities: dict[str, tuple[int, int]] = {}
        canonical_roots: set[Path] = set()
        for workspace_id, configured_root in workspaces.items():
            if not isinstance(workspace_id, str) or not _WORKSPACE_ID_RE.fullmatch(
                workspace_id
            ):
                raise WorkspaceRegistryError("Workspace id is invalid")
            if not isinstance(configured_root, (str, Path)):
                raise WorkspaceRegistryError("Workspace root is invalid")
            raw_path = Path(configured_root).expanduser()
            if not raw_path.is_absolute():
                raise WorkspaceRegistryError("Workspace root must be absolute")
            try:
                raw_metadata = os.stat(raw_path, follow_symlinks=False)
                if _is_link_or_reparse_metadata(raw_metadata):
                    raise WorkspaceRegistryError(
                        "Workspace root cannot be a symbolic link or reparse point"
                    )
                resolved_root = raw_path.resolve(strict=True)
            except OSError as exc:
                raise WorkspaceRegistryError(
                    "Workspace root cannot be resolved"
                ) from exc
            if not resolved_root.is_dir():
                raise WorkspaceRegistryError("Workspace root must be a directory")
            if resolved_root in canonical_roots:
                raise WorkspaceRegistryError(
                    "A local root cannot be registered to multiple workspaces"
                )
            canonical_roots.add(resolved_root)
            roots[workspace_id] = resolved_root
            root_identities[workspace_id] = (
                int(raw_metadata.st_dev),
                int(raw_metadata.st_ino),
            )
        self._roots = roots
        self._root_identities = root_identities

    @classmethod
    def from_environment(
        cls,
        value: Optional[str] = None,
    ) -> "RegisteredWorkspaceRegistry":
        raw = value if value is not None else os.environ.get(WORKSPACE_MAP_ENV)
        if (
            not isinstance(raw, str)
            or not raw.strip()
            or len(raw.encode("utf-8")) > MAX_WORKSPACE_MAP_BYTES
        ):
            raise WorkspaceRegistryError(
                f"{WORKSPACE_MAP_ENV} must contain a bounded JSON object"
            )
        try:
            parsed: Any = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise WorkspaceRegistryError(
                f"{WORKSPACE_MAP_ENV} is not valid JSON"
            ) from exc
        if not isinstance(parsed, dict):
            raise WorkspaceRegistryError(
                f"{WORKSPACE_MAP_ENV} must contain a JSON object"
            )
        return cls(parsed)

    @property
    def workspace_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._roots))

    def resolve(self, workspace_id: str) -> Path:
        if not isinstance(workspace_id, str) or not _WORKSPACE_ID_RE.fullmatch(
            workspace_id
        ):
            raise WorkspaceRegistryError("Workspace id is invalid")
        root = self._roots.get(workspace_id)
        if root is None:
            raise WorkspaceRegistryError("Workspace is not registered on this device")
        try:
            current_metadata = os.stat(root, follow_symlinks=False)
            current = root.resolve(strict=True)
        except OSError as exc:
            raise WorkspaceRegistryError("Registered workspace is unavailable") from exc
        current_identity = (
            int(current_metadata.st_dev),
            int(current_metadata.st_ino),
        )
        if (
            _is_link_or_reparse_metadata(current_metadata)
            or current != root
            or current_identity != self._root_identities[workspace_id]
            or not current.is_dir()
        ):
            raise WorkspaceRegistryError("Registered workspace identity has changed")
        return root

    def resolve_relative(
        self,
        workspace_id: str,
        relative_path: str,
        *,
        allow_missing: bool = False,
        allow_secret_file: bool = False,
    ) -> Path:
        root = self.resolve(workspace_id)
        if (
            not isinstance(relative_path, str)
            or not relative_path
            or "\x00" in relative_path
            or len(relative_path) > 4096
        ):
            raise WorkspaceRegistryError("Workspace-relative path is invalid")
        untrusted = Path(relative_path)
        if untrusted.is_absolute() or untrusted.drive:
            raise WorkspaceRegistryError("Absolute paths are not allowed")
        if any(part in {"", ".", ".."} for part in untrusted.parts):
            raise WorkspaceRegistryError("Path traversal is not allowed")
        if not allow_secret_file and is_secret_workspace_path(untrusted):
            raise WorkspaceRegistryError("Secret-file access is denied")
        candidate = root.joinpath(untrusted)
        if _contains_link_or_reparse_component(root, candidate):
            raise WorkspaceRegistryError(
                "Symbolic-link and reparse-point paths are not allowed"
            )
        try:
            resolved = candidate.resolve(strict=not allow_missing)
        except OSError as exc:
            raise WorkspaceRegistryError("Workspace path cannot be resolved") from exc
        if not _is_within(root, resolved):
            raise WorkspaceRegistryError("Workspace path escapes its registered root")
        return resolved


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def is_secret_workspace_path(path: Path) -> bool:
    for part in path.parts:
        lowered = part.lower()
        if (
            lowered == ".env"
            or lowered.startswith(".env.")
            or lowered in _SECRET_DIRECTORY_NAMES
            or lowered in _SECRET_FILE_NAMES
            or Path(lowered).suffix in _SECRET_SUFFIXES
            or _SENSITIVE_NAME_FRAGMENT_RE.search(lowered) is not None
        ):
            return True
    return False


def _contains_link_or_reparse_component(root: Path, candidate: Path) -> bool:
    try:
        parts = candidate.relative_to(root).parts
    except ValueError:
        return True
    current = root
    for part in parts:
        current = current / part
        try:
            metadata = os.stat(current, follow_symlinks=False)
        except FileNotFoundError:
            continue
        except OSError:
            return True
        if _is_link_or_reparse_metadata(metadata):
            return True
    return False


def _is_link_or_reparse_metadata(metadata: os.stat_result) -> bool:
    attributes = int(getattr(metadata, "st_file_attributes", 0))
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & _REPARSE_POINT_ATTRIBUTE)


__all__ = [
    "RegisteredWorkspaceRegistry",
    "WORKSPACE_MAP_ENV",
    "WorkspaceRegistryError",
    "is_secret_workspace_path",
]
