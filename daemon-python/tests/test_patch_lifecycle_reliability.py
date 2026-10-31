from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import subprocess

import pytest
from rich.console import Console

from arcanos.agentic.history_db import HistoryDB
from arcanos.agentic.patch_orchestrator import PatchOrchestrator
from arcanos.agentic.policy_guard import PolicyGuard
from arcanos.config import Config
from arcanos.local_agent import patch_handler
from arcanos.local_agent.process_runner import ProcessResult


def patch_for(name="sample.txt", before="old", after="new"):
    return "\n".join([
        f"diff --git a/{name} b/{name}",
        *(["new file mode 100644"] if before is None else []),
        f"--- a/{name}" if before is not None else "--- /dev/null",
        f"+++ b/{name}" if after is not None else "+++ /dev/null",
        f"@@ -{1 if before is not None else 0},{1 if before is not None else 0} +{1 if after is not None else 0},{1 if after is not None else 0} @@",
        *([f"-{before}"] if before is not None else []),
        *([f"+{after}"] if after is not None else []), "",
    ])


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(["git", "init", "--quiet", str(root)], check=True, capture_output=True)
    (root / "sample.txt").write_bytes(b"old\n")
    monkeypatch.chdir(root)
    monkeypatch.setattr(Config, "PATCH_BACKUP_DIR", tmp_path / "backups")
    history = HistoryDB(tmp_path / "history.db")
    output = io.StringIO()
    orch = PatchOrchestrator(Console(file=output, force_terminal=False), history, PolicyGuard(history))
    monkeypatch.setattr("arcanos.agentic.patch_orchestrator.sys.stdin", type("Tty", (), {"isatty": lambda _: True})())
    return root, orch, history, output


def approve(monkeypatch, patch):
    values = iter([hashlib.sha256(patch.encode()).hexdigest(), "y"])
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(values))


def approve_rollback(monkeypatch, rollback_id):
    monkeypatch.setattr("builtins.input", lambda _prompt="": rollback_id)


def apply(workspace, monkeypatch, patch=None):
    patch = patch or patch_for()
    approve(monkeypatch, patch)
    result = workspace[1].apply_with_approval("session", patch)
    assert result.ok, result.error
    return result


def test_applied_patch_roundtrip_updates_status(workspace, monkeypatch):
    root, orch, history, _ = workspace
    result = apply(workspace, monkeypatch)
    assert (root / "sample.txt").read_bytes() == b"new\n"
    assert Path(result.backups["sample.txt"]).read_bytes() == b"old\n"
    approve_rollback(monkeypatch, result.rollback_id)
    assert orch.rollback("session", result.rollback_id)
    assert (root / "sample.txt").read_bytes() == b"old\n"
    assert history.get_patch(result.rollback_id)["status"] == "rolled_back"


def test_dry_run_patch_never_executes_or_creates_backups(workspace, monkeypatch):
    root, orch, _, _ = workspace
    approve(monkeypatch, patch_for())
    result = orch.apply_with_approval("session", patch_for(), dry_run=True)
    assert not result.ok
    assert result.error == "dry_run"
    assert (root / "sample.txt").read_bytes() == b"old\n"
    assert not Config.PATCH_BACKUP_DIR.exists()


def test_safe_mode_changed_after_approval_blocks_patch(workspace, monkeypatch):
    root, orch, _, _ = workspace
    def response(prompt=""):
        if "SHA-256" in prompt:
            return hashlib.sha256(patch_for().encode()).hexdigest()
        orch.guard.enable_safe_mode("session", "test")
        return "y"
    monkeypatch.setattr("builtins.input", response)
    result = orch.apply_with_approval("session", patch_for())
    assert not result.ok
    assert result.approved is True and result.status == "blocked"
    assert (root / "sample.txt").read_bytes() == b"old\n"


