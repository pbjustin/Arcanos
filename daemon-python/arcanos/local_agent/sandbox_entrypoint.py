"""Trusted fixed-profile entrypoint baked into the local-agent sandbox image."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import resource
import shutil
import stat
import subprocess
import sys

_PROFILES = {
    "python-unit",
    "typescript-unit",
    "typescript-integration",
    "backend-cli-contract",
}
_REPARSE_POINT_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--profile", choices=sorted(_PROFILES))
    operation.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args()
    if arguments.self_test:
        return _sandbox_self_test()

    source = Path("/input")
    workspace = Path("/workspace")
    if not source.is_dir() or not workspace.is_dir():
        raise RuntimeError("Sandbox workspace mounts are unavailable.")
    _copy_snapshot(source, workspace)
    Path("/tmp/home").mkdir(parents=True, exist_ok=True)

    dependency_root = Path("/opt/node-deps/node_modules")
    if dependency_root.is_dir():
        (workspace / "node_modules").symlink_to(
            dependency_root,
            target_is_directory=True,
        )

    commands = _profile_commands(arguments.profile, workspace)
    for command, cwd in commands:
        completed = subprocess.run(
            command,
            cwd=str(cwd),
            env=_sandbox_environment(),
            stdin=subprocess.DEVNULL,
            shell=False,
            check=False,
        )
        if completed.returncode != 0:
            return int(completed.returncode)
    return 0


def _sandbox_self_test() -> int:
    """Verify the effective restrictions of the running container."""

    failures: list[str] = []
    if os.getuid() != 65532 or os.getgid() != 65532:
        failures.append("non_root_identity")

    status = _proc_status()
    if status.get("NoNewPrivs") != "1":
        failures.append("no_new_privileges")
    if int(status.get("CapEff", "1"), 16) != 0:
        failures.append("effective_capabilities")

    root_options = _mount_options("/")
    input_options = _mount_options("/input")
    workspace_options = _mount_options("/workspace")
    temporary_options = _mount_options("/tmp")
    if "ro" not in root_options:
        failures.append("readonly_root")
    if "ro" not in input_options:
        failures.append("readonly_input")
    if not {"rw", "nosuid", "nodev"}.issubset(workspace_options):
        failures.append("workspace_tmpfs")
    if not {"rw", "nosuid", "nodev", "noexec"}.issubset(temporary_options):
        failures.append("temporary_tmpfs")

    interfaces = {candidate.name for candidate in Path("/sys/class/net").iterdir()}
    if interfaces - {"lo"}:
        failures.append("network_namespace")
    if (
        Path("/var/run/docker.sock").exists()
        or Path("/run/podman/podman.sock").exists()
    ):
        failures.append("host_socket")

    memory_limit = _read_integer_limit(
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    )
    pids_limit = _read_integer_limit(
        "/sys/fs/cgroup/pids.max",
        "/sys/fs/cgroup/pids/pids.max",
    )
    cpu_limit = _read_cpu_limit()
    if memory_limit is None or memory_limit > 1024 * 1024 * 1024:
        failures.append("memory_limit")
    if pids_limit is None or pids_limit > 128:
        failures.append("process_limit")
    if cpu_limit is None or cpu_limit > 1.0:
        failures.append("cpu_limit")
    file_limit = resource.getrlimit(resource.RLIMIT_FSIZE)[0]
    if file_limit < 0 or file_limit > 512 * 1024 * 1024:
        failures.append("file_size_limit")

    if _filesystem_capacity("/workspace") > 512 * 1024 * 1024:
        failures.append("workspace_size")
    if _filesystem_capacity("/tmp") > 128 * 1024 * 1024:
        failures.append("temporary_size")

    sensitive_environment_names = [
        name
        for name in os.environ
        if any(
            marker in name.upper()
            for marker in (
                "API_KEY",
                "AUTH_TOKEN",
                "BEARER",
                "DATABASE_URL",
                "PASSWORD",
                "RAILWAY_TOKEN",
                "SECRET",
            )
        )
    ]
    if sensitive_environment_names:
        failures.append("sensitive_environment")

    evidence = {
        "checks": 15,
        "failures": sorted(failures),
        "ok": not failures,
        "version": 1,
    }
    print(json.dumps(evidence, separators=(",", ":"), sort_keys=True))
    return 0 if not failures else 1


def _proc_status() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            values[key] = value.strip()
    return values


def _mount_options(mount_point: str) -> set[str]:
    for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) >= 6 and fields[4] == mount_point:
            separator = fields.index("-")
            return set(fields[5].split(",")) | set(fields[separator + 3].split(","))
    return set()


def _read_integer_limit(*paths: str) -> int | None:
    for path in paths:
        candidate = Path(path)
        if not candidate.is_file():
            continue
        value = candidate.read_text(encoding="utf-8").strip()
        if value == "max":
            return None
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _read_cpu_limit() -> float | None:
    unified = Path("/sys/fs/cgroup/cpu.max")
    if unified.is_file():
        quota, period = unified.read_text(encoding="utf-8").split()
        if quota == "max":
            return None
        return int(quota) / int(period)
    quota_path = Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
    period_path = Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
    if quota_path.is_file() and period_path.is_file():
        quota = int(quota_path.read_text(encoding="utf-8"))
        period = int(period_path.read_text(encoding="utf-8"))
        return None if quota < 0 else quota / period
    return None


def _filesystem_capacity(path: str) -> int:
    filesystem = os.statvfs(path)
    return int(filesystem.f_frsize) * int(filesystem.f_blocks)


def _copy_snapshot(source: Path, destination: Path) -> None:
    for directory, directory_names, file_names in os.walk(source, followlinks=False):
        source_directory = Path(directory)
        relative_directory = source_directory.relative_to(source)
        destination_directory = destination / relative_directory
        destination_directory.mkdir(parents=True, exist_ok=True)

        safe_directories: list[str] = []
        for name in sorted(directory_names, key=str.casefold):
            candidate = source_directory / name
            if _is_link_or_reparse(candidate):
                raise PermissionError("Sandbox input contains a linked directory.")
            safe_directories.append(name)
            (destination_directory / name).mkdir(exist_ok=True)
        directory_names[:] = safe_directories

        for name in sorted(file_names, key=str.casefold):
            candidate = source_directory / name
            if _is_link_or_reparse(candidate):
                raise PermissionError("Sandbox input contains a linked file.")
            target = destination_directory / name
            with candidate.open("rb") as source_stream, target.open(
                "xb"
            ) as target_stream:
                shutil.copyfileobj(source_stream, target_stream, length=1024 * 1024)


def _profile_commands(
    profile: str,
    workspace: Path,
) -> tuple[tuple[tuple[str, ...], Path], ...]:
    daemon_root = workspace / "daemon-python"
    if profile == "python-unit":
        if not daemon_root.is_dir():
            raise FileNotFoundError("daemon-python is unavailable in the sandbox.")
        return (((sys.executable, "-m", "pytest", "tests/"), daemon_root),)
    if profile == "typescript-unit":
        return ((("npm", "run", "test:unit"), workspace),)
    if profile == "typescript-integration":
        return ((("npm", "run", "test:integration"), workspace),)
    return (
        (("npm", "run", "build:packages"), workspace),
        (("npm", "run", "validate:backend-cli:contract"), workspace),
    )


def _sandbox_environment() -> dict[str, str]:
    allowed_names = (
        "CI",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "NPM_CONFIG_AUDIT",
        "NPM_CONFIG_FUND",
        "NPM_CONFIG_IGNORE_SCRIPTS",
        "PATH",
        "PYTHONNOUSERSITE",
        "PYTHONDONTWRITEBYTECODE",
        "TMPDIR",
    )
    environment = {
        name: value for name in allowed_names if (value := os.environ.get(name))
    }
    environment.setdefault("HOME", "/tmp/home")
    environment.setdefault("TMPDIR", "/tmp")
    environment.setdefault("CI", "1")
    environment.setdefault("NO_COLOR", "1")
    return environment


def _is_link_or_reparse(path: Path) -> bool:
    metadata = os.stat(path, follow_symlinks=False)
    attributes = int(getattr(metadata, "st_file_attributes", 0))
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & _REPARSE_POINT_ATTRIBUTE)


if __name__ == "__main__":
    raise SystemExit(main())
