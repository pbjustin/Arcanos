#!/usr/bin/env python3
"""Prove shipping composition/file recovery through independently owned Railway HTTPS hosts."""

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


VERSION = "ios-shipping-recovery-https/v1"
ADAPTER = "fixed-synthetic-device-bearer-to-public-preview-bearer"
CHILD_SCOPE = "ShippingSessionComposition and durable files across fresh CLI processes over actual HTTPS against a sealed synthetic peer"
UNKNOWN_JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"
COUNTS = {"dismiss-submit": (12, 1, 3, 0), "ai-restore": (11, 0, 0, 3),
          "concurrent-submit": (10, 0, 2, 0), "capability-restore": (10, 0, 0, 2),
          "foreign": (8, 0, 0, 0), "terminal": (9, 0, 0, 1), "unknown-handle": (5, 0, 0, 1)}
BASE_CHECKS = ["clean_exact_git_head_and_canonical_origin", "pr_scoped_https_origins", "network_opt_in_gate_validated"]
CHECKS = {
    "dismiss-submit": ["cancelled_approval_durably_dismissed_without_retry",
                       "expired_approval_durably_dismissed_without_retry",
                       "already_expired_challenge_durably_dismissed", "shipping_ai_receipt_durable_before_process_exit"],
    "concurrent-submit": ["inflight_and_pending_approval_block_overlap_without_phantom_record",
                          "held_approved_retry_blocks_overlap_and_replay_without_phantom_record",
                          "approved_retry_exact_bytes_and_idempotency_once"],
    "ai-restore": ["shipping_startup_and_result_recovery_bound_to_saved_operation"],
    "capability-restore": ["shipping_startup_and_result_recovery_bound_to_saved_operation"],
    "terminal": ["shipping_startup_and_result_recovery_bound_to_saved_operation"],
    "foreign": ["foreign_credential_partition_no_gateway_requests_or_file_mutation"],
    "unknown-handle": ["unknown_handle_denies_cached_completion_without_mutation_or_replay"],
}
FORBIDDEN = [b"agd1.", b"test-ios-preview-only-v1", b"sealed-ios-gateway-ai-v1",
             b"Synthetic iOS Gateway answer.", b"confirmation_token", b"synthetic-ios-challenge-",
             b"Authorization", b"Bearer "]
FLAGS = ["shippingAppLifecycle", "physicalDevice", "liveProvider", "database", "activeWorker",
         "controlPlaneProvenanceAsserted"]


class ProofFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ProofFailure(code)


def read_child_output(stdout, stderr):
    stdout.seek(0)
    stderr.seek(0)
    output, errors = stdout.read(65_537), stderr.read(65_537)
    require(len(output) <= 65_536 and len(errors) <= 65_536, "CHILD_OUTPUT_LIMIT")
    return output, errors


