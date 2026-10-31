"""Native-terminal patch acceptance child; injected faults are explicit and scoped."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


def _sha(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _workspace_files(root: Path) -> dict[str, dict]:
    return {
        path.relative_to(root).as_posix(): {"sha256": _sha(path), "bytes": path.stat().st_size}
        for path in sorted(root.rglob("*"))
        if path.is_file() and ".git" not in path.relative_to(root).parts
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--operation", choices=["apply", "rollback"], required=True)
    parser.add_argument("--patch-file", type=Path)
    parser.add_argument("--rollback-id")
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--fault", default="none", choices=[
        "none", "dry", "safe", "partial_git", "sqlite_pre", "sqlite_final",
        "rollback_partial", "rollback_sqlite_final", "rollback_sqlite_partial",
    ])
    args = parser.parse_args()
    case_root = args.case_root.resolve()
    source_root = args.source_root.resolve()
    workspace = Path.cwd().resolve()
    workspace.relative_to(case_root)
    from rich.console import Console
    from arcanos.agentic.history_db import HistoryDB
    from arcanos.agentic.patch_orchestrator import PatchOrchestrator
    from arcanos.agentic.policy_guard import PolicyGuard
    from arcanos.config import Config
    from arcanos.local_agent import patch_handler

    Path(patch_handler.__file__).resolve().relative_to(source_root)
    for target in (Config.HISTORY_DB_PATH, Config.PATCH_BACKUP_DIR, Config.DATA_DIR):
        Path(target).resolve().relative_to(case_root)
    assert Config.RUN_ELEVATED is False
    console = Console(force_terminal=None, width=140)
    history = HistoryDB()
    guard = PolicyGuard(history)
    orchestrator = PatchOrchestrator(console, history, guard)
    started = []
    original_popen = subprocess.Popen

    def observed_popen(*popen_args, **popen_kwargs):
        process = original_popen(*popen_args, **popen_kwargs)
        argv = popen_args[0] if popen_args else popen_kwargs.get("args", [])
        started.append((process, [str(item) for item in argv]))
        return process

    # Instrumentation observes the real executable/PID and never replaces a result.
    subprocess.Popen = observed_popen
    before = _workspace_files(workspace)
    injection = []
    original_runner = patch_handler.run_bounded_process
    if args.fault == "partial_git":
        injection.append("INJECTED_SPLIT_GIT_APPLY_TWO_REAL_GIT_PROCESSES")
        def split_git(argv, **options):
            if "apply" not in argv:
                return original_runner(argv, **options)
            text = options["stdin_text"]
            split = text.find("diff --git ", len("diff --git "))
            assert split > 0
            first = dict(options, stdin_text=text[:split])
            completed = original_runner(argv, **first)
            assert completed.exit_code == 0
            # This is an actual Git rejection after the first actual file mutation.
            rejected = dict(options, stdin_text="this is not a valid git patch\n")
            return original_runner(argv, **rejected)
        patch_handler.run_bounded_process = split_git
    if args.fault in {"rollback_partial", "rollback_sqlite_partial"}:
        injection.append("INJECTED_COPY_FAILURE_AFTER_FIRST_REAL_RESTORE")
        original_copy = patch_handler.shutil.copy2
        def fail_second(source, destination, *copy_args, **copy_kwargs):
            if Path(destination).name == "second.txt":
                raise OSError("Authorization: Token acceptance-private-fixture\nInjected second restore failure")
            return original_copy(source, destination, *copy_args, **copy_kwargs)
        patch_handler.shutil.copy2 = fail_second
    triggers = {
        "sqlite_pre": ("INSERT", "applying"),
        "sqlite_final": ("UPDATE", "applied"),
        "rollback_sqlite_final": ("UPDATE", "rolled_back"),
        "rollback_sqlite_partial": ("UPDATE", "rollback_failed"),
    }
    with sqlite3.connect(str(history.path)) as connection:
        connection.execute("DROP TRIGGER IF EXISTS acceptance_history_failure")
        if args.fault in triggers:
            event, status = triggers[args.fault]
            connection.execute(
                f"CREATE TRIGGER acceptance_history_failure BEFORE {event} ON patches "
                f"WHEN NEW.status = '{status}' BEGIN "
                "SELECT RAISE(ABORT, 'Injected acceptance SQLite write failure'); END"
            )
            injection.append("INJECTED_SQLITE_ABORT_TRIGGER")
    if args.fault == "safe":
        guard.enable_safe_mode("acceptance", "acceptance operator enabled")
    receipt = {
        "pid": os.getpid(), "parent_pid": os.getppid(),
        "stdin_isatty": sys.stdin.isatty(), "operation": args.operation,
        "fault": args.fault, "injection": injection,
        "workspace": str(workspace), "before": before,
        "history_path": str(history.path), "backup_root": str(Config.PATCH_BACKUP_DIR),
        "elevated_requested": Config.RUN_ELEVATED,
    }
    try:
        if args.operation == "apply":
            assert args.patch_file
            patch = args.patch_file.read_text(encoding="utf-8")
            receipt["patch_sha256"] = hashlib.sha256(patch.encode("utf-8")).hexdigest()
            result = orchestrator.apply_with_approval(
                "acceptance", patch, summary="Windows local-action acceptance",
                dry_run=args.fault == "dry",
            )
            receipt["result"] = asdict(result)
            receipt["rollback_id"] = result.rollback_id
        else:
            assert args.rollback_id
            result = orchestrator.rollback("acceptance", args.rollback_id, dry_run=args.fault == "dry")
            receipt["result"] = {"ok": result}
            receipt["rollback_id"] = args.rollback_id
        rollback_id = receipt["rollback_id"]
        receipt["history"] = history.get_patch(rollback_id)
        manifest = Config.PATCH_BACKUP_DIR / rollback_id / "manifest.json"
        receipt["manifest_sha256"] = _sha(manifest)
        try:
            receipt["manifest"] = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else None
        except ValueError:
            receipt["manifest"] = {"malformed": True}
        receipt["backups"] = {
            path.relative_to(Config.PATCH_BACKUP_DIR).as_posix(): {"sha256": _sha(path), "bytes": path.stat().st_size}
            for path in sorted(Config.PATCH_BACKUP_DIR.rglob("*"))
            if path.is_file() and path.name != "manifest.json"
        } if Config.PATCH_BACKUP_DIR.exists() else {}
        receipt["after"] = _workspace_files(workspace)
        receipt["processes"] = [
            {"pid": process.pid, "exit_code": process.poll(),
             "executable": argv[0], "operation": "git.apply" if "apply" in argv else "git.validation"}
            for process, argv in started
        ]
        receipt["unexpected_live_children"] = [process.pid for process, _ in started if process.poll() is None]
        receipt["completed"] = True
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        print("ACCEPTANCE_PATCH_RECEIPT_WRITTEN", flush=True)
        return 0
    finally:
        subprocess.Popen = original_popen


if __name__ == "__main__":
    raise SystemExit(main())