@pytest.mark.parametrize("mode", ["missing", "changed", "wrong_workspace", "denied", "safe", "dry_run", "tampered_backup"])
def test_rollback_refuses_unsafe_recovery(workspace, monkeypatch, tmp_path, mode):
    root, orch, _, _ = workspace
    result = apply(workspace, monkeypatch)
    approve_rollback(monkeypatch, result.rollback_id)
    if mode == "missing":
        Path(result.backups["sample.txt"]).unlink()
    elif mode == "changed":
        (root / "sample.txt").write_bytes(b"unrelated\n")
    elif mode == "wrong_workspace":
        other = tmp_path / "other"
        other.mkdir()
        subprocess.run(["git", "init", "--quiet", str(other)], check=True, capture_output=True)
        (other / "sample.txt").write_bytes(b"different\n")
        monkeypatch.chdir(other)
    elif mode == "denied":
        monkeypatch.setattr("builtins.input", lambda _prompt="": "wrong-id")
    elif mode == "safe":
        orch.guard.enable_safe_mode("session", "test")
    elif mode == "tampered_backup":
        Path(result.backups["sample.txt"]).write_bytes(b"tampered\n")
    expected = (root / "sample.txt").read_bytes()
    kwargs = {"dry_run": True} if mode == "dry_run" else {}
    assert not orch.rollback("session", result.rollback_id, **kwargs)
    assert (root / "sample.txt").read_bytes() == expected


def test_repeated_rollback_never_overwrites_later_edits(workspace, monkeypatch):
    root, orch, _, _ = workspace
    result = apply(workspace, monkeypatch)
    approve_rollback(monkeypatch, result.rollback_id)
    assert orch.rollback("session", result.rollback_id)
    (root / "sample.txt").write_bytes(b"later edit\n")
    assert not orch.rollback("session", result.rollback_id)
    assert (root / "sample.txt").read_bytes() == b"later edit\n"


@pytest.mark.parametrize("failure", ["exit", "exception"])
def test_partial_patch_failure_retains_recoverable_backup(workspace, monkeypatch, failure):
    root, orch, history, _ = workspace
    real_run = patch_handler.run_bounded_process
    def partial(argv, **kwargs):
        if "apply" not in argv:
            return real_run(argv, **kwargs)
        assert list(Config.PATCH_BACKUP_DIR.glob("*/files/sample.txt"))[0].read_bytes() == b"old\n"
        (root / "sample.txt").write_bytes(b"partial\n")
        if failure == "exception":
            raise TimeoutError("injected failure")
        return ProcessResult(tuple(argv), 1, "", "injected failure", 1, False)
    monkeypatch.setattr(patch_handler, "run_bounded_process", partial)
    approve(monkeypatch, patch_for())
    result = orch.apply_with_approval("session", patch_for())
    assert not result.ok
    assert result.backups
    assert history.get_patch(result.rollback_id)["status"] == "failed"
    approve_rollback(monkeypatch, result.rollback_id)
    assert orch.rollback("session", result.rollback_id)
    assert (root / "sample.txt").read_bytes() == b"old\n"


@pytest.mark.parametrize("kind", ["create", "delete"])
def test_rollback_restores_creation_and_deletion(workspace, monkeypatch, kind):
    root, orch, _, _ = workspace
    patch = patch_for("added.txt", None, "new") if kind == "create" else patch_for("sample.txt", "old", None)
    result = apply(workspace, monkeypatch, patch)
    approve_rollback(monkeypatch, result.rollback_id)
    assert orch.rollback("session", result.rollback_id)
    assert not (root / "added.txt").exists()
    assert (root / "sample.txt").read_bytes() == b"old\n"


def test_rollback_preflights_all_backups_before_restoring(workspace, monkeypatch):
    root, orch, _, _ = workspace
    (root / "second.txt").write_bytes(b"old\n")
    result = apply(workspace, monkeypatch, patch_for() + patch_for("second.txt"))
    Path(result.backups["second.txt"]).unlink()
    approve_rollback(monkeypatch, result.rollback_id)
    assert not orch.rollback("session", result.rollback_id)
    assert (root / "sample.txt").read_bytes() == b"new\n"
    assert (root / "second.txt").read_bytes() == b"new\n"