def validate_report(report, arguments, phase, pid, *, dry=False, negative=False):
    require(isinstance(report, dict), "CHILD_REPORT_INVALID")
    expected_keys = {"kind", "proofVersion", "scope", "credentialStorage", "credentialAdapter", *FLAGS,
                     "status", "phase", "executed", "networkAttempted", "prNumber", "sourceCommit",
                     "webBaseURL", "workerBaseURL", "processID", "requestsMade", "createRequests",
                     "capabilityRequests", "resultRequests", "responseBytes", "checks"}
    optional = {"operationID", "backendJobID", "code"}
    require(expected_keys <= set(report) <= expected_keys | optional, "CHILD_FIELDS_INVALID")
    require(report["kind"] == "ios_shipping_recovery_https_proof" and report["proofVersion"] == VERSION
            and report["phase"] == phase and report["sourceCommit"] == arguments.commit_sha
            and report["prNumber"] == arguments.pr_number and report["webBaseURL"] == arguments.web_base_url
            and report["workerBaseURL"] == arguments.worker_base_url and report["processID"] == pid,
            "CHILD_IDENTITY_INVALID")
    require(report["status"] == ("FAIL" if negative else "PASS")
            and report.get("code") == ("SHIPPING_UNKNOWN_HANDLE_REJECTED" if negative else None), "CHILD_OUTCOME_INVALID")
    require(report["executed"] is (not dry) and report["networkAttempted"] is (not dry)
            and all(report[name] is False for name in FLAGS)
            and report["scope"] == CHILD_SCOPE
            and report["credentialStorage"] == "in-memory-fixture" and report["credentialAdapter"] == ADAPTER,
            "CHILD_SCOPE_INVALID")
    values = tuple(report[key] for key in ["requestsMade", "createRequests", "capabilityRequests", "resultRequests"])
    require(all(type(value) is int for value in values) and values == ((0, 0, 0, 0) if dry else COUNTS[phase]),
            "CHILD_REQUEST_ACCOUNTING_INVALID")
    require(type(report["responseBytes"]) is int and 0 <= report["responseBytes"] <= 2_097_152
            and (report["responseBytes"] == 0 if dry else report["responseBytes"] > 0), "CHILD_RESPONSE_ACCOUNTING_INVALID")
    expected = list(BASE_CHECKS)
    if not dry:
        expected += ["initial_roles_device_policy_and_metadata_verified"] + CHECKS[phase]
        if not negative:
            expected += ["phase_gateway_request_counts_and_identities_verified", "final_roles_device_policy_metadata_and_git_unchanged"]
    require(report["checks"] == expected, "CHILD_ASSERTIONS_INCOMPLETE")
    if not dry and phase != "foreign":
        require(isinstance(report.get("operationID"), str) and isinstance(report.get("backendJobID"), str), "CHILD_JOB_IDENTITY_MISSING")
        UUID(report["operationID"])
        UUID(report["backendJobID"])
    else:
        require(report.get("operationID") is None and report.get("backendJobID") is None, "CHILD_UNEXPECTED_JOB_IDENTITY")
    raw = json.dumps(report).encode()
    require(not any(value in raw for value in FORBIDDEN), "CHILD_REPORT_SENSITIVE_DATA")


def inspect_store(path, device_id, origin, count, state, kind):
    data = path.read_bytes()
    require(0 < len(data) <= 65_536, "STORE_SIZE_INVALID")
    records = json.loads(data)
    require(isinstance(records, list) and len(records) == count, "STORE_COUNT_INVALID")
    ids, keys = set(), set()
    allowed = {"id", "partition", "kind", "displaySummary", "createdAt", "updatedAt", "idempotencyKey",
               "backendJobID", "backendStatus", "localState", "capabilityAction"}
    for record in records:
        require(isinstance(record, dict) and set(record).issubset(allowed), "STORE_FIELDS_INVALID")
        identifier = UUID(record["id"])
        require(identifier not in ids and record["idempotencyKey"] not in keys, "STORE_DUPLICATE_OPERATION")
        ids.add(identifier)
        keys.add(record["idempotencyKey"])
        require(record["partition"] == {"deviceID": str(device_id), "origin": origin}, "STORE_PARTITION_INVALID")
        if record["localState"] == "dismissed":
            require(record["kind"] == "confirmation" and record.get("capabilityAction") == "tests.run"
                    and record.get("backendJobID") is None and record.get("backendStatus") is None, "DISMISSAL_ACQUIRED_RECEIPT")
    selected = [record for record in records if record["localState"] != "dismissed"]
    require(len(selected) == 1 and selected[0]["localState"] == state and selected[0]["kind"] == kind,
            "STORE_ACTIVE_OPERATION_INVALID")
    record = selected[0]
    UUID(record["backendJobID"])
    require(record["backendStatus"] == ("completed" if state == "terminal" else "queued" if kind == "remoteAI" else "pending"),
            "STORE_BACKEND_STATUS_INVALID")
    require(not any(value in data for value in FORBIDDEN), "STORE_SENSITIVE_DATA")
    return record, data


