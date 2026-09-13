#!/usr/bin/env python3
"""Map scoped Apple/Simulator/signing evidence to the no-Mac A-K matrix. Offline."""
import argparse
import importlib.util
import json
from pathlib import Path
import re


SIMULATOR_SCENARIOS = ("acceptedReceipt", "lostReceipt", "cancelledApproval", "localOnly")


def simulator_status(revision, reports, build_status):
    """A single lifecycle or a summary flag cannot establish the complete suite."""
    if not isinstance(reports, dict) or set(reports) != set(SIMULATOR_SCENARIOS):
        return "FAIL"
    spec = importlib.util.spec_from_file_location("phase3c_simulator_report", Path(__file__).with_name("run-phase3c-simulator.py"))
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    statuses = []
    for scenario in SIMULATOR_SCENARIOS:
        report = reports[scenario]
        if not isinstance(report, dict):
            return "FAIL"
        status = report.get("status", "FAIL")
        if status not in {"PASS", "FAIL", "BLOCKED", "NOT RUN"}:
            return "FAIL"
        if status == "PASS":
            try:
                validator.validate_report(report, revision, scenario)
            except (validator.ValidationFailure, ValueError, TypeError, KeyError, IndexError, AttributeError):
                return "FAIL"
        statuses.append(status)
    if "FAIL" in statuses:
        return "FAIL"
    if "BLOCKED" in statuses:
        return "BLOCKED"
    if "NOT RUN" in statuses:
        return "NOT RUN"
    return "PASS" if build_status == "PASS" else "FAIL"


def matrix(revision, apple=None, simulator=None, signing=None):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Full source SHA required")
    levels = {
        "A": {"status": "BLOCKED", "scope": "Cloud Xcode/iOS compilation", "dependency": "Apple build evidence required"},
        "B": {"status": "BLOCKED", "scope": "Cloud Simulator build", "dependency": "Apple build evidence required"},
        "C": {"status": "BLOCKED", "scope": "Cloud Simulator runtime", "dependency": "Installed-app runtime proof required"},
        "D": {"status": "NOT RUN", "scope": "Signed archive"},
        "E": {"status": "NOT RUN", "scope": "TestFlight upload"},
        "K": {"status": "NOT RUN", "scope": "Live ARCANOS services", "dependency": "Separate authorization required"},
    }
    for key, scope in zip("FGHIJ", ("Physical Keychain", "Physical Foundation Models", "Physical App Intent",
                                    "Physical Vocal Shortcut", "Physical fixture recovery")):
        levels[key] = {"status": "BLOCKED", "scope": scope, "dependency": "Operator observations on an authorized installed iPhone required"}

    if apple:
        expected = {"revision", "working-tree", "apple-swift-package-tests", "project-inventory", "local-package-resolution"}
        expected |= {f"{step}-{config}" for step in ("build", "packaging") for config in ("Debug", "Release", "HardwareValidation")}
        successful = {check.get("name") for check in apple.get("checks", [])
                      if check.get("status") == "PASS" and check.get("exitCode") == 0}
        status = apple.get("evidenceLevels", {}).get("A", {}).get("status", "FAIL")
        if status == "PASS" and not (apple.get("sourceSha") == revision and apple.get("uncommittedChanges") == []
                                     and apple.get("sourceUnchangedDuringCheck") is True
                                     and expected <= successful):
            status = "FAIL"
        if status not in {"PASS", "FAIL", "BLOCKED", "NOT RUN"}:
            status = "FAIL"
        for key in "AB":
            levels[key]["status"] = status
            levels[key]["dependency"] = "None" if status == "PASS" else "See scoped Apple build report; matching complete evidence required"
    if simulator:
        status = simulator_status(revision, simulator, levels["B"]["status"])
        levels["C"]["status"] = status
        levels["C"]["dependency"] = "None" if status == "PASS" else "Four complete installed-app scenario reports and matching build evidence required"
    if signing:
        for key, field in (("D", "signing"), ("E", "testFlightUpload")):
            status = signing.get(field, {}).get("status", "NOT RUN")
            if status == "PASS" and signing.get("sourceSha") != revision:
                status = "FAIL"
            levels[key]["status"] = status if status in {"PASS", "FAIL", "BLOCKED", "NOT RUN"} else "FAIL"
        if levels["E"]["status"] == "PASS" and levels["D"]["status"] != "PASS":
            levels["E"]["status"] = "FAIL"
    return {"schema": "arcanos-phase3c-cloud-matrix/v1", "revision": revision,
            "evidenceLevels": dict(sorted(levels.items())),
            "scope": "Prepared pipelines and Simulator execution never establish physical-device or live-service success"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    for field in ("apple", "simulator", "signing"):
        parser.add_argument("--" + field, type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--require-simulator-success", action="store_true",
                        help="Exit unsuccessfully unless exact Apple builds and all four Simulator scenarios pass")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        parser.error("Full source SHA required")
    inputs = {}
    try:
        for field in ("apple", "simulator", "signing"):
            path = getattr(args, field)
            if field == "simulator" and path and path.is_dir():
                inputs[field] = {scenario: json.loads(report.read_text(encoding="utf-8")) if report.is_file() else None
                                 for scenario in SIMULATOR_SCENARIOS
                                 for report in [path / scenario / "report.json"]}
            else:
                inputs[field] = json.loads(path.read_text(encoding="utf-8")) if path and path.is_file() else None
        result = matrix(args.revision, **inputs)
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError):
        result = matrix(args.revision)
        result["failureCategory"] = "malformed-evidence"
        for key in "ABC":
            result["evidenceLevels"][key].update(status="FAIL", dependency="Supplied evidence could not be validated")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(result, indent=2) + "\n")
    return int(args.require_simulator_success and any(result["evidenceLevels"][key]["status"] != "PASS" for key in "ABC"))


if __name__ == "__main__":
    raise SystemExit(main())
