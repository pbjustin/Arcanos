"""
Offline backend/CLI contract validator for CI-safe execution.

Purpose:
- Validate daemon configuration and CLI/OpenAI adapter contracts without network calls.
- Enforce mock-only behavior for required CI checks.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List

from arcanos.config import Config, validate_required_config
from arcanos.env import set_env_value
from arcanos.gpt_client import GPTClient
from arcanos.openai.unified_client import reset_client


def _assert(condition: bool, message: str, failures: List[str]) -> None:
    """
    Purpose: Accumulate assertion failures without immediate exit.
    Inputs/Outputs: condition + message + failure list; appends message on failure.
    Edge cases: Supports batch validation so all failures are reported at once.
    """
    if not condition:
        failures.append(message)


def _run_mock_contract_checks(failures: List[str]) -> None:
    """
    Purpose: Validate GPT client mock-mode contracts offline.
    Inputs/Outputs: failure list to append violations.
    Edge cases: Uses explicit mock key to guarantee no outbound API calls.
    """
    # //audit assumption: required CI must avoid live OpenAI calls; risk: flaky/network-dependent CI; invariant: mock mode forced; strategy: explicit mock API key override.
    mock_client = GPTClient(api_key="mock-api-key")

    ask_text, ask_tokens, ask_cost = mock_client.ask("offline-check")
    _assert(isinstance(ask_text, str) and "Mock response" in ask_text, "ask() mock response mismatch", failures)
    _assert(ask_tokens == 0, "ask() tokens should be zero in mock mode", failures)
    _assert(ask_cost == 0.0, "ask() cost should be zero in mock mode", failures)

    stream_chunks = list(mock_client.ask_stream("offline-check-stream"))
    stream_text = "".join(chunk for chunk in stream_chunks if isinstance(chunk, str))
    _assert("Mock response" in stream_text, "ask_stream() mock stream text mismatch", failures)

    vision_text, vision_tokens, vision_cost = mock_client.ask_with_vision("offline-check-vision", "ZmFrZQ==")
    _assert("Mock vision response" in vision_text, "ask_with_vision() mock response mismatch", failures)
    _assert(vision_tokens == 0, "ask_with_vision() tokens should be zero in mock mode", failures)
    _assert(vision_cost == 0.0, "ask_with_vision() cost should be zero in mock mode", failures)

    transcript = mock_client.transcribe_audio(b"fake-audio", filename="offline.wav")
    _assert("Mock transcription" in transcript, "transcribe_audio() mock response mismatch", failures)


def _run_config_checks(failures: List[str]) -> None:
    """
    Purpose: Validate config fail-fast path and required directories offline.
    Inputs/Outputs: failure list to append violations.
    Edge cases: Injects mock API key to satisfy required config checks in CI.
    """
    set_env_value("OPENAI_API_KEY", "mock-api-key")
    Config.OPENAI_API_KEY = "mock-api-key"

    config_ok = validate_required_config(exit_on_error=False)
    _assert(config_ok is True, "validate_required_config(exit_on_error=False) returned False", failures)
    _assert(Config.LOG_DIR.exists(), "Config.LOG_DIR was not created", failures)
    _assert(Config.TELEMETRY_DIR.exists(), "Config.TELEMETRY_DIR was not created", failures)


def main() -> int:
    """
    Purpose: Run all offline validators and print machine-readable status.
    Inputs/Outputs: none; returns process exit code.
    Edge cases: Resets unified client singleton before checks for deterministic behavior.
    """
    failures: List[str] = []
    reset_client()

    _run_config_checks(failures)
    _run_mock_contract_checks(failures)

    if failures:
        print("[offline-validator] FAIL")
        for item in failures:
            print(f" - {item}")
        return 1

    print("[offline-validator] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
