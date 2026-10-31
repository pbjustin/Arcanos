"""Opt-in native Windows acceptance; writes only to a new disposable receipt root."""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib
import json
import os
from pathlib import Path
import platform
import sqlite3
import subprocess
import sys
import traceback

from local_action_acceptance.common import cleanup_probe, profile_probe, read_jsonl, sha256, write_json

PARTS = ("cli", "powershell", "bridge", "patches", "assignments", "actionplans")


def _part_status(result: dict) -> str:
    cases = result.get("cases", [])
    if isinstance(cases, dict):
        cases = list(cases.values())
    if not isinstance(cases, list):
        return "BLOCKED"
    incomplete_cases = any(not isinstance(case, dict) or case.get("status") != "PASS" for case in cases)
    statuses = [case.get("status") for case in cases if isinstance(case, dict)]
    statuses += list(result.get("gates", {}).values())
    statuses += [result.get("status")]
    cleanup_failed = any(value is False for value in result.get("cleanup", {}).values())
    cleanup_failed |= any(result.get(key) is False for key in ("all_consoles_closed", "all_child_processes_exited", "all_native_processes_exited"))
    if result.get("failed", 0) or "FAIL" in statuses or cleanup_failed:
        return "FAIL"
    if not cases or incomplete_cases or any(value not in {None, "PASS"} for value in statuses):
        return "BLOCKED"
    return "PASS"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New, disposable directory outside the source checkout")
    parser.add_argument("--parts", nargs="+", choices=PARTS, default=list(PARTS))
    args = parser.parse_args()
    if len(args.parts) != len(set(args.parts)):
        parser.error("Duplicate parts cannot establish complete acceptance")
    if os.name != "nt":
        parser.error("This acceptance requires native Windows, not WSL or a Linux runner")
    source = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if output.exists():
        parser.error("Output directory already exists; preserve prior evidence and choose a new path")
    if output == source or source in output.parents:
        parser.error("Mutation/evidence area must be separate from the source checkout")
    output.mkdir(parents=True)
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    dirty = subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True)
    diff = subprocess.check_output(["git", "diff", "HEAD", "--", "daemon-python"], cwd=source)
    fixtures = sorted((source / "daemon-python/scripts/local_action_acceptance").glob("*.py")) + [Path(__file__)]
    receipt = {
        "schema": "arcanos-windows-local-action-acceptance-v1", "tested_head_sha": head,
        "source_worktree": str(source), "source_clean": not bool(dirty),
        "snapshot_kind": "EXACT_COMMIT" if not dirty else "WORKING_SNAPSHOT_NOT_EXACT_HEAD",
        "production_diff_sha256": hashlib.sha256(diff).hexdigest(),
        "windows": platform.platform(), "python": sys.version, "python_executable": sys.executable,
        "fixture_source_hashes": {str(path.relative_to(source)): sha256(path) for path in fixtures},
        "entrypoint": [sys.executable, "daemon-python/scripts/run_windows_local_action_acceptance.py", "--output", str(output)],
        "parts": {}, "real_provider_calls": 0, "production_effects": 0, "live_uac_acceptance": "NOT_RUN",
        "evidence_categories": ["ACTUAL_INTERACTIVE_WINDOWS_CLI", "ACTUAL_LOOPBACK_HTTP", "ACTUAL_GIT_AND_SQLITE",
                                "INJECTED_FAULT_AROUND_REAL_OPERATION", "MOCK_ONLY_REGRESSIONS_REPORTED_SEPARATELY"],
    }
    inventory = []
    for name in ("test_local_execution_reliability.py", "test_patch_lifecycle_reliability.py", "test_daemon_action_reliability.py",
                 "test_local_bridge_security.py", "test_local_bridge_lifecycle.py", "test_local_agent_protocol_runner.py",
                 "test_action_plan_execution_runner.py", "test_answer_integrity.py"):
        path = source / "daemon-python/tests" / name
        text = path.read_text(encoding="utf-8")
        inventory.append({"path": str(path.relative_to(source)), "sha256": sha256(path),
                          "test_functions": sum(isinstance(node, ast.FunctionDef) and node.name.startswith("test_") for node in ast.parse(text).body),
                          "contains_mock_or_monkeypatch_seams": "monkeypatch" in text or "unittest.mock" in text,
                          "classification": "ALREADY_COVERED", "acceptance_limit": "Unit/component regressions; not counted as native full CLI acceptance"})
    receipt["existing_coverage_inventory"] = inventory
    receipt["cleanup_probe"] = cleanup_probe(output / "harness-cleanup", source)
    receipt["profile_probe"] = profile_probe(output / "profile-preflight", source)
    failed = receipt["cleanup_probe"]["status"] != "PASS"
    blocked = set(args.parts) != set(PARTS) or bool(dirty) or receipt["profile_probe"]["status"] != "PASS"
    selected = args.parts if receipt["profile_probe"]["status"] == "PASS" else []
    for name in selected:
        try:
            module = importlib.import_module(f"local_action_acceptance.{name}")
            result = module.run(output / name, source)
            result["status"] = _part_status(result)
            if "http_request_count" not in result:
                cases = result.get("cases", [])
                if isinstance(cases, dict):
                    cases = list(cases.values())
                result["http_request_count"] = sum(len(case.get("http_requests", [])) for case in cases if isinstance(case, dict))
            receipt["parts"][name] = result
            if result.get("failed", 0) > 0:
                failed = True
            if not result.get("cases"):
                blocked = True
            if result.get("status") == "FAIL" or any(case.get("status") == "FAIL" for case in result.get("cases", []) if isinstance(case, dict)):
                failed = True
            if result.get("classification") == "NOT_RUN" or result.get("status") in {"BLOCKED", "NOT_RUN"}:
                blocked = True
            if any(value == "FAIL" for value in result.get("gates", {}).values()):
                failed = True
            if any(value in {"BLOCKED", "NOT_RUN"} for value in result.get("gates", {}).values()):
                blocked = True
            if any(value is False for value in result.get("cleanup", {}).values()):
                failed = True
            if any(result.get(key) is False for key in ("all_consoles_closed", "all_child_processes_exited", "all_native_processes_exited")):
                failed = True
            write_json(output / f"{name}-receipt.json", result)
        except Exception as error:
            failed = True
            # Deliberately omit exception text: failed assertions can contain
            # synthetic secrets or private raw tool output under investigation.
            receipt["parts"][name] = {"status": "FAIL", "error_type": type(error).__name__,
                                      "trace_locations": [{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
                                                          for frame in traceback.extract_tb(error.__traceback__)]}
        write_json(output / "acceptance-receipt.json", receipt)
        part = receipt["parts"][name]
        part_status = part["status"]
        print(json.dumps({"part": name, "status": part_status}), flush=True)
    final_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    final_dirty = subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True)
    final_fixtures = sorted((source / "daemon-python/scripts/local_action_acceptance").glob("*.py")) + [Path(__file__)]
    final_hashes = {str(path.relative_to(source)): sha256(path) for path in final_fixtures}
    final_diff = subprocess.check_output(["git", "diff", "HEAD", "--", "daemon-python"], cwd=source)
    stable = (final_head == head and final_hashes == receipt["fixture_source_hashes"] and final_dirty == dirty
              and hashlib.sha256(final_diff).hexdigest() == receipt["production_diff_sha256"])
    receipt["source_stable_through_run"] = stable
    receipt["final_observed_head_sha"] = final_head
    if not stable:
        blocked = True
    receipt["profile_postflight"] = profile_probe(output / "profile-postflight", source)
    if receipt["profile_postflight"]["status"] != "PASS":
        blocked = True
    network = [row for path in output.rglob("network.jsonl") for row in read_jsonl(path)]
    denied_connections = [row for row in network if row.get("event") == "socket.connect" and not row.get("allowed")]
    unexpected_denials = [row for row in network if row.get("event", "").startswith("socket.") and not row.get("allowed")
                         and not (row.get("event") == "socket.bind" and row.get("host") == "::1" and row.get("port") == 0)]
    receipt["network_observation"] = {
        "scope": "Python socket audit hooks; selected native commands are fixed local fixture code, not an OS network sandbox",
        "pytest_hook_timing": "Disposable conftest after core startup, with plugin autoload disabled",
        "connect_attempts": sum(row.get("event") == "socket.connect" for row in network),
        "denied_connect_attempts": len(denied_connections),
        "unexpected_denied_attempts": len(unexpected_denials),
        "denied_ipv6_capability_probes": sum(row.get("event") == "socket.bind" and row.get("host") == "::1" and row.get("port") == 0 and not row.get("allowed") for row in network),
    }
    if unexpected_denials:
        failed = True
    receipt["generated_fixture_hashes"] = {str(path.relative_to(output)): sha256(path) for path in output.rglob("*")
                                          if path.is_file() and (path.suffix in {".py", ".diff", ".ini"} or path.name == "spec.json")}
    databases = []
    for database in sorted([*output.rglob("*.db"), *output.rglob("*.sqlite3")]):
        try:
            with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as connection:
                integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
            databases.append({"path": str(database.relative_to(output)), "sha256": sha256(database), "integrity": integrity})
            if integrity != ["ok"]:
                failed = True
        except sqlite3.Error as error:
            failed = True
            databases.append({"path": str(database.relative_to(output)), "error_type": type(error).__name__})
    receipt["sqlite_integrity_verification"] = databases
    receipt["verdict"] = "FAIL" if failed else "BLOCKED" if blocked else "PASS"
    receipt["all_requested_parts_run"] = set(receipt["parts"]) == set(PARTS)
    receipt["http_request_count"] = sum(part.get("http_request_count", 0) for part in receipt["parts"].values())
    write_json(output / "acceptance-receipt.json", receipt)
    print(json.dumps({"verdict": receipt["verdict"], "tested_head_sha": head, "source_clean": not bool(dirty),
                      "http_requests": receipt["http_request_count"], "receipt": str(output / "acceptance-receipt.json")}))
    return 1 if failed else 2 if blocked else 0


if __name__ == "__main__":
    raise SystemExit(main())
