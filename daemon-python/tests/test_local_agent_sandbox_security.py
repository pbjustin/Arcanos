"""Security tests for local-agent test isolation and workspace snapshots."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import threading
import time

import pytest

from arcanos.cli.cli_policy import strip_unsafe_output_controls
from arcanos.local_agent.process_runner import (
    ProcessCancelledError,
    run_bounded_process,
)
from arcanos.local_agent.secure_fs import (
    open_workspace_file,
    stage_sanitized_workspace_snapshot,
)
from arcanos.local_agent.test_sandbox import (
    TestExecutionPolicy as ExecutionPolicy,
    _container_probe_argv,
    _container_run_argv,
    _probe_container_runtime,
    resolve_test_execution_policy,
    run_sandboxed_test,
)
from arcanos.local_agent.workspace_registry import (
    RegisteredWorkspaceRegistry,
    WorkspaceRegistryError,
)

_PINNED_IMAGE = "example.invalid/arcanos-tests@sha256:" + ("a" * 64)


def test_test_execution_defaults_to_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE", raising=False)

    policy = resolve_test_execution_policy()

    assert policy == ExecutionPolicy("disabled", False, None)


def test_unsandboxed_mode_requires_dual_opt_in_and_rejects_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE",
        "unsandboxed-development-only",
    )
    monkeypatch.delenv(
        "ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS",
        raising=False,
    )
    with pytest.raises(PermissionError, match="also required"):
        resolve_test_execution_policy()

    monkeypatch.setenv("ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS", "true")
    assert resolve_test_execution_policy().mode == "unsandboxed-development-only"

    monkeypatch.setenv("NODE_ENV", "production")
    with pytest.raises(PermissionError, match="forbidden"):
        resolve_test_execution_policy()
    monkeypatch.delenv("NODE_ENV")
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_ID", "preview")
    with pytest.raises(PermissionError, match="forbidden"):
        resolve_test_execution_policy()


def test_sandbox_mode_requires_runtime_and_immutable_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE", "sandboxed")
    monkeypatch.setenv("ARCANOS_LOCAL_AGENT_SANDBOX_RUNTIME", "docker")
    monkeypatch.setenv("ARCANOS_LOCAL_AGENT_SANDBOX_IMAGE", "mutable:latest")
    monkeypatch.setattr(
        "arcanos.local_agent.test_sandbox.shutil.which",
        lambda *_args, **_kwargs: "/usr/bin/docker",
    )

    with pytest.raises(ValueError, match="immutable sha256"):
        resolve_test_execution_policy(probe_runtime=False)

    monkeypatch.setenv("ARCANOS_LOCAL_AGENT_SANDBOX_IMAGE", _PINNED_IMAGE)
    policy = resolve_test_execution_policy(probe_runtime=False)
    assert policy == ExecutionPolicy("sandboxed", True, "docker")

    local_image_id = "sha256:" + ("b" * 64)
    monkeypatch.setenv("ARCANOS_LOCAL_AGENT_SANDBOX_IMAGE", local_image_id)
    policy = resolve_test_execution_policy(probe_runtime=False)
    assert policy == ExecutionPolicy("sandboxed", True, "docker")


def test_container_argv_enforces_required_isolation_controls() -> None:
    argv = _container_run_argv(
        "docker",
        _PINNED_IMAGE,
        container_name="arcanos-local-agent-test",
        snapshot="/safe/input",
        profile="python-unit",
    )
    joined = "\n".join(argv)

    assert "--network=none" in argv
    assert "--read-only" in argv
    assert "--cap-drop=ALL" in argv
    assert "--security-opt=no-new-privileges=true" in argv
    assert "--pull=never" in argv
    assert any(item.startswith("--pids-limit=") for item in argv)
    assert any(item.startswith("--memory=") for item in argv)
    assert any(item.startswith("--cpus=") for item in argv)
    assert any(item.startswith("--tmpfs=/workspace:") for item in argv)
    assert "docker.sock" not in joined
    assert "--privileged" not in argv
    assert argv[-2:] == ("--profile", "python-unit")


def test_runtime_probe_executes_effective_security_self_test(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, tuple[str, ...]] = {}

    def fake_run(argv: tuple[str, ...], **_kwargs: object):
        from arcanos.local_agent.process_runner import ProcessResult

        captured["argv"] = argv
        return ProcessResult(
            argv,
            0,
            json.dumps({"checks": 15, "failures": [], "ok": True, "version": 1}),
            "",
            1,
            False,
        )

    monkeypatch.setattr(
        "arcanos.local_agent.test_sandbox.run_bounded_process",
        fake_run,
    )

    assert _probe_container_runtime("docker", _PINNED_IMAGE) is True
    argv = captured["argv"]
    assert "--network=none" in argv
    assert "--read-only" in argv
    assert "--cap-drop=ALL" in argv
    assert "--self-test" == argv[-1]
    assert "image" not in argv
    assert "inspect" not in argv


def test_probe_argv_uses_same_isolation_controls_as_test_execution() -> None:
    probe = _container_probe_argv(
        "docker",
        _PINNED_IMAGE,
        container_name="same-container",
        snapshot="/safe/input",
    )
    execution = _container_run_argv(
        "docker",
        _PINNED_IMAGE,
        container_name="same-container",
        snapshot="/safe/input",
        profile="python-unit",
    )

    assert (
        probe[: probe.index(_PINNED_IMAGE)]
        == execution[: execution.index(_PINNED_IMAGE)]
    )


def test_sandbox_execution_never_falls_back_to_host(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        "arcanos.local_agent.test_sandbox.resolve_test_execution_policy",
        lambda: ExecutionPolicy("sandboxed", True, "docker"),
    )
    monkeypatch.setattr(
        "arcanos.local_agent.test_sandbox._sandbox_configuration",
        lambda: ("docker", _PINNED_IMAGE),
    )
    monkeypatch.setattr(
        "arcanos.local_agent.test_sandbox.stage_sanitized_workspace_snapshot",
        lambda _root, _destination: (1, 1),
    )

    def fake_run(argv: tuple[str, ...], **kwargs: object):
        from arcanos.local_agent.process_runner import ProcessResult

        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return ProcessResult(argv, 0, "ok", "", 1, False)

    monkeypatch.setattr(
        "arcanos.local_agent.test_sandbox.run_bounded_process",
        fake_run,
    )

    result = run_sandboxed_test(
        "python-unit",
        tmp_path,
        timeout_ms=1_000,
    )

    assert result.exit_code == 0
    assert captured["argv"][0] == "docker"  # type: ignore[index]
    assert sys.executable not in captured["argv"]  # type: ignore[operator]


def test_snapshot_excludes_secrets_git_dependencies_and_symlinks(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    snapshot = tmp_path / "snapshot"
    workspace.mkdir()
    snapshot.mkdir()
    (workspace / "safe.txt").write_text("safe", encoding="utf-8")
    (workspace / ".env").write_text("SECRET=value", encoding="utf-8")
    (workspace / ".git").mkdir()
    (workspace / ".git" / "config").write_text("secret", encoding="utf-8")
    (workspace / "node_modules").mkdir()
    (workspace / "node_modules" / "package.js").write_text("large", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    link = workspace / "linked.txt"
    try:
        link.symlink_to(outside)
    except (NotImplementedError, OSError):
        link = None

    copied_files, _copied_bytes = stage_sanitized_workspace_snapshot(
        workspace,
        snapshot,
    )

    assert copied_files == 1
    assert (snapshot / "safe.txt").read_text(encoding="utf-8") == "safe"
    assert not (snapshot / ".env").exists()
    assert not (snapshot / ".git").exists()
    assert not (snapshot / "node_modules").exists()
    if link is not None:
        assert not (snapshot / "linked.txt").exists()


def test_registry_detects_root_replacement(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    replacement = tmp_path / "replacement"
    workspace.mkdir()
    registry = RegisteredWorkspaceRegistry({"personal": workspace})
    workspace.rename(replacement)
    workspace.mkdir()

    with pytest.raises(WorkspaceRegistryError, match="identity has changed"):
        registry.resolve("personal")


@pytest.mark.skipif(os.name == "nt", reason="POSIX descriptor-relative behavior")
@pytest.mark.parametrize("link_kind", ["file", "directory", "chain", "secret"])
def test_secure_read_denies_posix_link_forms(
    tmp_path: Path,
    link_kind: str,
) -> None:
    workspace = tmp_path / "workspace"
    outside_directory = tmp_path / "outside"
    workspace.mkdir()
    outside_directory.mkdir()
    outside = outside_directory / "secret.txt"
    outside.write_text("secret", encoding="utf-8")

    if link_kind == "file":
        (workspace / "linked.txt").symlink_to(outside)
        relative = "linked.txt"
    elif link_kind == "directory":
        (workspace / "linked").symlink_to(
            outside_directory,
            target_is_directory=True,
        )
        relative = "linked/secret.txt"
    elif link_kind == "chain":
        (workspace / "second.txt").symlink_to(outside)
        (workspace / "linked.txt").symlink_to(workspace / "second.txt")
        relative = "linked.txt"
    else:
        secret = workspace / ".env"
        secret.write_text("SECRET=value", encoding="utf-8")
        (workspace / "linked.txt").symlink_to(secret)
        relative = "linked.txt"

    with pytest.raises(OSError):
        with open_workspace_file(workspace, relative) as stream:
            stream.read()


@pytest.mark.skipif(os.name == "nt", reason="POSIX O_NOFOLLOW behavior")
def test_secure_read_denies_swap_to_symlink_after_validation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    victim = workspace / "victim.txt"
    victim.write_text("safe", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")

    from arcanos.local_agent import secure_fs

    original_open = secure_fs.os.open

    def race(
        path: object,
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        if path == "victim.txt":
            victim.unlink()
            victim.symlink_to(outside)
        if dir_fd is None:
            return original_open(path, flags, mode)  # type: ignore[arg-type]
        return original_open(path, flags, mode, dir_fd=dir_fd)  # type: ignore[arg-type]

    monkeypatch.setattr(secure_fs.os, "open", race)
    with pytest.raises(OSError):
        with open_workspace_file(workspace, "victim.txt") as stream:
            stream.read()


@pytest.mark.skipif(os.name == "nt", reason="POSIX O_NOFOLLOW behavior")
def test_secure_read_denies_intermediate_directory_swap(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    directory = workspace / "directory"
    outside = tmp_path / "outside"
    directory.mkdir(parents=True)
    outside.mkdir()
    (directory / "safe.txt").write_text("safe", encoding="utf-8")
    (outside / "safe.txt").write_text("secret", encoding="utf-8")

    from arcanos.local_agent import secure_fs

    original_open = secure_fs.os.open

    def race(
        path: object,
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        if path == "directory":
            directory.rename(workspace / "original-directory")
            directory.symlink_to(outside, target_is_directory=True)
        if dir_fd is None:
            return original_open(path, flags, mode)  # type: ignore[arg-type]
        return original_open(path, flags, mode, dir_fd=dir_fd)  # type: ignore[arg-type]

    monkeypatch.setattr(secure_fs.os, "open", race)
    with pytest.raises(OSError):
        with open_workspace_file(workspace, "directory/safe.txt") as stream:
            stream.read()


def test_process_runner_honors_active_cancellation(tmp_path: Path) -> None:
    cancellation = threading.Event()

    def cancel() -> None:
        time.sleep(0.05)
        cancellation.set()

    thread = threading.Thread(target=cancel, daemon=True)
    thread.start()
    started = time.monotonic()
    with pytest.raises(ProcessCancelledError):
        run_bounded_process(
            (sys.executable, "-c", "import time; time.sleep(30)"),
            cwd=tmp_path,
            timeout_ms=30_000,
            cancellation_event=cancellation,
        )
    assert time.monotonic() - started < 5


def test_output_controls_are_removed_without_destroying_lines() -> None:
    value = "safe\x1b[31mred\x1b[0m\nnext\u202esecret\x00"

    sanitized = strip_unsafe_output_controls(value)

    assert sanitized == "safered\nnextsecret"
    assert all(
        character in {"\n", "\r", "\t"}
        or not (
            ord(character) < 0x20
            or 0x7F <= ord(character) <= 0x9F
            or 0x202A <= ord(character) <= 0x202E
            or 0x2066 <= ord(character) <= 0x2069
        )
        for character in sanitized
    )
