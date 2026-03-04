"""Tests for DATA_DIR path normalization and initialization."""

from __future__ import annotations

import importlib
import shutil
from pathlib import Path


def _reload_config_module():
    """
    Purpose: Reload the config module so env-driven path constants recompute for each test.
    Inputs/Outputs: No inputs; returns the freshly reloaded module.
    Edge cases: Safe across repeated calls in the same pytest process.
    """
    import arcanos.config as config_module

    return importlib.reload(config_module)


def test_data_dir_absolute_override_is_created(monkeypatch, tmp_path):
    """An absolute DATA_DIR override should be honored and created."""
    data_dir = tmp_path / "arcanos-data"
    monkeypatch.setenv("DATA_DIR", str(data_dir))

    config_module = _reload_config_module()

    # //audit assumption: explicit absolute DATA_DIR should control daemon state location; failure risk: writes continue under legacy BASE_DIR; expected invariant: Config.DATA_DIR equals absolute override and exists; handling strategy: assert resolved path + existence.
    assert config_module.Config.DATA_DIR == data_dir
    assert data_dir.exists()
    assert data_dir.is_dir()


def test_data_dir_relative_override_is_anchored_to_base_dir(monkeypatch):
    """A relative DATA_DIR override should be anchored under BASE_DIR."""
    relative_data_dir = "tests-runtime-data-codex"
    monkeypatch.setenv("DATA_DIR", relative_data_dir)

    config_module = _reload_config_module()
    expected_path = config_module.BASE_DIR / Path(relative_data_dir)
    preexisting = expected_path.exists()

    try:
        # //audit assumption: relative DATA_DIR should not depend on process CWD; failure risk: daemon writes to unpredictable locations; expected invariant: relative path anchors to BASE_DIR and is created; handling strategy: assert normalized path + existence.
        assert config_module.Config.DATA_DIR == expected_path
        assert expected_path.exists()
        assert expected_path.is_dir()
    finally:
        if not preexisting:
            shutil.rmtree(expected_path, ignore_errors=True)
