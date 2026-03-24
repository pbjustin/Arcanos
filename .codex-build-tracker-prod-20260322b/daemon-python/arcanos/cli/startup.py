"""
Startup persistence checks for CLI runtime.
"""

from __future__ import annotations

import os
from pathlib import Path


def verify_persistence_or_raise(memory_file_path: Path) -> bool:
    """
    Purpose: Validate that the memory directory exists, resolves to a directory, and is writable.
    Inputs/Outputs: memory file path; returns True on success or raises RuntimeError on failure.
    Edge cases: Resolves symlinks before permission checks to avoid validating the wrong target.
    """
    memory_directory = memory_file_path.parent
    # //audit assumption: persistence directory must exist before startup; failure risk: runtime writes fail mid-session; expected invariant: directory exists; handling strategy: raise fail-fast RuntimeError.
    if not memory_directory.exists():
        raise RuntimeError(f"Persistence directory missing: {memory_directory}")

    resolved_directory = memory_directory.resolve()
    # //audit assumption: resolved target must be a real directory; failure risk: path spoofing via files/symlinks; expected invariant: resolved path is directory; handling strategy: raise RuntimeError.
    if not resolved_directory.is_dir():
        raise RuntimeError(
            f"Persistence path is not a directory: {memory_directory} (resolves to {resolved_directory})"
        )

    # //audit assumption: write access is required for memory persistence; failure risk: silent data loss; expected invariant: writable directory; handling strategy: raise RuntimeError on denied permission.
    if not os.access(resolved_directory, os.W_OK):
        raise RuntimeError(f"Persistence directory not writable: {resolved_directory}")

    return True


def startup_sequence(memory_file_path: Path) -> None:
    """
    Purpose: Run startup-time persistence guard checks.
    Inputs/Outputs: memory file path; raises RuntimeError when checks fail.
    Edge cases: Converts boolean check failures into deterministic startup halt.
    """
    # //audit assumption: startup must halt if persistence preflight fails; failure risk: partially initialized runtime with broken writes; expected invariant: successful persistence check before continuing; handling strategy: explicit RuntimeError.
    if not verify_persistence_or_raise(memory_file_path):
        raise RuntimeError("Persistence verification failed; startup halted.")

