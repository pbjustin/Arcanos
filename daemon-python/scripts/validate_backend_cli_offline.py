"""
Offline backend/CLI contract validator for CI-safe execution.

Purpose:
- Validate daemon configuration and CLI/OpenAI adapter contracts without network calls.
- Enforce mock-only behavior for required CI checks.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

from arcanos.config import Config, validate_required_config
from arcanos.contract_versions import BACKEND_CLI_CONTRACT_VERSION
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


def _run_backend_cli_manifest_checks(failures: List[str]) -> None:
    """
    Purpose: Enforce shared backend/CLI contract manifest integrity across Python and TypeScript surfaces.
    Inputs/Outputs: failure list to append violations.
    Edge cases: Reports malformed/missing manifests without raising so CI can show all failures together.
    """
    repository_root = Path(__file__).resolve().parents[2]
    manifest_path = repository_root / "contracts" / "backend_cli_contract.v1.json"

    # //audit assumption: backend/CLI contract must be centralized in one manifest file; risk: drift between runtime stacks; invariant: manifest exists at canonical path; handling strategy: record explicit failure when missing.
    _assert(manifest_path.exists(), f"Missing contract manifest: {manifest_path}", failures)
    if not manifest_path.exists():
        return

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        failures.append(f"Invalid contract manifest JSON: {exc}")
        return

    manifest_version = manifest.get("contractVersion")
    # //audit assumption: daemon runtime and manifest version must match exactly; risk: incompatible request/response payloads; invariant: version lockstep; handling strategy: fail validation on mismatch.
    _assert(
        manifest_version == BACKEND_CLI_CONTRACT_VERSION,
        (
            "Contract version mismatch: "
            f"daemon={BACKEND_CLI_CONTRACT_VERSION} manifest={manifest_version}"
        ),
        failures,
    )

    endpoints = manifest.get("endpoints")
    # //audit assumption: endpoint definitions are mandatory for compatibility checks; risk: partial or empty contracts; invariant: non-empty endpoint map; handling strategy: fail fast when absent.
    _assert(isinstance(endpoints, dict) and len(endpoints) > 0, "Manifest endpoints must be a non-empty object", failures)
    if not isinstance(endpoints, dict):
        return

    expected_endpoints = {"/ask", "/api/vision", "/api/transcribe", "/api/update"}
    missing_endpoints = sorted(expected_endpoints.difference(endpoints.keys()))
    _assert(not missing_endpoints, f"Manifest missing endpoints: {', '.join(missing_endpoints)}", failures)

    backend_client_init_path = repository_root / "daemon-python" / "arcanos" / "backend_client" / "__init__.py"
    try:
        backend_client_source = backend_client_init_path.read_text(encoding="utf-8")
    except OSError as exc:
        failures.append(f"Unable to read backend client source: {exc}")
        return

    for endpoint_path, endpoint_definition in endpoints.items():
        if not isinstance(endpoint_definition, dict):
            failures.append(f"Endpoint definition must be an object: {endpoint_path}")
            continue

        ts_route_file = endpoint_definition.get("tsRouteFile")
        # //audit assumption: each endpoint must map to a TypeScript route source file; risk: untraceable contract ownership; invariant: declared route file exists; handling strategy: fail validation for missing files.
        if not isinstance(ts_route_file, str):
            failures.append(f"Endpoint missing tsRouteFile: {endpoint_path}")
        else:
            route_path = repository_root / ts_route_file
            _assert(route_path.exists(), f"Declared route file not found for {endpoint_path}: {ts_route_file}", failures)

        python_client_methods = endpoint_definition.get("pythonClientMethods")
        if not isinstance(python_client_methods, list):
            failures.append(f"Endpoint pythonClientMethods must be a list: {endpoint_path}")
            continue

        for method_name in python_client_methods:
            if not isinstance(method_name, str):
                failures.append(f"Endpoint pythonClientMethods contains non-string for {endpoint_path}")
                continue
            # //audit assumption: listed client methods must exist on BackendApiClient; risk: runtime AttributeError when invoking endpoint wrappers; invariant: each method is implemented; handling strategy: static source presence check.
            _assert(
                f"def {method_name}(" in backend_client_source,
                f"BackendApiClient missing method from manifest: {method_name}",
                failures,
            )


def _run_cli_surface_checks(failures: List[str]) -> None:
    """
    Purpose: Enforce canonical daemon CLI import boundaries to reduce multi-zone CLI drift.
    Inputs/Outputs: failure list to append violations.
    Edge cases: Skips unreadable files while recording explicit failure messages.
    """
    repository_root = Path(__file__).resolve().parents[2]
    cli_package_root = repository_root / "daemon-python" / "arcanos" / "cli"

    required_cli_modules = [
        cli_package_root / "audit.py",
        cli_package_root / "execute.py",
        cli_package_root / "governance.py",
        cli_package_root / "idempotency.py",
        cli_package_root / "startup.py",
        cli_package_root / "trust_state.py",
    ]
    for required_module in required_cli_modules:
        _assert(required_module.exists(), f"Missing canonical CLI governance module: {required_module}", failures)

    for source_path in cli_package_root.rglob("*.py"):
        try:
            source_text = source_path.read_text(encoding="utf-8")
        except OSError as exc:
            failures.append(f"Unable to read CLI module {source_path}: {exc}")
            continue

        # //audit assumption: daemon CLI must not depend on root-level `cli/` package after consolidation; risk: fragmented runtime behavior and import failures; invariant: no `from cli.` or `import cli.` in canonical package; handling strategy: fail validation on legacy imports.
        if "from cli." in source_text or "import cli." in source_text:
            failures.append(f"Legacy root-cli import detected in canonical CLI package: {source_path}")


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
    _run_backend_cli_manifest_checks(failures)
    _run_cli_surface_checks(failures)

    if failures:
        print("[offline-validator] FAIL")
        for item in failures:
            print(f" - {item}")
        return 1

    print("[offline-validator] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
