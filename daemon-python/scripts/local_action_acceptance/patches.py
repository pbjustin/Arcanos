"""Windows native-terminal patch and rollback acceptance against disposable Git targets."""
from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from .common import clean_env, run_child, standalone_repo, write_json
from .conpty import ConsoleProcess


def _patch(name: str = "sample.txt", before: str | None = "old", after: str | None = "new") -> str:
    return "\n".join([
        f"diff --git a/{name} b/{name}",
        *(["new file mode 100644"] if before is None else []),
        *(["deleted file mode 100644"] if after is None else []),
        f"--- a/{name}" if before is not None else "--- /dev/null",
        f"+++ b/{name}" if after is not None else "+++ /dev/null",
        f"@@ -{1 if before is not None else 0},{1 if before is not None else 0} +{1 if after is not None else 0},{1 if after is not None else 0} @@",
        *([f"-{before}"] if before is not None else []),
        *([f"+{after}"] if after is not None else []), "",
    ])


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(case_root: Path, source_root: Path) -> dict:
    """Run real operations; every deliberate fault is separately labeled INJECTED."""
    case_root, source_root = case_root.resolve(), source_root.resolve()
    case_root.mkdir(parents=True, exist_ok=True)
    cases = []
    active = []
    inventory = []
    for name in ("test_patch_lifecycle_reliability.py", "test_patch_orchestrator_non_interactive.py"):
        path = source_root / "daemon-python/tests" / name
        tree = ast.parse(path.read_text(encoding="utf-8"))
        inventory.append({"path": str(path), "sha256": _digest(path.read_bytes()),
                          "test_functions": len([node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")]),
                          "prior_evidence": "deterministic tests; injected stdin/input is not native terminal acceptance"})

    def setup(label, files=None, patch=None):
        root = case_root / f"p{len(cases) + 1:02d}"
        env = clean_env(root, source_root)
        repository = standalone_repo(root / "repo", env)
        initial = files if files is not None else {"sample.txt": b"old\n", "second.txt": b"old\n"}
        for name, data in initial.items():
            target = repository / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        patch_file = root / "operation.diff"
        patch_file.write_text(patch or _patch(), encoding="utf-8")
        case = {"name": label, "case_root": str(root), "entrypoint": "existing PatchOrchestrator under Windows ConPTY; real input and isatty",
                "steps": [], "status": "RUNNING", "initial_sha256": {name: _digest(data) for name, data in initial.items()}}
        cases.append(case)
        return {"root": root, "env": env, "repo": repository, "patch": patch_file, "case": case}

    def step(context, operation="apply", *, rollback_id=None, fault="none", terminal=True,
             approval="approved", prompt=True, cwd=None):
        root = context["root"]
        number = len(context["case"]["steps"]) + 1
        receipt_file = root / f"step{number}.json"
        transcript_file = root / f"step{number}.txt"
        argv = [sys.executable, "-u", str(source_root / "daemon-python/scripts/local_action_acceptance/fault_child.py"),
                "--case-root", str(root), "--source-root", str(source_root), "--operation", operation,
                "--patch-file", str(context["patch"]), "--receipt", str(receipt_file), "--fault", fault]
        if rollback_id:
            argv.extend(["--rollback-id", rollback_id])
        metadata = {"operation": operation, "terminal": "ACTUAL_CONPTY" if terminal else "ACTUAL_PIPE_NONINTERACTIVE",
                    "fault": fault, "approval": approval, "receipt": str(receipt_file), "argv": argv}
        context["case"]["steps"].append(metadata)
        transcript = ""
        if terminal:
            console = ConsoleProcess(argv, cwd=cwd or context["repo"], env=context["env"])
            active.append(console)
            try:
                if prompt:
                    if operation == "apply":
                        payload_hash = _digest(context["patch"].read_text(encoding="utf-8").encode("utf-8"))
                        console.expect(payload_hash, timeout=25)
                        metadata["proposal_sha256_observed"] = payload_hash
                        value = payload_hash if approval == "approved" else "wrong-exact-hash"
                        console.send_line(value)
                        if approval == "approved":
                            console.send_line("y")
                    else:
                        console.expect("Confirm rollback id", timeout=25)
                        console.send_line(rollback_id if approval == "approved" else "wrong-rollback-id")
                    metadata["input_delivery"] = "queued actual ConPTY keystrokes after proposal/prompt observed; unmodified input/isatty"
                exit_code = console.wait(timeout=35)
                console.read_available() if hasattr(console, "read_available") else None
            finally:
                transcript = console.transcript
                console.close()
                active.remove(console)
            metadata["process_exit_code"] = exit_code
        else:
            observed = run_child(argv, cwd=cwd or context["repo"], env=context["env"], timeout=35)
            transcript = observed["stdout"] + observed["stderr"]
            metadata["process_exit_code"] = observed["exit_code"]
        transcript_file.write_text(transcript, encoding="utf-8")
        metadata["transcript_sha256"] = _digest(transcript.encode("utf-8"))
        assert metadata["process_exit_code"] == 0, "Acceptance child did not complete"
        assert receipt_file.exists(), "Acceptance child omitted receipt"
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
        assert receipt["completed"] and not receipt["unexpected_live_children"]
        assert receipt["stdin_isatty"] is terminal, "Native terminal classification does not match actual stdin"
        assert "acceptance-private-fixture" not in transcript, "Synthetic credential reached terminal"
        metadata.update({"pid": receipt["pid"], "injection": receipt["injection"],
                         "workspace_before": receipt["before"], "workspace_after": receipt["after"],
                         "history_status": receipt["history"]["status"] if receipt["history"] else None,
                         "rollback_id": receipt["rollback_id"], "result": receipt["result"],
                         "processes": receipt["processes"], "all_processes_exited": True})
        return receipt

    def applied(context):
        receipt = step(context)
        assert receipt["result"]["ok"] and receipt["result"]["status"] == "applied"
        assert receipt["result"]["exit_code"] == 0 and receipt["history"]["status"] == "applied"
        assert receipt["manifest"]["status"] == "applied"
        assert any(item["operation"] == "git.apply" and item["exit_code"] == 0 for item in receipt["processes"])
        for rel, path in receipt["result"]["backups"].items():
            assert _digest(Path(path).read_bytes()) == context["case"]["initial_sha256"][rel]
        return receipt

    def recovered(context, first):
        receipt = step(context, "rollback", rollback_id=first["rollback_id"])
        assert receipt["result"]["ok"] and receipt["history"]["status"] == "rolled_back"
        assert receipt["manifest"]["status"] == "rolled_back"
        assert {name: item["sha256"] for name, item in receipt["after"].items()} == context["case"]["initial_sha256"]
        return receipt

    def finish(context, operation):
        try:
            operation()
            context["case"]["status"] = "PASS"
        except Exception as error:
            context["case"]["status"] = "FAIL"
            context["case"]["failure"] = {"type": type(error).__name__, "reason": str(error)}
        write_json(context["root"] / "case.json", context["case"])

    for name in ("sample.txt", "caf\u00e9.txt", "\u6587\u4ef6.txt"):
        context = setup(f"actual_modify_and_rollback_{name}", {name: b"old\n"}, _patch(name))
        finish(context, lambda c=context: recovered(c, applied(c)))
    for kind, patch in (("create", _patch("created.txt", None, "new")), ("delete", _patch("sample.txt", "old", None))):
        context = setup(f"actual_{kind}_and_rollback", patch=patch)
        finish(context, lambda c=context: recovered(c, applied(c)))

    plain_deletion = "--- " + _patch("sample.txt", "old", None).split("--- ", 1)[1]
    context = setup("actual_plain_unified_delete_and_rollback", patch=plain_deletion)
    finish(context, lambda c=context: recovered(c, applied(c)))

    context = setup("ambiguous_git_deletion_rejected_before_mutation", patch=_patch("sample.txt", "old", None).replace("deleted file mode 100644\n", ""))
    def ambiguous_deletion(c=context):
        result = step(c, terminal=False, prompt=False)
        assert not result["result"]["ok"] and result["result"]["error"] == "patch_path_malformed"
        assert result["before"] == result["after"] and not (c["repo"] / "dev/null").exists()
        assert not any(item["operation"] == "git.apply" for item in result["processes"])
    finish(context, ambiguous_deletion)

    for kind in ("wrong_hash", "noninteractive", "dry", "safe", "secret"):
        context = setup(f"apply_{kind}", patch=_patch(".env") if kind == "secret" else None,
                        files={".env": b"old\n"} if kind == "secret" else None)
        def blocked_apply(c=context, k=kind):
            result = step(c, terminal=k == "wrong_hash", approval="wrong" if k == "wrong_hash" else "approved",
                          fault=k if k in {"dry", "safe"} else "none", prompt=k == "wrong_hash")
            assert not result["result"]["ok"] and result["before"] == result["after"]
            assert not any(item["operation"] == "git.apply" for item in result["processes"])
            assert result["result"]["status"] == ("proposed" if k == "dry" else "denied" if k in {"wrong_hash", "noninteractive"} else "blocked")
        finish(context, blocked_apply)

    for kind in ("wrong_id", "noninteractive", "dry", "safe", "conflict", "missing_backup", "tampered_backup", "wrong_workspace", "malformed_metadata", "metadata_shape", "repeat"):
        context = setup(f"rollback_{kind}")
        def blocked_rollback(c=context, k=kind):
            first = applied(c)
            if k == "repeat":
                first = recovered(c, first)
            if k == "conflict":
                (c["repo"] / "sample.txt").write_bytes(b"unrelated edit\n")
            if k in {"missing_backup", "tampered_backup"}:
                backup = Path(first["result"]["backups"]["sample.txt"]).resolve()
                backup.relative_to(c["root"])
                backup.unlink() if k == "missing_backup" else backup.write_bytes(b"tampered backup\n")
            if k in {"malformed_metadata", "metadata_shape"}:
                manifest = Path(first["backup_root"]) / first["rollback_id"] / "manifest.json"
                if k == "malformed_metadata":
                    manifest.write_text("{not-json", encoding="utf-8")
                else:
                    value = json.loads(manifest.read_text(encoding="utf-8")); value["files"] = "invalid-list"
                    manifest.write_text(json.dumps(value), encoding="utf-8")
            alternate = None
            if k == "wrong_workspace":
                alternate = standalone_repo(c["root"] / "other", c["env"])
                (alternate / "sample.txt").write_bytes(b"unrelated workspace\n")
            terminal = k == "wrong_id"
            result = step(c, "rollback", rollback_id=first["rollback_id"], terminal=terminal,
                          approval="wrong" if k == "wrong_id" else "approved", prompt=terminal,
                          fault=k if k in {"dry", "safe"} else "none", cwd=alternate)
            assert not result["result"]["ok"] and result["before"] == result["after"]
        finish(context, blocked_rollback)

    context = setup("actual_nonzero_git_without_mutation", files={"sample.txt": b"different context\n"})
    def rejected_git(c=context):
        result = step(c)
        assert not result["result"]["ok"] and result["result"]["exit_code"] != 0
        assert result["before"] == result["after"] and result["history"]["status"] == "failed"
        assert any(item["operation"] == "git.apply" and item["exit_code"] != 0 for item in result["processes"])
    finish(context, rejected_git)

    context = setup("injected_split_actual_git_partial_failure", patch=_patch() + _patch("second.txt"))
    def partial_git(c=context):
        result = step(c, fault="partial_git")
        assert not result["result"]["ok"] and result["result"]["workspace_changed"] is True
        exits = [item["exit_code"] for item in result["processes"] if item["operation"] == "git.apply"]
        assert len(exits) == 2 and exits[0] == 0 and exits[1] != 0
        assert result["after"]["sample.txt"]["sha256"] == _digest(b"new\n")
        assert result["after"]["second.txt"]["sha256"] == _digest(b"old\n")
        recovered(c, result)
    finish(context, partial_git)

    for kind in ("sqlite_pre", "sqlite_final"):
        context = setup(f"injected_{kind}")
        def sqlite_apply(c=context, k=kind):
            result = step(c, fault=k)
            if k == "sqlite_pre":
                assert not result["result"]["ok"] and result["result"]["status"] == "blocked"
                assert result["before"] == result["after"]
                assert not any(item["operation"] == "git.apply" for item in result["processes"])
            else:
                assert result["result"]["ok"] and result["result"]["exit_code"] == 0
                assert "history" in result["result"]["error"] and result["history"]["status"] == "applying"
                recovered(c, result)
        finish(context, sqlite_apply)

    for kind in ("rollback_sqlite_final", "rollback_partial", "rollback_sqlite_partial"):
        context = setup(f"injected_{kind}", patch=_patch() + _patch("second.txt"))
        def sqlite_rollback(c=context, k=kind):
            first = applied(c)
            result = step(c, "rollback", rollback_id=first["rollback_id"], fault=k)
            if k == "rollback_sqlite_final":
                assert result["result"]["ok"] and result["manifest"]["status"] == "rolled_back"
                assert result["history"]["status"] == "applied"
                assert {name: item["sha256"] for name, item in result["after"].items()} == c["case"]["initial_sha256"]
            else:
                assert not result["result"]["ok"] and result["manifest"]["status"] == "rolling_back"
                assert result["manifest"]["restored"] == ["sample.txt"]
                assert result["after"]["sample.txt"]["sha256"] == _digest(b"old\n")
                assert result["after"]["second.txt"]["sha256"] == _digest(b"new\n")
                recovered(c, first)
        finish(context, sqlite_rollback)

    source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source_root,
                                            env=clean_env(case_root, source_root), text=True).strip()
    production_paths = ["daemon-python/arcanos/cli/cli_policy.py", "daemon-python/arcanos/agentic/patch_orchestrator.py",
                        "daemon-python/arcanos/agentic/history_db.py", "daemon-python/arcanos/local_agent/patch_handler.py"]
    source_diff = subprocess.check_output(["git", "diff", "--binary", "HEAD", "--", *production_paths], cwd=source_root,
                                         env=clean_env(case_root, source_root))
    receipt = {"suite": "patches", "platform": sys.platform, "source_root": str(source_root),
               "source_commit": source_commit, "production_diff_sha256": _digest(source_diff),
               "production_modified_from_commit": bool(source_diff),
               "production_file_sha256": {name: _digest((source_root / name).read_bytes()) for name in production_paths},
               "inventory": inventory, "cases": cases, "case_count": len(cases),
               "passed": sum(case["status"] == "PASS" for case in cases),
               "failed": sum(case["status"] == "FAIL" for case in cases),
               "all_consoles_closed": not active, "fixtures_retained_under_case_root": True,
               "classification": "native Windows/Git/SQLite acceptance; explicit fault cases labeled INJECTED",
               "real_provider_calls": 0, "production_changes": 0}
    write_json(case_root / "patches-receipt.json", receipt)
    return receipt
