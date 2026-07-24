"""Effective Linux-container checks for the fixed local-agent test sandbox."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import textwrap
import time

import pytest

from arcanos.local_agent.test_sandbox import (
    resolve_test_execution_policy,
    run_sandboxed_test,
)

pytestmark = pytest.mark.skipif(
    os.environ.get("ARCANOS_LOCAL_AGENT_SANDBOX_E2E") != "1",
    reason="requires the dedicated Linux container-sandbox CI job",
)


def _write_python_fixture(workspace: Path, source: str) -> None:
    tests = workspace / "daemon-python" / "tests"
    tests.mkdir(parents=True)
    (tests / "test_effective_sandbox_contract.py").write_text(
        textwrap.dedent(source),
        encoding="utf-8",
    )


def _workspace_contents(workspace: Path) -> dict[str, bytes]:
    return {
        path.relative_to(workspace).as_posix(): path.read_bytes()
        for path in sorted(workspace.rglob("*"))
        if path.is_file()
    }


def _running_sandbox_containers() -> set[str]:
    completed = subprocess.run(
        (
            "docker",
            "ps",
            "--filter",
            "name=arcanos-local-agent-",
            "--format",
            "{{.Names}}",
        ),
        check=True,
        capture_output=True,
        text=True,
    )
    return {name for name in completed.stdout.splitlines() if name}


def test_effective_sandbox_probe_and_execution(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".env").write_text(
        "ARCANOS_CI_SANDBOX_SENTINEL=fixture-secret\n",
        encoding="utf-8",
    )
    _write_python_fixture(
        workspace,
        """
        import os
        from pathlib import Path
        import socket
        import subprocess
        import sys


        def test_effective_restrictions():
            assert os.environ.get("ARCANOS_CI_SANDBOX_SENTINEL") is None
            assert not Path("/workspace/.env").exists()
            assert {path.name for path in Path("/sys/class/net").iterdir()} <= {"lo"}

            network = socket.socket()
            network.settimeout(0.5)
            try:
                network.connect(("1.1.1.1", 53))
            except OSError:
                pass
            else:
                raise AssertionError("sandbox unexpectedly reached an external network")
            finally:
                network.close()

            Path("/workspace/sandbox-created.txt").write_text(
                "disposable",
                encoding="utf-8",
            )
            assert Path("/workspace/sandbox-created.txt").read_text(
                encoding="utf-8",
            ) == "disposable"
            assert not Path("/host").exists()
            assert not Path("/var/run/docker.sock").exists()

            try:
                Path("/input/forbidden-write.txt").write_text(
                    "mutation",
                    encoding="utf-8",
                )
            except OSError:
                pass
            else:
                raise AssertionError("read-only sandbox input was modified")


        def test_process_limit_blocks_unbounded_subprocesses():
            children = []
            blocked = False
            try:
                for _index in range(200):
                    try:
                        children.append(
                            subprocess.Popen(
                                [
                                    sys.executable,
                                    "-c",
                                    "import time; time.sleep(30)",
                                ],
                                stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                            )
                        )
                    except OSError:
                        blocked = True
                        break
                assert blocked, "sandbox process limit did not stop spawning"
            finally:
                for child in children:
                    child.terminate()
                for child in children:
                    try:
                        child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=2)


        def test_memory_limit_kills_an_exhausting_child():
            exhausted = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "bytearray(1536 * 1024 * 1024)",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
                check=False,
            )
            assert exhausted.returncode != 0
        """,
    )
    before = _workspace_contents(workspace)

    policy = resolve_test_execution_policy()
    assert policy.mode == "sandboxed"
    assert policy.sandbox_available is True
    assert policy.sandbox_runtime == "docker"

    result = run_sandboxed_test(
        "python-unit",
        workspace,
        timeout_ms=60_000,
    )

    assert result.exit_code == 0, result.stdout + result.stderr
    assert result.truncated is False
    assert _workspace_contents(workspace) == before
    assert not (workspace / "sandbox-created.txt").exists()


def test_effective_sandbox_bounds_output(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _write_python_fixture(
        workspace,
        """
        def test_large_failure_output():
            print("X" * 50000)
            assert False
        """,
    )

    result = run_sandboxed_test(
        "python-unit",
        workspace,
        timeout_ms=60_000,
    )

    assert result.exit_code != 0
    assert result.truncated is True
    assert len(result.stdout) <= 12_020
    assert len(result.stderr) <= 12_020


def test_effective_sandbox_timeout_cleans_up_container(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _write_python_fixture(
        workspace,
        """
        import time


        def test_slow_execution():
            time.sleep(30)
        """,
    )
    before = _running_sandbox_containers()

    with pytest.raises(TimeoutError):
        run_sandboxed_test(
            "python-unit",
            workspace,
            timeout_ms=1_000,
        )

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if _running_sandbox_containers() <= before:
            break
        time.sleep(0.25)
    assert _running_sandbox_containers() <= before