def test_rollback_partial_io_failure_preserves_state_and_can_retry(workspace, monkeypatch):
    root, orch, history, output = workspace
    (root / "second.txt").write_bytes(b"old\n")
    result = apply(workspace, monkeypatch, patch_for() + patch_for("second.txt"))
    approve_rollback(monkeypatch, result.rollback_id)
    import arcanos.agentic.patch_orchestrator as module
    real_copy = module.shutil.copy2
    def fail_second(source, destination):
        if Path(destination).name == "second.txt":
            raise OSError("injected rollback failure")
        return real_copy(source, destination)
    monkeypatch.setattr(module.shutil, "copy2", fail_second)
    assert not orch.rollback("session", result.rollback_id)
    assert (root / "sample.txt").read_bytes() == b"old\n"
    assert (root / "second.txt").read_bytes() == b"new\n"
    assert history.get_patch(result.rollback_id)["status"] == "rollback_failed"
    assert "Rollback complete" not in output.getvalue()
    monkeypatch.setattr(module.shutil, "copy2", real_copy)
    assert orch.rollback("session", result.rollback_id)
    assert (root / "second.txt").read_bytes() == b"old\n"


@pytest.mark.parametrize("tamper", ["path", "identity", "manifest_missing"])
def test_recovery_metadata_tampering_fails_closed(workspace, monkeypatch, tamper):
    root, orch, _, _ = workspace
    result = apply(workspace, monkeypatch)
    manifest = Config.PATCH_BACKUP_DIR / result.rollback_id / "manifest.json"
    if tamper == "manifest_missing":
        manifest.unlink()
    else:
        value = json.loads(manifest.read_text(encoding="utf-8"))
        if tamper == "path":
            value["backups"]["sample.txt"] = str(root.parent / "unrelated.txt")
        else:
            value["root_identity"] = [0, 0]
        manifest.write_text(json.dumps(value), encoding="utf-8")
    approve_rollback(monkeypatch, result.rollback_id)
    assert not orch.rollback("session", result.rollback_id)
    assert (root / "sample.txt").read_bytes() == b"new\n"


def test_noninteractive_rollback_does_not_restore(workspace, monkeypatch):
    root, orch, _, _ = workspace
    result = apply(workspace, monkeypatch)
    monkeypatch.setattr("arcanos.agentic.patch_orchestrator.sys.stdin", type("NonTty", (), {"isatty": lambda _: False})())
    assert not orch.rollback("session", result.rollback_id)
    assert (root / "sample.txt").read_bytes() == b"new\n"


def test_safe_mode_changed_during_rollback_confirmation_blocks(workspace, monkeypatch):
    root, orch, _, _ = workspace
    result = apply(workspace, monkeypatch)
    def confirm(_prompt=""):
        orch.guard.enable_safe_mode("session", "test")
        return result.rollback_id
    monkeypatch.setattr("builtins.input", confirm)
    assert not orch.rollback("session", result.rollback_id)
    assert (root / "sample.txt").read_bytes() == b"new\n"


def test_apply_exception_is_sanitized_and_preserves_failure(workspace, monkeypatch):
    _, orch, history, _ = workspace
    import arcanos.agentic.patch_orchestrator as module
    def fail(*_args, **_kwargs):
        raise OSError("Authorization: Token privatefixture")
    monkeypatch.setattr(module, "apply_authorized_patch", fail)
    approve(monkeypatch, patch_for())
    result = orch.apply_with_approval("session", patch_for())
    assert not result.ok and result.status == "failed"
    assert result.workspace_changed is None
    assert "privatefixture" not in result.error
    stored = history._conn().execute("SELECT error FROM patches WHERE rollback_id=?", (result.rollback_id,)).fetchone()[0]
    assert "privatefixture" not in stored


def test_remote_helper_defaults_to_backup_before_mutation(workspace, monkeypatch):
    root, _, _, _ = workspace
    patch = patch_for()
    payload = {"patch": patch, "expectedPatchSha256": hashlib.sha256(patch.encode()).hexdigest()}
    authorization = patch_handler.issue_patch_execution_authorization(payload, authorization_id="fixture-action")
    real_run = patch_handler.run_bounded_process
    observed = []
    def checked_run(argv, **kwargs):
        if "apply" in argv:
            backup = list(Config.PATCH_BACKUP_DIR.glob("*/files/sample.txt"))[0]
            manifest = json.loads((backup.parents[1] / "manifest.json").read_text(encoding="utf-8"))
            assert backup.read_bytes() == b"old\n"
            assert manifest["status"] == "applying"
            observed.append(True)
        return real_run(argv, **kwargs)
    monkeypatch.setattr(patch_handler, "run_bounded_process", checked_run)
    result = patch_handler.apply_authorized_patch(payload, workspace_root=root, timeout_ms=5000, mutation_authorization=authorization)
    assert result.applied and observed == [True]
    assert result.backups


