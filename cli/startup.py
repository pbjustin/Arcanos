import os
from pathlib import Path


def verify_persistence_or_raise(memory_file: Path) -> bool:
    """Cheap check: memory file parent directory exists, is a real directory, and is writable."""
    memory_dir = memory_file.parent
    if not memory_dir.exists():
        raise RuntimeError(f"Persistence directory missing: {memory_dir}")
    # Resolve symlinks to verify the real target
    resolved = memory_dir.resolve()
    if not resolved.is_dir():
        raise RuntimeError(f"Persistence path is not a directory: {memory_dir} (resolves to {resolved})")
    # Verify write access (os.access follows symlinks)
    if not os.access(resolved, os.W_OK):
        raise RuntimeError(f"Persistence directory not writable: {resolved}")
    return True


def startup_sequence(memory_file: Path):
    if not verify_persistence_or_raise(memory_file):
        raise RuntimeError("Persistence verification failed; startup halted.")
