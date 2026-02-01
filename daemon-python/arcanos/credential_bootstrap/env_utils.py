from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Mapping, Optional

from ..config import Config
from ..env_store import EnvFileError
from .types import CredentialBootstrapError


def prompt_for_value(
    prompt_text: str,
    input_provider: Callable[[str], str],
    default_value: Optional[str] = None,
    max_attempts: int = 3
) -> str:
    """
    Purpose: Prompt user for a non-empty value with optional default.
    Inputs/Outputs: prompt text, input provider, default, attempts; returns user value.
    Edge cases: Raises CredentialBootstrapError after max attempts.
    """
    for attempt in range(max_attempts):
        value = input_provider(prompt_text).strip()

        if value:
            # //audit assumption: non-empty input is valid; risk: whitespace only; invariant: trimmed non-empty; strategy: accept.
            return value

        if default_value:
            # //audit assumption: default is acceptable; risk: unintended default use; invariant: default exists; strategy: return default.
            return default_value

        # //audit assumption: retry is acceptable; risk: endless loop; invariant: bounded attempts; strategy: continue.
        if attempt < max_attempts - 1:
            continue

    raise CredentialBootstrapError("Maximum input attempts exceeded")


def apply_runtime_env_updates(updates: Mapping[str, str]) -> None:
    """
    Purpose: Apply env updates to os.environ and Config for runtime use.
    Inputs/Outputs: mapping of env keys to values; updates process environment.
    Edge cases: Only known Config attributes are updated.
    """
    for key, value in updates.items():
        # //audit assumption: keys are valid env names; risk: missing config mapping; invariant: os.environ set; strategy: set env var.
        os.environ[key] = value

        if hasattr(Config, key):
            # //audit assumption: Config uses env key names; risk: attribute missing; invariant: update only if present; strategy: setattr.
            setattr(Config, key, value)


def ensure_env_parent_dir(env_path: Path) -> None:
    """
    Purpose: Ensure parent directory for env file exists.
    Inputs/Outputs: env path; creates parent directory if needed.
    Edge cases: Raises EnvFileError on mkdir failures.
    """
    try:
        env_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # //audit assumption: directory creation can fail; risk: no env persistence; invariant: error surfaced; strategy: raise EnvFileError.
        raise EnvFileError(f"Failed to create env directory at {env_path.parent}: {exc}") from exc
