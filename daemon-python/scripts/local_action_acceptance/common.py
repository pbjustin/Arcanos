"""Shared isolated environment and evidence helpers; no execution-policy bypass."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import site
import subprocess
import sys
import time
from urllib.parse import urlsplit


def clean_env(case_root: Path, source_root: Path, backend_url: str | None = None,
              extra: dict[str, str] | None = None) -> dict[str, str]:
    case_root = case_root.resolve()
    source_root = source_root.resolve()
    if any((source_root / name).exists() for name in (".env", "daemon-python/.env")):
        raise ValueError("Acceptance requires a clean source checkout without operator .env files")
    if backend_url and (urlsplit(backend_url).scheme != "http" or urlsplit(backend_url).hostname != "127.0.0.1" or not urlsplit(backend_url).port):
        raise ValueError("Acceptance backend must be an explicit loopback fixture")
    for name in ("data", "backups", "logs", "tmp", "profile/local/ARCANOS", "profile/roaming", "guard"):
        (case_root / name).mkdir(parents=True, exist_ok=True)
    (case_root / "profile/local/ARCANOS/.env").write_text("# Isolated synthetic acceptance profile\n", encoding="utf-8")
    guard_dir = case_root / "guard"
    (guard_dir / "sitecustomize.py").write_text(
        "from local_action_acceptance.guard import install\ninstall()\n", encoding="utf-8")
    # Inherit operating-system lookup only, never operator app configuration.
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"}}
    env.update({
        "PYTHONPATH": os.pathsep.join((str(guard_dir), str(source_root / "daemon-python"), str(source_root / "daemon-python/scripts"), str(site.getusersitepackages()))),
        "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1",
        "USERPROFILE": str(case_root / "profile"), "HOME": str(case_root / "profile"),
        "LOCALAPPDATA": str(case_root / "profile/local"), "APPDATA": str(case_root / "profile/roaming"),
        "TEMP": str(case_root / "tmp"), "TMP": str(case_root / "tmp"),
        "DATA_DIR": str(case_root / "data"), "HISTORY_DB_PATH": str(case_root / "data/history.db"),
        "PATCH_BACKUP_DIR": str(case_root / "backups"), "LOG_DIR": str(case_root / "logs"),
        "DEBUG_LOG_PATH": str(case_root / "logs/debug.log"), "MEMORY_FILE": str(case_root / "data/memory.json"),
        "SCREENSHOT_DIR": str(case_root / "data/screenshots"),
        "ARCANOS_BACKEND_URL": backend_url or "", "BACKEND_URL": backend_url or "",
        "BACKEND_ALLOW_HTTP": "true", "BACKEND_FALLBACK_TO_LOCAL": "false", "BACKEND_ROUTING_MODE": "backend",
        "OPENAI_API_KEY": "mock", "OPENAI_BASE_URL": "http://127.0.0.1:9/v1", "FORCE_MOCK": "true",
        "RUN_ELEVATED": "false", "ALLOW_DANGEROUS_COMMANDS": "false", "CONFIRM_SENSITIVE_ACTIONS": "true",
        "TELEMETRY_ENABLED": "false", "VOICE_ENABLED": "false", "VISION_ENABLED": "false",
        "SPEAK_RESPONSES": "false", "STREAM_RESPONSES": "false", "AUTO_START": "false",
        "DEBUG_SERVER_ENABLED": "false", "ARCANOS_LOCAL_AGENT_ENABLED": "false",
        "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED": "false", "BACKEND_SEND_UPDATES": "false",
        "GITHUB_RELEASES_REPO": "", "SENTRY_DSN": "", "NO_PROXY": "*", "no_proxy": "*",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(case_root / "profile/gitconfig"),
        "GIT_TERMINAL_PROMPT": "0", "ACCEPTANCE_NETWORK_LOG": str(case_root / "logs/network.jsonl"),
        "ACCEPTANCE_ALLOWED_PORTS": str(urlsplit(backend_url).port) if backend_url else "",
        "ACCEPTANCE_CASE_ROOT": str(case_root),
    })
    if extra:
        extras = {str(key): str(value) for key, value in extra.items()}
        ports = set(filter(None, env["ACCEPTANCE_ALLOWED_PORTS"].split(",")))
        ports.update(filter(None, extras.get("ACCEPTANCE_ALLOWED_PORTS", "").split(",")))
        env.update(extras)
        env["ACCEPTANCE_ALLOWED_PORTS"] = ",".join(sorted(ports))
    if env["RUN_ELEVATED"].lower() != "false":
        raise ValueError("Acceptance cannot authorize elevation")
    return env


def sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def pid_alive(pid: int) -> bool:
    """Read process status only; never terminate a numeric PID that may recycle."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ctypes.get_last_error() not in (0, 87)
    try:
        status = wintypes.DWORD()
        return not kernel.GetExitCodeProcess(handle, ctypes.byref(status)) or status.value == 259
    finally:
        kernel.CloseHandle(handle)


