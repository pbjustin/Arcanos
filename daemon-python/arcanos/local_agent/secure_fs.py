"""Race-resistant reads and snapshot helpers for registered workspaces."""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path, PurePath
import shutil
import stat
from typing import BinaryIO, Iterator

from .workspace_registry import is_secret_workspace_path

_REPARSE_POINT_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_COPY_BUFFER_BYTES = 1024 * 1024
_MAX_SNAPSHOT_FILES = 100_000
_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024
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


def path_identity(path: Path) -> tuple[int, int]:
    """Return a stable filesystem identity while rejecting links/reparse points."""

    metadata = os.stat(path, follow_symlinks=False)
    if _is_link_or_reparse_metadata(metadata):
        raise PermissionError("Symbolic links and reparse points are not allowed.")
    return int(metadata.st_dev), int(metadata.st_ino)


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
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
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
                copied_bytes += int(metadata.st_size)
                if (
                    copied_files > _MAX_SNAPSHOT_FILES
                    or copied_bytes > _MAX_SNAPSHOT_BYTES
                ):
                    raise ValueError("Sandbox workspace snapshot exceeds safe limits.")
                destination_file = target / relative
                destination_file.parent.mkdir(parents=True, exist_ok=True)
                with destination_file.open("xb") as destination_stream:
                    shutil.copyfileobj(
                        source_stream,
                        destination_stream,
                        length=_COPY_BUFFER_BYTES,
                    )
                try:
                    destination_file.chmod(0o555 if metadata.st_mode & 0o111 else 0o444)
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


def _is_link_or_reparse_metadata(metadata: os.stat_result) -> bool:
    attributes = int(getattr(metadata, "st_file_attributes", 0))
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & _REPARSE_POINT_ATTRIBUTE)


__all__ = [
    "has_link_or_reparse_component",
    "open_workspace_file",
    "path_identity",
    "stage_sanitized_workspace_snapshot",
]
