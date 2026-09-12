#!/usr/bin/env python3
"""Map scoped Apple/Simulator/signing evidence to the no-Mac A-K matrix. Offline."""
import argparse
import json
from pathlib import Path
import re


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
        expected = {"apple-swift-package-tests", "project-inventory", "local-package-resolution"}
        expected |= {f"{step}-{config}" for step in ("build", "packaging") for config in ("Debug", "Release", "HardwareValidation")}
        successful = {check.get("name") for check in apple.get("checks", [])
                      if check.get("status") == "PASS" and check.get("exitCode") == 0}
        status = apple.get("evidenceLevels", {}).get("A", {}).get("status", "FAIL")
        if status == "PASS" and not (apple.get("sourceSha") == revision and apple.get("sourceUnchangedDuringCheck") is True
                                     and expected <= successful):
            status = "FAIL"
        if status not in {"PASS", "FAIL", "BLOCKED", "NOT RUN"}:
            status = "FAIL"
        for key in "AB":
            levels[key]["status"] = status
            levels[key]["dependency"] = "None" if status == "PASS" else "See scoped Apple build report; matching complete evidence required"
    if simulator:
        status = simulator.get("status", "FAIL")
        if status == "PASS" and not (simulator.get("revision") == revision and simulator.get("proof", {}).get("status") == "PASS"
                                     and levels["B"]["status"] == "PASS"):
            status = "FAIL"
        levels["C"]["status"] = status if status in {"PASS", "FAIL", "BLOCKED", "NOT RUN"} else "FAIL"
        levels["C"]["dependency"] = "None" if status == "PASS" else "See installed-app proof; matching build/runtime evidence required"
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    for field in ("apple", "simulator", "signing"):
        parser.add_argument("--" + field, type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    inputs = {}
    for field in ("apple", "simulator", "signing"):
        path = getattr(args, field)
        inputs[field] = json.loads(path.read_text()) if path and path.is_file() else None
    result = matrix(args.revision, **inputs)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