def test_linked_git_worktree_patch_remains_explicitly_unsupported(workspace, monkeypatch, tmp_path):
    root, orch, _, _ = workspace
    worktree = tmp_path / "linked"
    subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "worktree", "add", "--detach", str(worktree)], cwd=root, check=True, capture_output=True)
    (worktree / "sample.txt").write_bytes(b"old\n")
    monkeypatch.chdir(worktree)
    approve(monkeypatch, patch_for())
    result = orch.apply_with_approval("session", patch_for())
    assert not result.ok and result.status == "failed"
    assert "physical .git directory" in result.error
    assert (worktree / "sample.txt").read_bytes() == b"old\n"


def test_rollback_detects_unrelated_mode_change(workspace, monkeypatch):
    root, orch, _, _ = workspace
    result = apply(workspace, monkeypatch)
    approve_rollback(monkeypatch, result.rollback_id)
    target = root / "sample.txt"
    mode = target.stat().st_mode
    try:
        target.chmod(0o400)
        assert not orch.rollback("session", result.rollback_id)
        assert target.read_bytes() == b"new\n"
    finally:
        target.chmod(mode)


@pytest.mark.parametrize("operation", ["apply", "rollback"])
def test_dry_run_changed_during_confirmation_blocks_mutation(workspace, monkeypatch, operation):
    root, orch, _, _ = workspace
    dry_run = False
    if operation == "rollback":
        result = apply(workspace, monkeypatch)
        before = b"new\n"
    else:
        before = b"old\n"
    def confirm(prompt=""):
        nonlocal dry_run
        if "SHA-256" in prompt:
            return hashlib.sha256(patch_for().encode()).hexdigest()
        dry_run = True
        return result.rollback_id if operation == "rollback" else "y"
    monkeypatch.setattr("builtins.input", confirm)
    if operation == "rollback":
        assert not orch.rollback("session", result.rollback_id, dry_run=lambda: dry_run)
    else:
        outcome = orch.apply_with_approval("session", patch_for(), dry_run=lambda: dry_run)
        assert not outcome.ok and outcome.status == "proposed"
    assert (root / "sample.txt").read_bytes() == before


@pytest.mark.parametrize("outcome", ["success", "nonzero", "exception"])
def test_remote_patch_history_is_registered_before_execution_and_remains_rollbackable(workspace, monkeypatch, outcome):
    root, _, _, _ = workspace
    history = HistoryDB()
    orch = PatchOrchestrator(Console(file=io.StringIO()), history, PolicyGuard(history))
    patch = patch_for()
    payload = {"patch": patch, "expectedPatchSha256": hashlib.sha256(patch.encode()).hexdigest()}
    authorization = patch_handler.issue_patch_execution_authorization(payload, authorization_id="remote-operation")
    real_run = patch_handler.run_bounded_process
    observed = []
    def checked_run(argv, **kwargs):
        if "apply" not in argv:
            return real_run(argv, **kwargs)
        rows = history.recent_patches()
        assert len(rows) == 1 and rows[0].status == "applying"
        assert rows[0].backups
        observed.append(rows[0].rollback_id)
        if outcome == "success":
            return real_run(argv, **kwargs)
        (root / "sample.txt").write_bytes(b"partial\n")
        if outcome == "exception":
            raise TimeoutError("injected remote failure")
        return ProcessResult(tuple(argv), 7, "", "injected remote failure", 1, False)
    monkeypatch.setattr(patch_handler, "run_bounded_process", checked_run)
    kwargs = dict(workspace_root=root, timeout_ms=5000, mutation_authorization=authorization, history_session_id="remote-session")
    if outcome == "exception":
        with pytest.raises(TimeoutError):
            patch_handler.apply_authorized_patch(payload, **kwargs)
    else:
        result = patch_handler.apply_authorized_patch(payload, **kwargs)
        assert result.applied is (outcome == "success")
    assert observed
    record = history.get_patch(observed[0])
    assert record["status"] == ("applied" if outcome == "success" else "failed")
    assert record["session_id"] == "remote-session"
    approve_rollback(monkeypatch, observed[0])
    assert orch.rollback("operator", observed[0])
    assert (root / "sample.txt").read_bytes() == b"old\n"
