"""CLI tests for protocol-exposed repository tools."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from arcanos.cli.cli import main


def test_cli_tool_invoke_repo_list_tree(monkeypatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """`arcanos tool.invoke repo.listTree` emits a deterministic protocol response."""

    docs_directory = tmp_path / "docs"
    docs_directory.mkdir()
    (docs_directory / "README.md").write_text("# Arcanos\n", encoding="utf-8")
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "arcanos",
            "tool.invoke",
            "repo.listTree",
            "--input-json",
            json.dumps({"path": ".", "depth": 2}, sort_keys=True),
        ],
    )

    with pytest.raises(SystemExit) as exit_info:
        main()

    captured = capsys.readouterr()
    response = json.loads(captured.out)

    assert exit_info.value.code == 0
    assert response["ok"] is True
    assert response["data"]["toolId"] == "repo.listTree"
    assert any(entry["path"] == "docs/README.md" for entry in response["data"]["result"]["entries"])
