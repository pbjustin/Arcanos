"""Tests for memory schema persistence behavior."""

from __future__ import annotations

from pathlib import Path

from arcanos.schema import Memory


def test_memory_save_creates_missing_parent_directory(tmp_path: Path) -> None:
    """Saving memory should create missing parent directories for custom paths."""

    memory_path = tmp_path / "nested" / "memory.json"
    memory = Memory(file_path=memory_path)

    memory.set_setting("first_run", False)

    assert memory_path.exists()
    assert memory_path.parent.exists()
