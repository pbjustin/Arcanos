#!/usr/bin/env python3
"""Prove file/process recovery over HTTPS on an independently owned Railway PR preview."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from uuid import UUID, uuid4


VERSION = "ios-operation-recovery-https/v1"
PHASE_COUNTS = {"submit": (9, 1, 0), "recover": (10, 0, 2), "check-terminal": (8, 0, 0)}
UNLISTED_JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"
BASE_CHECKS = ["clean_exact_git_head_and_canonical_origin", "pr_scoped_https_origins",
               "network_opt_in_gate_validated"]
PHASE_CHECKS = {
    "submit": ["file_intent_persisted_before_https_create", "accepted_job_handle_persisted_to_file"],
    "recover": ["accepted_job_handle_restored_from_file", "foreign_device_and_origin_partitions_hidden",
                "restored_job_pending_result_observed_over_https", "restored_job_completed_result_observed_over_https",
                "terminal_state_persisted_to_file", "late_callbacks_leave_terminal_file_unchanged"],
    "check-terminal": ["terminal_state_restored_in_new_process"],
}


class ProofFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ProofFailure(code)


def inspect_store(path, operation_id, device_id, origin, state):
    data = path.read_bytes()
    require(0 < len(data) <= 65_536, "STORE_SIZE_INVALID")
    records = json.loads(data)
    require(isinstance(records, list) and len(records) == 1, "STORE_RECORD_COUNT_INVALID")
    record = records[0]
    allowed = {"id", "partition", "kind", "displaySummary", "createdAt", "updatedAt",
               "idempotencyKey", "backendJobID", "backendStatus", "localState"}
    require(set(record).issubset(allowed), "UNEXPECTED_PERSISTED_FIELD")
    require(UUID(record["id"]) == operation_id and record["partition"] == {
        "deviceID": str(device_id), "origin": origin}, "PERSISTED_PARTITION_INVALID")
    require(record["kind"] == "remoteAI" and record["localState"] == state,
            "PERSISTED_STATE_INVALID")
    for forbidden in [b"test-ios-preview-only-v1", b"sealed-ios-gateway-ai-v1",
                      b"Synthetic iOS Gateway answer.", b"Authorization", b"Bearer "]:
        require(forbidden not in data, "SENSITIVE_FIXTURE_MATERIAL_PERSISTED")
    return record, data


def execute(arguments, binary, repository):
    reports = []
    operation_id, device_id = uuid4(), uuid4()
    deadline = time.monotonic() + 120
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
    # Portable Linux Swift may need its locally extracted runtime libraries.
    if os.environ.get("LD_LIBRARY_PATH"):
        environment["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    with tempfile.TemporaryDirectory(prefix="arcanos-recovery-preview-") as directory:
        store = Path(directory) / "accepted" / "operations.json"

        def child(phase, store_path, *, dry=False, negative=False):
            command = [str(binary), "--recovery-phase", phase, "--store-path", str(store_path),
                       "--operation-id", str(operation_id), "--device-id", str(device_id),
                       "--repository-root", str(repository),
                       "--pr-number", str(arguments.pr_number), "--commit-sha", arguments.commit_sha,
                       "--web-base-url", arguments.web_base_url, "--worker-base-url", arguments.worker_base_url]
            if not dry:
                command += ["--execute", "--allow-network"]
            remaining = deadline - time.monotonic()
            require(remaining > 0, "TOTAL_TIMEOUT")
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                process = subprocess.Popen(command, cwd=repository, env=environment,
                                           stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
                try:
                    process.wait(timeout=min(40, remaining))
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                    raise ProofFailure("CHILD_TIMEOUT") from None
                stdout.seek(0)
                stderr.seek(0)
                output, errors = stdout.read(65_537), stderr.read(65_537)
            require(len(output) <= 65_536 and len(errors) <= 65_536, "CHILD_OUTPUT_LIMIT")
            require(process.pid not in [report["processID"] for report in reports], "PROCESS_ID_REUSED")
            if negative:
                require(process.returncode == 1 and not output, "NEGATIVE_CONTROL_NOT_REJECTED")
                report = json.loads(errors)
                require(report.get("status") == "FAIL" and report.get("code") == "JOB_RESULT_NOT_FOUND",
                        "NEGATIVE_CONTROL_FAILED_UNEXPECTEDLY")
                expected_counts = (5, 0, 1)
            else:
                if process.returncode != 0:
                    try:
                        failure = json.loads(errors).get("code", "CHILD_FAILED")
                    except (ValueError, AttributeError):
                        failure = "CHILD_FAILED"
                    raise ProofFailure(failure if re.fullmatch(r"[A-Z_]{1,80}", failure) else "CHILD_FAILED")
                require(not errors, "UNEXPECTED_CHILD_STDERR")
                report = json.loads(output)
                require(report.get("status") == "PASS", "CHILD_PROOF_FAILED")
                expected_counts = (0, 0, 0) if dry else PHASE_COUNTS[phase]
            require(report.get("kind") == "ios_operation_recovery_https_proof"
                    and report.get("proofVersion") == VERSION and report.get("phase") == phase
                    and report.get("sourceCommit") == arguments.commit_sha
                    and report.get("prNumber") == arguments.pr_number
                    and report.get("webBaseURL") == arguments.web_base_url
                    and report.get("workerBaseURL") == arguments.worker_base_url
                    and report.get("processID") == process.pid
                    and UUID(report.get("operationID", "")) == operation_id,
                    "CHILD_IDENTITY_INVALID")
            require(report.get("executed") is (not dry) and report.get("networkAttempted") is (not dry),
                    "CHILD_EXECUTION_FLAGS_INVALID")
            require(tuple(report.get(key) for key in ["requestsMade", "createRequests", "resultRequests"])
                    == expected_counts, "CHILD_REQUEST_ACCOUNTING_INVALID")
            require(isinstance(report.get("responseBytes"), int) and 0 <= report["responseBytes"] <= 2_097_152,
                    "CHILD_RESPONSE_ACCOUNTING_INVALID")
            expected_checks = list(BASE_CHECKS)
            if not dry:
                expected_checks += ["initial_roles_device_policy_and_metadata_verified"]
                expected_checks += PHASE_CHECKS[phase][:2] if negative else PHASE_CHECKS[phase]
                if not negative:
                    expected_checks += ["phase_job_request_counts_and_identities_verified",
                                        "final_roles_device_policy_metadata_and_git_unchanged"]
            require(report.get("checks") == expected_checks, "CHILD_ASSERTIONS_INCOMPLETE")
            report["negativeControl"] = negative
            reports.append(report)
            return report

        child("submit", store, dry=True)
        require(not store.exists(), "DRY_RUN_TOUCHED_STORE")
        if arguments.execute:
            accepted_report = child("submit", store)
            accepted, accepted_bytes = inspect_store(store, operation_id, device_id, arguments.web_base_url, "accepted")
            job_id = accepted["backendJobID"]
            require(UUID(job_id) and job_id == accepted_report["backendJobID"]
                    and accepted["backendStatus"] == "queued", "ACCEPTANCE_NOT_DURABLE")

            # A valid-looking but unknown handle must fail on the real HTTPS result route.
            invalid_store = Path(directory) / "negative" / "operations.json"
            invalid_store.parent.mkdir()
            corrupted = json.loads(accepted_bytes)
            corrupted[0]["backendJobID"] = UNLISTED_JOB
            invalid_store.write_text(json.dumps(corrupted), encoding="utf-8")
            original_negative = invalid_store.read_bytes()
            child("recover", invalid_store, negative=True)
            require(invalid_store.read_bytes() == original_negative and store.read_bytes() == accepted_bytes,
                    "FAILED_READ_CHANGED_STORE")

            recovered = child("recover", store)
            terminal, terminal_bytes = inspect_store(store, operation_id, device_id, arguments.web_base_url, "terminal")
            require(terminal["backendStatus"] == "completed" and terminal["backendJobID"] == job_id
                    and terminal["idempotencyKey"] == accepted["idempotencyKey"]
                    and recovered["backendJobID"] == job_id, "COMPLETION_NOT_DURABLE")
            terminal_report = child("check-terminal", store)
            require(store.read_bytes() == terminal_bytes and terminal_report["backendJobID"] == job_id,
                    "TERMINAL_RESTART_CHANGED_STORE")
    require(not Path(directory).exists(), "LOCAL_STORE_CLEANUP_FAILED")
    return {"phases": reports, "processCount": len(reports),
            "requestsMade": sum(report["requestsMade"] for report in reports),
            "createRequests": sum(report["createRequests"] for report in reports),
            "resultRequests": sum(report["resultRequests"] for report in reports),
            "localStoreCleanupConfirmed": True,
            "negativeControl": "unknown_handle_rejected_without_file_mutation" if arguments.execute else "not_executed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swift-binary", type=Path, required=True)
    parser.add_argument("--pr-number", type=int, required=True)
    parser.add_argument("--commit-sha", required=True)
    parser.add_argument("--web-base-url", required=True)
    parser.add_argument("--worker-base-url", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-network", action="store_true")
    arguments = parser.parse_args()
    report = {"version": VERSION, "ok": False, "executed": arguments.execute,
              "scope": "Swift file/process recovery over HTTPS against sealed synthetic Railway peer",
              "shippingAppLifecycle": False, "physicalDevice": False, "liveProvider": False,
              "database": False, "activeWorker": False, "controlPlaneOwnershipAsserted": False}
    try:
        require(os.name == "posix", "POSIX_REQUIRED")
        require(arguments.execute == arguments.allow_network, "NETWORK_OPT_IN_INCOMPLETE")
        binary = arguments.swift_binary.resolve(strict=True)
        require(binary.is_file() and os.access(binary, os.X_OK), "SWIFT_BINARY_UNAVAILABLE")
        repository = Path(__file__).resolve().parents[3]
        report.update(sourceCommit=arguments.commit_sha, prNumber=arguments.pr_number,
                      binarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest())
        report.update(execute(arguments, binary, repository))
        require(report["requestsMade"] == (32 if arguments.execute else 0)
                and report["createRequests"] == (1 if arguments.execute else 0)
                and report["resultRequests"] == (3 if arguments.execute else 0), "FINAL_REQUEST_ACCOUNTING_INVALID")
        report["ok"] = True
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, ProofFailure) else "RECOVERY_PREVIEW_PROOF_FAILED"
    print(json.dumps(report, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
