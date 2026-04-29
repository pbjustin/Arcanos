#!/usr/bin/env python
"""Deterministic Python-side audit report for the Arcanos daemon package."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DAEMON_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = DAEMON_ROOT.parent
SOURCE_ROOTS = [DAEMON_ROOT / "arcanos", DAEMON_ROOT / "tests"]
EXCLUDED_DIRS = {"__pycache__", ".pytest_cache", ".venv", "dist", "build"}
ALLOWED_ENV_MODULES = {
    "arcanos/env.py",
    "arcanos/config.py",
}


def _relative(path: Path) -> str:
    return path.relative_to(DAEMON_ROOT).as_posix()


def _collect_python_files(root: Path) -> list[Path]:
    if not root.exists():
        return []

    found: list[Path] = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name):
        if entry.is_dir():
            if entry.name not in EXCLUDED_DIRS:
                found.extend(_collect_python_files(entry))
            continue
        if entry.suffix == ".py":
            found.append(entry)
    return sorted(found)


def _direct_env_findings(files: list[Path]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for file_path in files:
        relative_path = _relative(file_path)
        if relative_path in ALLOWED_ENV_MODULES:
            continue
        raw = file_path.read_text(encoding="utf-8")
        if "os.environ" in raw or "os.getenv" in raw:
            findings.append(
                {
                    "file": relative_path,
                    "finding": "Direct environment access outside Python config boundary.",
                    "severity": "warning",
                    "blocking": False,
                    "recommendedAction": "Move env reads behind arcanos.env or arcanos.config before tightening guardrails.",
                }
            )
    return findings


def _openai_findings(files: list[Path]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for file_path in files:
        relative_path = _relative(file_path)
        raw = file_path.read_text(encoding="utf-8")
        if "OpenAI(" in raw and relative_path != "arcanos/openai/unified_client.py":
            findings.append(
                {
                    "file": relative_path,
                    "finding": "Raw OpenAI client construction outside unified Python client boundary.",
                    "severity": "error",
                    "blocking": True,
                    "recommendedAction": "Route OpenAI construction through arcanos.openai.unified_client.",
                }
            )
    return findings


def _checks() -> list[dict[str, Any]]:
    adapter_path = DAEMON_ROOT / "arcanos" / "openai" / "openai_adapter.py"
    gpt_client_path = DAEMON_ROOT / "arcanos" / "gpt_client.py"
    adapter_raw = adapter_path.read_text(encoding="utf-8") if adapter_path.exists() else ""
    gpt_client_raw = gpt_client_path.read_text(encoding="utf-8") if gpt_client_path.exists() else ""

    return [
        {
            "id": "package_source_of_truth",
            "ok": (DAEMON_ROOT / "pyproject.toml").exists(),
            "evidence": "daemon-python/pyproject.toml exists",
        },
        {
            "id": "openai_store_config",
            "ok": "Config.OPENAI_STORE" in adapter_raw,
            "evidence": "OPENAI_STORE should be accessed through Config",
        },
        {
            "id": "gpt_client_zero_values",
            "ok": "temperature=temperature or Config.TEMPERATURE" not in gpt_client_raw
            and "max_tokens=max_tokens or Config.MAX_TOKENS" not in gpt_client_raw,
            "evidence": "GPTClient preserves explicit 0 and 0.0 generation values",
        },
        {
            "id": "responses_stream_normalization",
            "ok": "_normalize_responses_stream" in adapter_raw,
            "evidence": "Responses streaming events normalize before leaving the adapter",
        },
    ]


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    files = [file_path for root in SOURCE_ROOTS for file_path in _collect_python_files(root)]
    findings = sorted(
        [*_direct_env_findings(files), *_openai_findings(files)],
        key=lambda item: (item["file"], item["finding"]),
    )
    checks = _checks()
    blocking_findings = [finding for finding in findings if finding.get("blocking")]
    failed_checks = [check for check in checks if not check["ok"]]
    status = "error" if blocking_findings else "warning" if failed_checks or findings else "ok"

    return {
        "tool": "arcanos-python-continuous-audit",
        "mode": {
            "autoFixRequested": args.auto_fix,
            "autoFixApplied": False,
        },
        "summary": {
            "status": status,
            "pythonFiles": len(files),
            "findings": len(findings),
            "blockingFindings": len(blocking_findings),
            "failedChecks": len(failed_checks),
        },
        "checks": checks,
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auto-fix", action="store_true", help="Accepted for npm script compatibility; no mutation is performed.")
    args = parser.parse_args()
    report = build_report(args)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if report["summary"]["blockingFindings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