def standalone_repo(path: Path, env: dict[str, str]) -> Path:
    path.mkdir(parents=True, exist_ok=False)
    subprocess.run(["git", "init", "--quiet", str(path)], env=env, check=True, capture_output=True)
    if not (path / ".git").is_dir():
        raise AssertionError("Patch target must be a standalone repository")
    return path


def sanitized(value):
    if isinstance(value, dict):
        return {str(key): ("[REDACTED]" if isinstance(item, str) and re.search(r"(?:token|password|secret|authorization|api[_-]?key)$", str(key), re.I) else sanitized(item))
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitized(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"(?i)Authorization:\s*[^\r\n]+", "Authorization: [REDACTED]", value)
        value = re.sub(r"(?i)(?:example|synthetic|acceptance|fixture)[-_][\w-]*(?:credential|token|secret|private)[\w-]*", "[SYNTHETIC_MARKER_REDACTED]", value)
        return value
    return value


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sanitized(value), ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")


def run_child(argv: list[str], *, cwd: Path, env: dict[str, str], timeout: int = 60) -> dict:
    from .process_job import ProcessJob
    job = ProcessJob()
    process = None
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=0x00000004)  # CREATE_SUSPENDED; attach job before native execution.
        job.attach_and_resume(process)
        try:
            stdout, stderr = process.communicate(input=b"", timeout=timeout)
        except subprocess.TimeoutExpired:
            job.close()
            process.communicate(timeout=10)
            raise TimeoutError("Acceptance child timed out; owned process job closed") from None
    except BaseException:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        raise
    finally:
        job.close()
    return {"pid": process.pid, "exit_code": process.returncode,
            "stdout": stdout.decode("utf-8", "replace"), "stderr": stderr.decode("utf-8", "replace"),
            "argv": argv, "cwd": str(cwd), "owned_process_job_closed": True}


def cleanup_probe(case_root: Path, source_root: Path) -> dict:
    """Prove a timed-out controller cannot leave its owned descendant writing later."""
    env = clean_env(case_root, source_root)
    marker = case_root / "late-write"
    child_pid = case_root / "descendant.pid"
    descendant = "import time;from pathlib import Path;time.sleep(3);Path(" + repr(str(marker)) + ").write_text('late')"
    controller = (
        "import subprocess,sys,time;from pathlib import Path;"
        "p=subprocess.Popen([sys.executable,'-c'," + repr(descendant) + "]);"
        "Path(" + repr(str(child_pid)) + ").write_text(str(p.pid));time.sleep(20)"
    )
    timed_out = False
    try:
        run_child([sys.executable, "-c", controller], cwd=case_root, env=env, timeout=1)
    except TimeoutError:
        timed_out = True
    time.sleep(3.2)
    pid = int(child_pid.read_text()) if child_pid.exists() else None
    passed = timed_out and pid is not None and not pid_alive(pid) and not marker.exists()
    return {"status": "PASS" if passed else "FAIL", "evidence_type": "ACTUAL_WINDOWS_HARNESS_TIMEOUT",
            "controller_timed_out": timed_out, "descendant_pid": pid,
            "descendant_exited": pid is not None and not pid_alive(pid), "late_marker_absent": not marker.exists()}


def profile_probe(case_root: Path, source_root: Path) -> dict:
    """Check native profile paths without loading or reading operator profiles."""
    env = clean_env(case_root, source_root)
    command = ("[pscustomobject]@{CurrentUserAllHosts=$PROFILE.CurrentUserAllHosts;"
               "CurrentUserCurrentHost=$PROFILE.CurrentUserCurrentHost;AllUsersAllHosts=$PROFILE.AllUsersAllHosts;"
               "AllUsersCurrentHost=$PROFILE.AllUsersCurrentHost}|ConvertTo-Json -Compress")
    result = run_child(["powershell.exe", "-NoProfile", "-Command", command], cwd=case_root, env=env)
    if result["exit_code"] != 0:
        return {"status": "BLOCKED", "reason": "PowerShell profile-path probe did not complete"}
    profiles = {name: {"path": value, "exists": Path(value).exists()} for name, value in json.loads(result["stdout"]).items()}
    return {"status": "BLOCKED" if any(item["exists"] for item in profiles.values()) else "PASS",
            "reason": "Operator profiles must not run as fixture setup", "profiles": profiles,
            "probe_flags": ["-NoProfile"], "profile_contents_read": False}