def execute(arguments, binary, repository):
    reports = []
    device_id, foreign_id = uuid4(), uuid4()
    deadline = time.monotonic() + 120
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
    if os.environ.get("LD_LIBRARY_PATH"):
        environment["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    with tempfile.TemporaryDirectory(prefix="arcanos-shipping-preview-") as directory:
        root = Path(directory)
        ai_store, capability_store = root / "ai" / "operations.json", root / "capability" / "operations.json"

        def child(phase, store, *, device=device_id, dry=False, negative=False):
            command = [str(binary), "--shipping-recovery-phase", phase, "--store-path", str(store),
                       "--device-id", str(device), "--repository-root", str(repository),
                       "--pr-number", str(arguments.pr_number), "--commit-sha", arguments.commit_sha,
                       "--web-base-url", arguments.web_base_url, "--worker-base-url", arguments.worker_base_url]
            if not dry:
                command += ["--execute", "--allow-network"]
            remaining = deadline - time.monotonic()
            require(remaining > 0, "TOTAL_TIMEOUT")
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                process = subprocess.Popen(command, cwd=repository, env=environment, stdin=subprocess.DEVNULL,
                                           stdout=stdout, stderr=stderr)
                try:
                    process.wait(timeout=min(40, remaining))
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                    raise ProofFailure("CHILD_TIMEOUT") from None
                output, errors = read_child_output(stdout, stderr)
            require(process.pid not in [value["processID"] for value in reports], "PROCESS_ID_REUSED")
            if negative:
                require(process.returncode == 1 and not output, "NEGATIVE_CONTROL_NOT_REJECTED")
                report = json.loads(errors)
            else:
                if process.returncode != 0:
                    try:
                        failure = json.loads(errors).get("code", "CHILD_FAILED")
                    except (ValueError, AttributeError):
                        failure = "CHILD_FAILED"
                    raise ProofFailure(failure if isinstance(failure, str) and re.fullmatch(r"[A-Z_]{1,80}", failure) else "CHILD_FAILED")
                require(not errors, "UNEXPECTED_CHILD_STDERR")
                report = json.loads(output)
            validate_report(report, arguments, phase, process.pid, dry=dry, negative=negative)
            report["negativeControl"] = negative
            reports.append(report)
            require(sum(value["responseBytes"] for value in reports) <= 2_097_152, "AGGREGATE_RESPONSE_LIMIT")
            return report

        child("dismiss-submit", ai_store, dry=True)
        require(not list(root.iterdir()), "DRY_RUN_TOUCHED_STORE")
        if arguments.execute:
            submitted = child("dismiss-submit", ai_store)
            ai, accepted_bytes = inspect_store(ai_store, device_id, arguments.web_base_url, 4, "accepted", "remoteAI")
            require(UUID(ai["id"]) == UUID(submitted["operationID"]) and ai["backendJobID"] == submitted["backendJobID"],
                    "AI_RECEIPT_IDENTITY_MISMATCH")

            # A fabricated completed cache entry cannot establish backend completion.
            # Terminal evidence is monotonic; this copied record must remain byte-exact
            # when the real HTTPS peer rejects its unknown handle.
            negative_store = root / "negative" / "operations.json"
            negative_store.parent.mkdir()
            fabricated = dict(ai, backendJobID=UNKNOWN_JOB, localState="terminal", backendStatus="completed")
            negative_store.write_text(json.dumps([fabricated]), encoding="utf-8")
            negative_bytes = negative_store.read_bytes()
            rejected = child("unknown-handle", negative_store, negative=True)
            require(rejected["backendJobID"] == UNKNOWN_JOB and UUID(rejected["operationID"]) == UUID(ai["id"])
                    and negative_store.read_bytes() == negative_bytes and ai_store.read_bytes() == accepted_bytes,
                    "NEGATIVE_CONTROL_MUTATED_OR_CHANGED_IDENTITY")

            restored = child("ai-restore", ai_store)
            terminal_ai, terminal_bytes = inspect_store(ai_store, device_id, arguments.web_base_url, 4, "terminal", "remoteAI")
            require(terminal_ai["id"] == ai["id"] and terminal_ai["backendJobID"] == ai["backendJobID"]
                    and terminal_ai["idempotencyKey"] == ai["idempotencyKey"]
                    and UUID(restored["operationID"]) == UUID(ai["id"])
                    and restored["backendJobID"] == ai["backendJobID"], "AI_RECOVERY_IDENTITY_MISMATCH")
            child("foreign", ai_store, device=foreign_id)
            terminal = child("terminal", ai_store)
            require(ai_store.read_bytes() == terminal_bytes and terminal["backendJobID"] == ai["backendJobID"]
                    and UUID(terminal["operationID"]) == UUID(ai["id"]), "TERMINAL_RESTART_MUTATED_STORE")

            accepted = child("concurrent-submit", capability_store)
            capability, _ = inspect_store(capability_store, device_id, arguments.web_base_url, 1, "accepted", "confirmation")
            require(capability.get("capabilityAction") == "tests.run" and accepted["backendJobID"] == capability["backendJobID"]
                    and UUID(accepted["operationID"]) == UUID(capability["id"])
                    and capability["backendJobID"] != ai["backendJobID"], "CAPABILITY_RECEIPT_IDENTITY_MISMATCH")
            recovered = child("capability-restore", capability_store)
            terminal_capability, _ = inspect_store(capability_store, device_id, arguments.web_base_url, 1, "terminal", "confirmation")
            require(terminal_capability["id"] == capability["id"] and terminal_capability["backendJobID"] == capability["backendJobID"]
                    and terminal_capability["idempotencyKey"] == capability["idempotencyKey"]
                    and recovered["backendJobID"] == capability["backendJobID"]
                    and UUID(recovered["operationID"]) == UUID(capability["id"]), "CAPABILITY_RECOVERY_IDENTITY_MISMATCH")
            require(sorted(str(file.relative_to(root)) for file in root.rglob("*") if file.is_file()) == [
                "ai/operations.json", "ai/operations.json.lock", "capability/operations.json", "capability/operations.json.lock",
                "negative/operations.json", "negative/operations.json.lock"], "UNEXPECTED_PERSISTED_FILES")
    require(not root.exists(), "LOCAL_STORE_CLEANUP_FAILED")
    counts = {key: sum(report[key] for report in reports)
              for key in ["requestsMade", "createRequests", "capabilityRequests", "resultRequests", "responseBytes"]}
    require(tuple(counts[key] for key in ["requestsMade", "createRequests", "capabilityRequests", "resultRequests"])
            == ((65, 1, 5, 7) if arguments.execute else (0, 0, 0, 0)), "FINAL_REQUEST_ACCOUNTING_INVALID")
    require(len(reports) == (8 if arguments.execute else 1), "FINAL_PROCESS_COUNT_INVALID")
    return {"phases": reports, "processCount": len(reports), **counts, "localStoreCleanupConfirmed": True,
            "negativeControl": "unknown_terminal_cache_claim_rejected_without_mutation_or_replay" if arguments.execute else "not_executed"}


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
              "scope": "shipping composition/file recovery over HTTPS against sealed synthetic Railway peer",
              "credentialStorage": "in-memory-fixture", "credentialAdapter": ADAPTER,
              "shippingAppLifecycle": False, "physicalDevice": False, "liveProvider": False,
              "database": False, "activeWorker": False, "controlPlaneOwnershipAsserted": False,
              "maxRequests": 65, "totalTimeoutSeconds": 120, "childTimeoutSeconds": 40}
    report["maxAggregateResponseBytes"] = 2_097_152
    try:
        require(os.name == "posix", "POSIX_REQUIRED")
        require(arguments.execute == arguments.allow_network, "NETWORK_OPT_IN_INCOMPLETE")
        binary = arguments.swift_binary.resolve(strict=True)
        require(binary.is_file() and os.access(binary, os.X_OK), "SWIFT_BINARY_UNAVAILABLE")
        repository = Path(__file__).resolve().parents[3]
        report.update(sourceCommit=arguments.commit_sha, prNumber=arguments.pr_number,
                      binarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest())
        report.update(execute(arguments, binary, repository))
        report["ok"] = True
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, ProofFailure) else "SHIPPING_PREVIEW_PROOF_FAILED"
    print(json.dumps(report, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
