#!/usr/bin/env python3
"""
Local-safe GPT-OSS training smoke launcher.

Defaults to dry-run JSON output. Execution requires --execute and still caps
training to smoke-sized limits through environment variables.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
SELECTOR_CANDIDATES = (
    SCRIPT_DIR / "vram-profile.mjs",
    SCRIPT_DIR / "profile-selector.py",
    SCRIPT_DIR / "profile_selector.py",
    SCRIPT_DIR / "select-profile.py",
    SCRIPT_DIR / "select_profile.py",
)
DEFAULT_SMOKE_STEPS = 25
DEFAULT_SMOKE_EPOCHS = 1
MAX_SAFE_STEPS = 25
MAX_SAFE_SAMPLES = 8


def main() -> int:
    options = parse_args(sys.argv[1:])
    try:
        profile = resolve_profile(options.profile)
    except Exception as error:
        print(
            json.dumps(
                {
                    "script": "scripts/gptoss/train-smoke.py",
                    "mode": "execute" if options.execute else "dry-run",
                    "executed": False,
                    "error": "profile_resolution_failed",
                    "message": str(error),
                },
                sort_keys=True,
            )
        )
        return 3
    max_steps = min(options.max_steps, MAX_SAFE_STEPS)
    max_samples = min(options.max_samples, MAX_SAFE_SAMPLES)
    training_config = build_training_config(profile, max_steps, options.num_train_epochs)
    train_command = build_train_command(options.command or profile_command(profile))

    plan = {
        "script": "scripts/gptoss/train-smoke.py",
        "mode": "execute" if options.execute else "dry-run",
        "profile": profile,
        "limits": {
            "maxSteps": max_steps,
            "maxSamples": max_samples,
        },
        "trainingConfig": training_config,
        "command": train_command,
        "safety": {
            "longTrainingAllowed": False,
            "requiresExplicitExecute": True,
        },
    }

    if profile.get("profile") == "defer" or profile.get("name") == "defer":
        print(json.dumps({**plan, "executed": False, "error": "profile_defer"}, sort_keys=True))
        return 3

    if not options.execute:
        print(json.dumps({**plan, "executed": False}, sort_keys=True))
        return 0

    if not train_command:
        print(
            json.dumps(
                {
                    **plan,
                    "executed": False,
                    "error": "Missing --command or ARCANOS_GPTOSS_TRAIN_COMMAND for execute mode.",
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2

    env = os.environ.copy()
    env.update(
        {
            "ARCANOS_GPTOSS_PROFILE": profile["name"],
            "ARCANOS_GPTOSS_SMOKE": "1",
            "ARCANOS_GPTOSS_DRY_RUN": "0",
            "ARCANOS_GPTOSS_MAX_SEQ_LENGTH": str(training_config["max_seq_length"]),
            "ARCANOS_GPTOSS_MAX_STEPS": str(max_steps),
            "ARCANOS_GPTOSS_MAX_SAMPLES": str(max_samples),
        }
    )

    completed = subprocess.run(train_command, cwd=REPO_ROOT, env=env, check=False)
    print(
        json.dumps(
            {
                **plan,
                "executed": True,
                "returnCode": completed.returncode,
            },
            sort_keys=True,
        )
    )
    return completed.returncode


def parse_args(raw_args: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a bounded GPT-OSS training smoke launch.")
    parser.add_argument("--profile", default=os.environ.get("ARCANOS_GPTOSS_PROFILE", "auto"))
    parser.add_argument("--max-steps", type=positive_int, default=DEFAULT_SMOKE_STEPS)
    parser.add_argument("--num-train-epochs", type=positive_int, default=DEFAULT_SMOKE_EPOCHS)
    parser.add_argument("--max-samples", type=positive_int, default=1)
    parser.add_argument("--command", default=os.environ.get("ARCANOS_GPTOSS_TRAIN_COMMAND", ""))
    parser.add_argument("--execute", action="store_true")
    return parser.parse_args(raw_args)


def resolve_profile(requested_profile: str) -> dict[str, Any]:
    selector = os.environ.get("ARCANOS_GPTOSS_PROFILE_SELECTOR")
    selector_path = Path(selector).resolve() if selector else None

    if selector_path is None and requested_profile != "auto":
        return {
            "name": requested_profile,
            "source": "explicit",
            "selector": None,
        }

    selector_path = selector_path or next_existing_selector()

    if selector_path:
        result = subprocess.run(
            selector_command(selector_path, requested_profile),
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            output = result.stdout.strip() or result.stderr.strip()
            raise RuntimeError(output or "GPT-OSS profile selector failed.")
        return normalize_profile(json.loads(result.stdout), selector_path)

    return {
        "name": requested_profile,
        "source": "fallback",
        "selector": None,
    }


def next_existing_selector() -> Path | None:
    for candidate in SELECTOR_CANDIDATES:
        if candidate.exists():
            return candidate
    return None


def selector_command(selector_path: Path, requested_profile: str) -> list[str]:
    if selector_path.suffix == ".mjs":
        return ["node", str(selector_path), "--json"]

    return [
        sys.executable,
        str(selector_path),
        "--profile",
        requested_profile,
        "--json",
    ]


def normalize_profile(raw_profile: Any, selector_path: Path) -> dict[str, Any]:
    if not isinstance(raw_profile, dict):
        raise ValueError("GPT-OSS profile selector must return a JSON object.")

    name = raw_profile.get("name") or raw_profile.get("profile") or raw_profile.get("id")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("GPT-OSS profile selector output must include name, profile, or id.")

    return {
        **raw_profile,
        "name": name.strip(),
        "source": raw_profile.get("source", "selector"),
        "selector": selector_path.relative_to(REPO_ROOT).as_posix(),
    }


def build_train_command(raw_command: str) -> list[str]:
    if not raw_command.strip():
        return []
    return shlex.split(raw_command)


def build_training_config(profile: dict[str, Any], max_steps: int, num_train_epochs: int) -> dict[str, Any]:
    profile_name = profile.get("profile") or profile.get("name")
    max_seq_length = int(profile.get("maxSeqLength") or 512)
    gradient_accumulation_steps = 8 if profile_name == "shared" else 4

    return {
        "model_name": "openai/gpt-oss-20b",
        "max_seq_length": max_seq_length,
        "load_in_4bit": True,
        "bf16_full_finetune": False,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": gradient_accumulation_steps,
        "use_gradient_checkpointing": "unsloth",
        "max_steps": max_steps,
        "num_train_epochs": num_train_epochs,
    }


def profile_command(profile: dict[str, Any]) -> str:
    command = (
        profile.get("command")
        or profile.get("trainCommand")
        or profile.get("trainingCommand")
        or ""
    )

    if isinstance(command, list) and all(isinstance(item, str) for item in command):
        return shlex.join(command)

    if isinstance(command, str):
        return command

    return ""


def positive_int(raw_value: str) -> int:
    value = int(raw_value)
    if value < 1:
        raise argparse.ArgumentTypeError("value must be a positive integer")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
