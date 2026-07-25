"""Race-resistant reads and snapshot helpers for registered workspaces."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import os
from pathlib import Path, PurePath
import shutil
import stat
import threading
import time
from typing import BinaryIO, Iterator

from .process_runner import run_bounded_process
from .workspace_registry import is_secret_workspace_path

_REPARSE_POINT_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_COPY_BUFFER_BYTES = 1024 * 1024
_MAX_SNAPSHOT_FILES = 100_000
_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024
_MAX_GIT_METADATA_ENTRIES = 250_000
_MAX_GIT_CONFIG_KEYS = 10_000
_MAX_GIT_CONFIG_OUTPUT_CHARS = 1024 * 1024
_MAX_GIT_PROBE_OUTPUT_CHARS = 16 * 1024
_GIT_EXECUTABLE_CONFIG_KEYS = frozenset(
    {
        "core.attributesfile",
        "core.excludesfile",
        "core.hookspath",
        "core.sshcommand",
        "core.worktree",
        "diff.external",
    }
)
_SNAPSHOT_EXCLUDED_DIRECTORIES = frozenset(
    {
        ".cache",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "coverage",
        "dist",
        "node_modules",
        "venv",
    }
)


@dataclass(frozen=True)
class ValidatedGitWorkspace:
    """Server-validated standalone Git metadata rooted in one workspace."""

    root: Path
    git_dir: Path
    root_identity: tuple[int, int]
    git_dir_identity: tuple[int, int]


def path_identity(path: Path) -> tuple[int, int]:
    """Return a stable filesystem identity while rejecting links/reparse points."""

    metadata = os.stat(path, follow_symlinks=False)
    if _is_link_or_reparse_metadata(metadata):
        raise PermissionError("Symbolic links and reparse points are not allowed.")
    return int(metadata.st_dev), int(metadata.st_ino)


def validate_standalone_git_workspace(
    workspace_root: Path,
    *,
    timeout_ms: int,
    cancellation_event: threading.Event | None = None,
) -> ValidatedGitWorkspace:
    """Validate a standalone repository without following external Git metadata.

    Linked worktrees and submodule roots use a ``.git`` indirection file and are
    intentionally unsupported. A main worktree must keep its Git directory,
    common directory, config, object database, and alternates within the
    registered workspace.
    """

    unresolved_root = Path(workspace_root).absolute()
    root_identity = path_identity(unresolved_root)
    root = unresolved_root.resolve(strict=True)
    if not root.is_dir():
        raise PermissionError("Registered Git workspace root is not a directory.")

    git_dir = root / ".git"
    try:
        git_metadata = os.stat(git_dir, follow_symlinks=False)
    except FileNotFoundError as error:
        raise FileNotFoundError(
            f'Workspace root "{root}" is not a Git repository.'
        ) from error
    if _is_link_or_reparse_metadata(git_metadata) or not stat.S_ISDIR(
        git_metadata.st_mode
    ):
        raise PermissionError(
            "Local-agent Git actions require a physical .git directory inside "
            "the registered workspace; linked worktrees and submodule roots are "
            "not supported."
        )
    if has_link_or_reparse_component(root, git_dir):
        raise PermissionError("Git metadata may not contain link or reparse paths.")
    git_dir_identity = (
        int(git_metadata.st_dev),
        int(git_metadata.st_ino),
    )

    for marker_name in ("commondir", "gitdir"):
        marker = git_dir / marker_name
        if os.path.lexists(marker):
            raise PermissionError(
                "Local-agent Git actions do not support linked-worktree metadata."
            )

    deadline = time.monotonic() + max(1, int(timeout_ms)) / 1000
    _assert_link_free_git_metadata(git_dir, deadline=deadline)
    _validate_git_config(
        root,
        git_dir,
        timeout_ms=_remaining_timeout_ms(deadline),
        cancellation_event=cancellation_event,
    )

    top_level = _resolve_reported_git_path(
        root,
        _run_git_probe(
            root,
            ["rev-parse", "--show-toplevel"],
            timeout_ms=_remaining_timeout_ms(deadline),
            cancellation_event=cancellation_event,
        ),
        require_exists=True,
    )
    if top_level != root:
        raise PermissionError(
            "Git reported a worktree outside the registered workspace root."
        )

    reported_git_dir = _resolve_reported_git_path(
        root,
        _run_git_probe(
            root,
            ["rev-parse", "--absolute-git-dir"],
            timeout_ms=_remaining_timeout_ms(deadline),
            cancellation_event=cancellation_event,
        ),
        require_exists=True,
    )
    if reported_git_dir != git_dir:
        raise PermissionError(
            "Git reported metadata outside the registered standalone repository."
        )

    reported_common_dir = _resolve_reported_git_path(
        root,
        _run_git_probe(
            root,
            ["rev-parse", "--git-common-dir"],
            timeout_ms=_remaining_timeout_ms(deadline),
            cancellation_event=cancellation_event,
        ),
        require_exists=True,
    )
    if reported_common_dir != git_dir:
        raise PermissionError(
            "Git common-directory indirection is not supported by local-agent actions."
        )

    expected_alternates_file = git_dir / "objects" / "info" / "alternates"
    reported_alternates_file = _resolve_reported_git_path(
        root,
        _run_git_probe(
            root,
            ["rev-parse", "--git-path", "objects/info/alternates"],
            timeout_ms=_remaining_timeout_ms(deadline),
            cancellation_event=cancellation_event,
        ),
        require_exists=False,
    )
    if reported_alternates_file != expected_alternates_file:
        raise PermissionError(
            "Git object-alternate metadata escaped the standalone repository."
        )
    _validate_git_alternates(root, git_dir, expected_alternates_file)

    if (
        path_identity(root) != root_identity
        or path_identity(git_dir) != git_dir_identity
    ):
        raise PermissionError("Git workspace identity changed during validation.")
    return ValidatedGitWorkspace(
        root=root,
        git_dir=git_dir,
        root_identity=root_identity,
        git_dir_identity=git_dir_identity,
    )


def build_validated_git_argv(
    workspace: ValidatedGitWorkspace,
    args: list[str] | tuple[str, ...],
) -> list[str]:
    """Build a fixed Git argv pinned to validated local metadata and worktree."""

    return [
        "git",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "credential.helper=",
        "-c",
        "submodule.recurse=false",
        f"--git-dir={workspace.git_dir}",
        f"--work-tree={workspace.root}",
        *args,
    ]


def _run_git_probe(
    root: Path,
    args: list[str],
    *,
    timeout_ms: int,
    cancellation_event: threading.Event | None,
) -> str:
    result = run_bounded_process(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "credential.helper=",
            "-c",
            "submodule.recurse=false",
            "-C",
            str(root),
            *args,
        ],
        cwd=root,
        timeout_ms=timeout_ms,
        max_output_chars=_MAX_GIT_PROBE_OUTPUT_CHARS,
        cancellation_event=cancellation_event,
    )
    if result.exit_code != 0 or result.truncated:
        raise PermissionError("Git repository containment could not be verified.")
    output = result.stdout.strip()
    if not output or "\n" in output or "\r" in output or "\x00" in output:
        raise PermissionError("Git repository containment returned an invalid path.")
    return output


def _resolve_reported_git_path(
    root: Path,
    value: str,
    *,
    require_exists: bool,
) -> Path:
    reported = Path(value)
    candidate = reported if reported.is_absolute() else root / reported
    try:
        resolved = candidate.resolve(strict=require_exists)
        resolved.relative_to(root)
    except (OSError, ValueError) as error:
        raise PermissionError(
            "Git reported a path outside the registered workspace."
        ) from error
    if has_link_or_reparse_component(root, resolved):
        raise PermissionError("Git reported a link or reparse path.")
    return resolved


def _assert_link_free_git_metadata(git_dir: Path, *, deadline: float) -> None:
    entry_count = 0
    for directory, directory_names, file_names in os.walk(
        git_dir,
        topdown=True,
        followlinks=False,
    ):
        if time.monotonic() >= deadline:
            raise TimeoutError("Git metadata containment validation timed out.")
        directory_path = Path(directory)
        path_identity(directory_path)
        for name in (*directory_names, *file_names):
            entry_count += 1
            if entry_count > _MAX_GIT_METADATA_ENTRIES:
                raise PermissionError("Git metadata exceeds the safe validation limit.")
            child = directory_path / name
            try:
                metadata = os.stat(child, follow_symlinks=False)
            except OSError as error:
                raise PermissionError(
                    "Git metadata could not be inspected safely."
                ) from error
            if _is_link_or_reparse_metadata(metadata):
                raise PermissionError(
                    "Git metadata may not contain symbolic links or reparse points."
                )


def _validate_git_config(
    root: Path,
    git_dir: Path,
    *,
    timeout_ms: int,
    cancellation_event: threading.Event | None,
) -> None:
    config_paths = [
        path
        for path in (git_dir / "config", git_dir / "config.worktree")
        if path.exists()
    ]
    for config_path in config_paths:
        _validate_git_config_file(
            root,
            config_path,
            timeout_ms=timeout_ms,
            cancellation_event=cancellation_event,
        )


def _validate_git_config_file(
    root: Path,
    config_path: Path,
    *,
    timeout_ms: int,
    cancellation_event: threading.Event | None,
) -> None:
    if has_link_or_reparse_component(root, config_path):
        raise PermissionError("Git config may not be a link or reparse path.")
    result = run_bounded_process(
        [
            "git",
            "config",
            "--file",
            str(config_path),
            "--null",
            "--name-only",
            "--list",
            "--no-includes",
        ],
        cwd=root,
        timeout_ms=timeout_ms,
        max_output_chars=_MAX_GIT_CONFIG_OUTPUT_CHARS,
        cancellation_event=cancellation_event,
        preserve_nul=True,
    )
    if result.exit_code != 0 or result.truncated:
        raise PermissionError("Git config could not be validated safely.")
    keys = [
        key.strip().casefold() for key in result.stdout.split("\x00") if key.strip()
    ]
    if len(keys) > _MAX_GIT_CONFIG_KEYS:
        raise PermissionError("Git config exceeds the safe validation limit.")
    for key in keys:
        if (
            key in _GIT_EXECUTABLE_CONFIG_KEYS
            or key.startswith("include.")
            or key.startswith("includeif.")
            or (
                key.startswith("diff.")
                and (key.endswith(".command") or key.endswith(".textconv"))
            )
            or (
                key.startswith("filter.")
                and (
                    key.endswith(".clean")
                    or key.endswith(".smudge")
                    or key.endswith(".process")
                )
            )
            or (key.startswith("submodule.") and key.endswith(".update"))
        ):
            raise PermissionError(
                "Git config contains local-agent-unsafe path or executable settings."
            )


def _validate_git_alternates(
    root: Path,
    git_dir: Path,
    alternates_file: Path,
) -> None:
    if not os.path.lexists(alternates_file):
        return
    if has_link_or_reparse_component(root, alternates_file):
        raise PermissionError(
            "Git alternates metadata may not be a link or reparse path."
        )
    with open_workspace_file(root, alternates_file.relative_to(root)) as stream:
        data = stream.read(64 * 1024 + 1)
    if len(data) > 64 * 1024:
        raise PermissionError("Git alternates metadata exceeds the safe limit.")
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise PermissionError("Git alternates metadata is not valid UTF-8.") from error
    object_directory = git_dir / "objects"
    for line in lines:
        value = line.strip()
        if not value:
            continue
        if (
            value.startswith('"')
            or "\x00" in value
            or any(ord(character) < 0x20 for character in value)
        ):
            raise PermissionError("Git alternates metadata contains an unsafe path.")
        alternate = Path(value)
        candidate = (
            alternate if alternate.is_absolute() else object_directory / alternate
        )
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root)
        except (OSError, ValueError) as error:
            raise PermissionError(
                "Git object alternates must remain inside the registered workspace."
            ) from error
        if not resolved.is_dir() or has_link_or_reparse_component(root, resolved):
            raise PermissionError("Git object alternate path is not a safe directory.")


def _remaining_timeout_ms(deadline: float) -> int:
    remaining_ms = int((deadline - time.monotonic()) * 1000)
    if remaining_ms <= 0:
        raise TimeoutError("Git metadata containment validation timed out.")
    return remaining_ms


def has_link_or_reparse_component(root: Path, candidate: Path) -> bool:
    """Return whether an existing path component is a link or reparse point."""

    try:
        relative_parts = candidate.relative_to(root).parts
    except ValueError:
        return True
    current = root
    for part in relative_parts:
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


@contextmanager
def open_workspace_file(
    workspace_root: Path,
    relative_path: str | PurePath,
) -> Iterator[BinaryIO]:
    """Open a regular workspace file without following POSIX path links.

    POSIX walks every component relative to already-open directory descriptors,
    preventing a checked directory from being swapped for a symlink before the
    file is opened. Windows rejects reparse components before and after opening,
    but Python does not expose a fully descriptor-relative Win32 directory walk;
    callers must still keep registered workspaces private from local attackers.
    """

    root = Path(workspace_root).absolute()
    relative = PurePath(relative_path)
    if (
        not relative.parts
        or relative.is_absolute()
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise PermissionError("Workspace-relative file path is invalid.")
    root_metadata = os.stat(root, follow_symlinks=False)
    if _is_link_or_reparse_metadata(root_metadata) or not stat.S_ISDIR(
        root_metadata.st_mode
    ):
        raise PermissionError("Registered workspace root is not a regular directory.")

    if os.name != "nt" and hasattr(os, "O_DIRECTORY"):
        with _open_posix_workspace_file(root, root_metadata, relative.parts) as stream:
            yield stream
        return

    candidate = root.joinpath(*relative.parts)
    if has_link_or_reparse_component(root, candidate):
        raise PermissionError("Symbolic-link and reparse-point access is denied.")

    flags = os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(candidate, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise PermissionError("Only regular workspace files may be read.")
        if has_link_or_reparse_component(root, candidate):
            raise PermissionError("Workspace path identity changed during access.")
        current_root_metadata = os.stat(root, follow_symlinks=False)
        if (
            int(current_root_metadata.st_dev),
            int(current_root_metadata.st_ino),
        ) != (int(root_metadata.st_dev), int(root_metadata.st_ino)):
            raise PermissionError("Workspace root identity changed during access.")
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            descriptor = -1
            yield stream
    finally:
        if descriptor >= 0:
            os.close(descriptor)


@contextmanager
def _open_posix_workspace_file(
    root: Path,
    expected_root_metadata: os.stat_result,
    relative_parts: tuple[str, ...],
) -> Iterator[BinaryIO]:
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    file_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    directory_descriptor = os.open(root, directory_flags)
    file_descriptor = -1
    try:
        opened_root_metadata = os.fstat(directory_descriptor)
        if (
            int(opened_root_metadata.st_dev),
            int(opened_root_metadata.st_ino),
        ) != (
            int(expected_root_metadata.st_dev),
            int(expected_root_metadata.st_ino),
        ):
            raise PermissionError("Workspace root identity changed during access.")

        for part in relative_parts[:-1]:
            next_descriptor = os.open(
                part,
                directory_flags,
                dir_fd=directory_descriptor,
            )
            os.close(directory_descriptor)
            directory_descriptor = next_descriptor

        file_descriptor = os.open(
            relative_parts[-1],
            file_flags,
            dir_fd=directory_descriptor,
        )
        metadata = os.fstat(file_descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise PermissionError("Only regular workspace files may be read.")
        with os.fdopen(file_descriptor, "rb", closefd=True) as stream:
            file_descriptor = -1
            yield stream
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        if directory_descriptor >= 0:
            os.close(directory_descriptor)


def stage_sanitized_workspace_snapshot(
    workspace_root: Path,
    destination: Path,
) -> tuple[int, int]:
    """Copy a bounded, secret-free, link-free workspace snapshot."""

    root = Path(workspace_root).resolve(strict=True)
    target = Path(destination).resolve()
    if target.exists() and any(target.iterdir()):
        raise ValueError("Sandbox snapshot destination must be empty.")
    target.mkdir(parents=True, exist_ok=True)

    copied_files = 0
    copied_bytes = 0
    try:
        for directory, directory_names, file_names in os.walk(
            root,
            followlinks=False,
        ):
            source_directory = Path(directory)
            relative_directory = source_directory.relative_to(root)
            safe_directories: list[str] = []
            for directory_name in sorted(directory_names, key=str.casefold):
                relative = relative_directory / directory_name
                candidate = source_directory / directory_name
                if (
                    directory_name.casefold() in _SNAPSHOT_EXCLUDED_DIRECTORIES
                    or is_secret_workspace_path(relative)
                    or has_link_or_reparse_component(root, candidate)
                ):
                    continue
                safe_directories.append(directory_name)
                (target / relative).mkdir(parents=True, exist_ok=True)
            directory_names[:] = safe_directories

            for file_name in sorted(file_names, key=str.casefold):
                relative = relative_directory / file_name
                if is_secret_workspace_path(relative):
                    continue
                source = source_directory / file_name
                if has_link_or_reparse_component(root, source):
                    continue
                with open_workspace_file(root, relative) as source_stream:
                    metadata = os.fstat(source_stream.fileno())
                    copied_files += 1
                    if copied_files > _MAX_SNAPSHOT_FILES:
                        raise ValueError(
                            "Sandbox workspace snapshot exceeds safe limits."
                        )
                    destination_file = target / relative
                    destination_file.parent.mkdir(parents=True, exist_ok=True)
                    with destination_file.open("xb") as destination_stream:
                        while True:
                            chunk = source_stream.read(_COPY_BUFFER_BYTES)
                            if not chunk:
                                break
                            copied_bytes += len(chunk)
                            if copied_bytes > _MAX_SNAPSHOT_BYTES:
                                raise ValueError(
                                    "Sandbox workspace snapshot exceeds safe limits."
                                )
                            destination_stream.write(chunk)
                    try:
                        destination_file.chmod(
                            0o555 if metadata.st_mode & 0o111 else 0o444
                        )
                    except OSError:
                        pass
        for directory, directory_names, _file_names in os.walk(
            target,
            topdown=False,
            followlinks=False,
        ):
            for directory_name in directory_names:
                try:
                    (Path(directory) / directory_name).chmod(0o555)
                except OSError:
                    pass
            try:
                Path(directory).chmod(0o555)
            except OSError:
                pass
        return copied_files, copied_bytes
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


def _is_link_or_reparse_metadata(metadata: os.stat_result) -> bool:
    attributes = int(getattr(metadata, "st_file_attributes", 0))
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & _REPARSE_POINT_ATTRIBUTE)


__all__ = [
    "ValidatedGitWorkspace",
    "build_validated_git_argv",
    "has_link_or_reparse_component",
    "open_workspace_file",
    "path_identity",
    "stage_sanitized_workspace_snapshot",
    "validate_standalone_git_workspace",
]
