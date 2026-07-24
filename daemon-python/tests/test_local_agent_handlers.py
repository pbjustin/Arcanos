"""Focused tests for the local-agent handler/security core."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import sys

import pytest

from arcanos.local_agent import contracts as local_agent_contracts
from arcanos.protocol_runtime.tools import repository_tools
from arcanos.local_agent.handlers import (
    LOCAL_AGENT_ACTIONS,
    build_local_agent_handler_registry,
    execute_local_agent_action,
)
from arcanos.local_agent.contracts import load_local_agent_capability_catalog
from arcanos.local_agent.patch_handler import (
    issue_patch_execution_authorization,
)
from arcanos.local_agent.process_runner import (
    ProcessResult,
    run_bounded_process,
    sanitized_subprocess_environment,
)
from arcanos.protocol_runtime.tools.repository_tools import (
    get_repository_diff,
    get_repository_status,
    read_repository_file,
    search_repository,
)


def _initialize_git_repository(workspace_root: Path) -> None:
    subprocess.run(
        ["git", "init"],
        cwd=workspace_root,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "tests@example.invalid"],
        cwd=workspace_root,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "ARCANOS Tests"],
        cwd=workspace_root,
        check=True,
        capture_output=True,
    )


def _commit_all(workspace_root: Path, message: str) -> str:
    subprocess.run(
        ["git", "add", "."],
        cwd=workspace_root,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "commit", "-m", message],
        cwd=workspace_root,
        check=True,
        capture_output=True,
    )
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=workspace_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _sample_patch() -> str:
    return "\n".join(
        [
            "diff --git a/sample.txt b/sample.txt",
            "--- a/sample.txt",
            "+++ b/sample.txt",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "",
        ]
    )


def test_registry_exposes_only_the_seven_public_actions() -> None:
    registry = build_local_agent_handler_registry()

    assert tuple(registry) == LOCAL_AGENT_ACTIONS
    assert set(registry) == {
        "local_agent.status",
        "repo.search",
        "git.status",
        "git.diff",
        "tests.run",
        "patch.preview",
        "patch.apply",
    }
    assert tuple(load_local_agent_capability_catalog()) == LOCAL_AGENT_ACTIONS


def test_packaged_catalog_supports_standalone_daemon(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    load_local_agent_capability_catalog.cache_clear()

    def missing_repository() -> Path:
        raise FileNotFoundError("standalone install")

    monkeypatch.setattr(
        local_agent_contracts,
        "resolve_repository_root",
        missing_repository,
    )
    try:
        catalog = load_local_agent_capability_catalog()
        assert tuple(catalog) == LOCAL_AGENT_ACTIONS
    finally:
        load_local_agent_capability_catalog.cache_clear()


def test_repo_search_handler_reuses_existing_repository_tool(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    observed: dict[str, object] = {}

    def fake_search(
        payload: dict[str, object],
        *,
        workspace_root: Path,
        timeout_ms: int,
    ) -> dict[str, object]:
        observed["payload"] = payload
        observed["workspace_root"] = workspace_root
        observed["timeout_ms"] = timeout_ms
        return {
            "rootPath": str(workspace_root),
            "query": "needle",
            "searchType": "text",
            "offset": 0,
            "limit": 50,
            "searchedFileCount": 0,
            "matches": [],
            "truncated": False,
        }

    monkeypatch.setattr(
        "arcanos.local_agent.handlers.repository_tools.search_repository",
        fake_search,
    )

    result = execute_local_agent_action(
        "repo.search",
        {"query": "needle"},
        tmp_path,
        1000,
    )

    assert observed == {
        "payload": {"query": "needle"},
        "workspace_root": tmp_path.resolve(),
        "timeout_ms": 1000,
    }
    assert result == {
        "query": "needle",
        "searchType": "text",
        "offset": 0,
        "limit": 50,
        "searchedFileCount": 0,
        "matches": [],
        "truncated": False,
    }


def test_repo_search_denies_secret_files_even_when_hidden_files_are_requested(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    (tmp_path / ".env").write_text("needle=secret\n", encoding="utf-8")
    (tmp_path / "credentials.json").write_text("needle=secret\n", encoding="utf-8")
    (tmp_path / "safe.txt").write_text("needle=safe\n", encoding="utf-8")
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))

    result = search_repository(
        {
            "query": "needle",
            "options": {"includeHidden": True},
        }
    )

    assert [match["path"] for match in result["matches"]] == ["safe.txt"]
    with pytest.raises(PermissionError, match="Secret files"):
        read_repository_file({"path": ".env"})


def test_repo_search_skips_file_symlink_that_escapes_workspace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    outside_file = tmp_path / "outside.txt"
    outside_file.write_text("needle outside\n", encoding="utf-8")
    link_path = workspace_root / "linked.txt"
    try:
        os.symlink(outside_file, link_path)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"Symlinks are unavailable in this test environment: {error}")
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(workspace_root))

    result = search_repository({"query": "needle"})

    assert result["matches"] == []
    assert result["searchedFileCount"] == 0


def test_repo_search_rejects_symlink_aliases_to_secret_and_git_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / ".git").mkdir()
    (workspace_root / ".env").write_text("needle=secret\n", encoding="utf-8")
    (workspace_root / ".git" / "config").write_text(
        "needle=secret\n",
        encoding="utf-8",
    )
    public_link = workspace_root / "public.txt"
    settings_link = workspace_root / "settings.txt"
    try:
        os.symlink(workspace_root / ".env", public_link)
        os.symlink(workspace_root / ".git" / "config", settings_link)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"Symlinks are unavailable in this test environment: {error}")
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(workspace_root))

    result = search_repository(
        {
            "query": "needle",
            "options": {"includeHidden": True},
        }
    )

    assert result["matches"] == []
    with pytest.raises(ValueError, match="Symbolic-link paths"):
        search_repository(
            {
                "query": "needle",
                "options": {"path": "public.txt", "includeHidden": True},
            }
        )
    with pytest.raises(ValueError, match="Symbolic-link paths"):
        search_repository(
            {
                "query": "needle",
                "options": {"path": "settings.txt", "includeHidden": True},
            }
        )


def test_repo_search_stops_at_scan_budget(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    (tmp_path / "first.txt").write_text("safe\n", encoding="utf-8")
    (tmp_path / "second.txt").write_text("safe\n", encoding="utf-8")
    monkeypatch.setattr(repository_tools, "MAX_SEARCH_SCANNED_FILES", 1)

    result = search_repository(
        {"query": "missing"},
        workspace_root=tmp_path,
        timeout_ms=5000,
    )

    assert result["searchedFileCount"] == 1
    assert result["truncated"] is True


def test_repo_search_stops_at_timeout(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    (tmp_path / "safe.txt").write_text("safe\n", encoding="utf-8")
    timestamps = iter((0.0, 1.0))
    monkeypatch.setattr(repository_tools.time, "monotonic", timestamps.__next__)

    result = search_repository(
        {"query": "missing"},
        workspace_root=tmp_path,
        timeout_ms=1,
    )

    assert result["searchedFileCount"] == 0
    assert result["truncated"] is True


def test_repo_search_rejects_path_traversal(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))

    with pytest.raises(ValueError, match="bound workspace root"):
        search_repository(
            {
                "query": "needle",
                "options": {"path": "../outside"},
            }
        )
    with pytest.raises(ValueError, match="bound workspace root"):
        search_repository(
            {
                "query": "needle",
                "options": {"path": "C:/outside"},
            }
        )


def test_git_status_does_not_disclose_secret_paths(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _initialize_git_repository(tmp_path)
    (tmp_path / ".env").write_text("OPENAI_API_KEY=placeholder\n", encoding="utf-8")
    (tmp_path / "safe.txt").write_text("safe\n", encoding="utf-8")
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))

    result = get_repository_status({})

    assert [change["path"] for change in result["changes"]] == ["safe.txt"]


def test_git_diff_validates_refs_and_excludes_secret_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _initialize_git_repository(tmp_path)
    (tmp_path / ".env").write_text("TOKEN=old\n", encoding="utf-8")
    (tmp_path / "safe.txt").write_text("old\n", encoding="utf-8")
    base = _commit_all(tmp_path, "base")
    (tmp_path / ".env").write_text("TOKEN=new\n", encoding="utf-8")
    (tmp_path / "safe.txt").write_text("new\n", encoding="utf-8")
    head = _commit_all(tmp_path, "head")
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))

    result = get_repository_diff({"base": base, "head": head})

    assert "safe.txt" in result["diff"]
    assert ".env" not in result["diff"]
    assert "TOKEN=" not in result["diff"]
    with pytest.raises(ValueError, match="safe Git revision"):
        get_repository_diff({"base": "--stat", "head": head})


def test_git_diff_filters_every_denied_tracked_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _initialize_git_repository(tmp_path)
    secret_directory = tmp_path / "café"
    secret_directory.mkdir()
    secret_file = secret_directory / "auth.json"
    secret_file.write_text(
        '{"authorization":"old-secret-sentinel"}\n',
        encoding="utf-8",
    )
    (tmp_path / "café notes.txt").write_text("old-safe\n", encoding="utf-8")
    base = _commit_all(tmp_path, "base")
    secret_file.write_text(
        '{"authorization":"new-secret-sentinel"}\n',
        encoding="utf-8",
    )
    (tmp_path / "café notes.txt").write_text("new-safe\n", encoding="utf-8")
    head = _commit_all(tmp_path, "head")
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))

    result = get_repository_diff({"base": base, "head": head})

    assert "auth.json" not in result["diff"]
    assert "secret-sentinel" not in result["diff"]
    assert "old-safe" in result["diff"]
    assert "new-safe" in result["diff"]


def test_process_runner_uses_sanitized_environment_and_truncates_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-propagate")
    environment = sanitized_subprocess_environment()

    assert "OPENAI_API_KEY" not in environment

    result = run_bounded_process(
        [sys.executable, "-c", "print('x' * 5000)"],
        cwd=tmp_path,
        timeout_ms=5000,
        max_output_chars=100,
    )

    assert result.exit_code == 0
    assert result.truncated is True
    assert result.stdout.endswith("[truncated]")
    assert len(result.stdout) < 140


def test_process_runner_enforces_timeout(tmp_path: Path) -> None:
    with pytest.raises(TimeoutError, match="timed out"):
        run_bounded_process(
            [sys.executable, "-c", "import time; time.sleep(5)"],
            cwd=tmp_path,
            timeout_ms=50,
        )


def test_process_runner_rejects_executable_inside_workspace(tmp_path: Path) -> None:
    local_executable = tmp_path / "git.exe"
    local_executable.write_bytes(b"not-an-executable")

    with pytest.raises(PermissionError, match="inside the registered workspace"):
        run_bounded_process(
            [str(local_executable), "status"],
            cwd=tmp_path,
            timeout_ms=5000,
        )


def test_tests_run_accepts_only_fixed_profiles_and_fixed_argv(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    daemon_root = tmp_path / "daemon-python"
    daemon_root.mkdir()
    observed: list[tuple[tuple[str, ...], Path]] = []
    monkeypatch.setenv(
        "ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS",
        "true",
    )
    monkeypatch.setenv(
        "ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE",
        "unsandboxed-development-only",
    )

    def fake_run(
        argv: tuple[str, ...],
        *,
        cwd: Path,
        timeout_ms: int,
        extra_environment: object,
    ) -> ProcessResult:
        assert isinstance(extra_environment, dict)
        assert set(extra_environment) == {"PYTHONNOUSERSITE", "PYTHONPATH"}
        observed.append((tuple(argv), cwd))
        return ProcessResult(tuple(argv), 0, "passed", "", 10, False)

    monkeypatch.setattr(
        "arcanos.local_agent.handlers.run_bounded_process",
        fake_run,
    )

    result = execute_local_agent_action(
        "tests.run",
        {"profile": "python-unit"},
        tmp_path,
        5000,
    )

    assert result["status"] == "passed"
    assert observed == [((sys.executable, "-m", "pytest", "tests/"), daemon_root)]
    with pytest.raises(ValueError, match="generated schema"):
        execute_local_agent_action(
            "tests.run",
            {"profile": "python-unit", "command": "whoami"},
            tmp_path,
            5000,
        )


def test_tests_run_is_disabled_without_explicit_unsandboxed_opt_in(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv(
        "ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS",
        raising=False,
    )
    monkeypatch.setenv("ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE", "disabled")

    with pytest.raises(PermissionError, match="disabled by operator policy"):
        execute_local_agent_action(
            "tests.run",
            {"profile": "python-unit"},
            tmp_path,
            5000,
        )


def test_tests_run_rejects_symlinked_daemon_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    outside_daemon_root = tmp_path / "outside-daemon"
    outside_daemon_root.mkdir()
    daemon_link = workspace_root / "daemon-python"
    try:
        os.symlink(outside_daemon_root, daemon_link, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"Symlinks are unavailable in this test environment: {error}")
    monkeypatch.setenv(
        "ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS",
        "true",
    )
    monkeypatch.setenv(
        "ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE",
        "unsandboxed-development-only",
    )

    with pytest.raises(PermissionError, match="cannot be a symbolic link"):
        execute_local_agent_action(
            "tests.run",
            {"profile": "python-unit"},
            workspace_root,
            5000,
        )


def test_patch_preview_checks_without_mutating(tmp_path: Path) -> None:
    _initialize_git_repository(tmp_path)
    sample_file = tmp_path / "sample.txt"
    sample_file.write_bytes(b"old\n")
    patch_text = _sample_patch()

    result = execute_local_agent_action(
        "patch.preview",
        {"patch": patch_text},
        tmp_path,
        5000,
    )

    assert result["applicable"] is True
    assert (
        result["patchSha256"] == hashlib.sha256(patch_text.encode("utf-8")).hexdigest()
    )
    assert sample_file.read_text(encoding="utf-8") == "old\n"


def test_patch_preview_and_apply_reject_git_quoted_secret_path(
    tmp_path: Path,
) -> None:
    _initialize_git_repository(tmp_path)
    secret_file = tmp_path / ".env"
    secret_file.write_text("old\n", encoding="utf-8")
    patch_text = "\n".join(
        [
            r'diff --git "a/\056env" "b/\056env"',
            r'--- "a/\056env"',
            r'+++ "b/\056env"',
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "",
        ]
    )
    payload = {
        "patch": patch_text,
        "expectedPatchSha256": hashlib.sha256(patch_text.encode("utf-8")).hexdigest(),
    }

    with pytest.raises(PermissionError, match="patch_targets_secret_file"):
        execute_local_agent_action(
            "patch.preview",
            {"patch": patch_text},
            tmp_path,
            5000,
        )

    patch_authorization = issue_patch_execution_authorization(
        payload,
        authorization_id="job:test-secret-path",
    )
    with pytest.raises(PermissionError, match="patch_targets_secret_file"):
        execute_local_agent_action(
            "patch.apply",
            payload,
            tmp_path,
            5000,
            mutation_authorization=patch_authorization,
        )

    assert secret_file.read_text(encoding="utf-8") == "old\n"


def test_patch_apply_requires_separate_exact_payload_authorization(
    tmp_path: Path,
) -> None:
    _initialize_git_repository(tmp_path)
    sample_file = tmp_path / "sample.txt"
    sample_file.write_bytes(b"old\n")
    patch_text = _sample_patch()
    patch_hash = hashlib.sha256(patch_text.encode("utf-8")).hexdigest()
    payload = {
        "patch": patch_text,
        "expectedPatchSha256": patch_hash,
    }

    with pytest.raises(PermissionError, match="trusted authorization"):
        execute_local_agent_action(
            "patch.apply",
            payload,
            tmp_path,
            5000,
        )

    wrong_authorization = issue_patch_execution_authorization(
        {**payload, "expectedPatchSha256": "0" * 64},
        authorization_id="job:test",
    )
    with pytest.raises(PermissionError, match="trusted authorization"):
        execute_local_agent_action(
            "patch.apply",
            payload,
            tmp_path,
            5000,
            mutation_authorization=wrong_authorization,
        )

    patch_authorization = issue_patch_execution_authorization(
        payload,
        authorization_id="job:test",
    )
    result = execute_local_agent_action(
        "patch.apply",
        payload,
        tmp_path,
        5000,
        mutation_authorization=patch_authorization,
    )

    assert result == {
        "patchSha256": patch_hash,
        "files": ["sample.txt"],
        "applied": True,
    }
    assert sample_file.read_text(encoding="utf-8") == "new\n"
