"""CLI entrypoint for the scaffolded Arcanos Protocol Python runtime."""

from __future__ import annotations

import json
import sys
from typing import Iterable

from .handlers import ProtocolRuntimeHandler
from .schema_loader import load_protocol_contract
from .state_store import InMemoryProtocolStateStore


def main(argv: Iterable[str] | None = None) -> int:
    """Run the protocol runtime in one-shot or stdio loop mode."""

    argument_list = list(argv if argv is not None else sys.argv[1:])
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    if "--stdio" in argument_list:
        return _serve_stdio(handler)

    raw_request = sys.stdin.read()
    if not raw_request.strip():
        response = _build_cli_error("missing_request", "Expected a JSON request on stdin.")
        sys.stdout.write(json.dumps(response, sort_keys=True))
        return 1

    response = _handle_json_request(handler, raw_request)
    sys.stdout.write(json.dumps(response, sort_keys=True))
    return 0 if response.get("ok") else 1


def _serve_stdio(handler: ProtocolRuntimeHandler) -> int:
    for line in sys.stdin:
        stripped_line = line.strip()
        if not stripped_line:
            continue
        response = _handle_json_request(handler, stripped_line)
        sys.stdout.write(json.dumps(response, sort_keys=True))
        sys.stdout.write("\n")
        sys.stdout.flush()
    return 0


def _handle_json_request(handler: ProtocolRuntimeHandler, raw_request: str) -> dict[str, object]:
    try:
        request_payload = json.loads(raw_request)
    except json.JSONDecodeError as error:
        return _build_cli_error("invalid_json", f"Request body is not valid JSON: {error.msg}.")

    if not isinstance(request_payload, dict):
        return _build_cli_error("invalid_request", "Request body must decode to a JSON object.")

    return handler.handle_request(request_payload)


def _build_cli_error(code: str, message: str) -> dict[str, object]:
    return {
        "protocol": "arcanos-v1",
        "requestId": "python-daemon-error",
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "retryable": False,
        },
        "meta": {
            "version": "0.1.0",
            "executedBy": "python-daemon",
            "timingMs": 0,
        },
    }


if __name__ == "__main__":
    raise SystemExit(main())
