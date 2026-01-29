"""
Simple script to talk to the ARCANOS production backend in natural language.

It:
- Loads config from .env
- Uses BackendApiClient to call the backend's /api/ask-style endpoint
- Sends a couple of natural-language prompts and prints the responses
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
import requests

# Ensure we load the same .env the CLI uses
BASE_DIR = Path(__file__).parent
env_path = BASE_DIR / ".env"
if env_path.exists():
    load_dotenv(env_path)

# Make sure we can import the arcanos package from this folder
sys.path.insert(0, str(BASE_DIR))

from arcanos.config import Config  # type: ignore
from arcanos.backend_client import (  # type: ignore
    BackendApiClient,
    BackendRequestError,
)


def _get_debug_log_path() -> Path:
    """Configurable path: DEBUG_LOG_PATH env or Config.LOG_DIR / debug.log (portable, no PII)."""
    if os.environ.get("DEBUG_LOG_PATH"):
        return Path(os.environ["DEBUG_LOG_PATH"])
    return Config.LOG_DIR / "debug.log"


def _debug_log(hypothesis_id: str, location: str, message: str, data: dict) -> None:
    """Write a single NDJSON debug line; do not include user prompt or PII in data."""
    payload = {
        "sessionId": "debug-session",
        "runId": "pre-fix",
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": int(time.time() * 1000),
    }
    path = _get_debug_log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload) + "\n")
    except OSError as e:
        import sys
        sys.stderr.write(f"Debug log write failed: {e}\n")


def make_client() -> BackendApiClient:
    if not Config.BACKEND_URL:
        raise RuntimeError("BACKEND_URL is not configured.")
    return BackendApiClient(
        base_url=Config.BACKEND_URL,
        token_provider=lambda: Config.BACKEND_TOKEN,
        timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT,
    )


def ask_backend(client: BackendApiClient, message: str, domain: str | None = None) -> str:
    """
    Send a natural-language message to the backend and return the response text.
    Prefers the /api/ask-with-domain route when a domain is provided, otherwise
    falls back to the chat-completion-style route.
    """
    print("\n" + "=" * 60)
    print("USER -> BACKEND")
    print("-" * 60)
    print(message)

    # region agent log (no user message content; metadata only)
    _debug_log(
        hypothesis_id="H1",
        location="talk_to_backend.py:ask_backend:before_request",
        message="About to call request_ask_with_domain",
        data={
            "has_domain": bool(domain),
            "message_length": len(message),
        },
    )
    # endregion

    # Build metadata similar to the CLI
    metadata = {
        "source": "daemon-script",
        "client": "arcanos-daemon",
        "instanceId": "debug-script",
    }

    try:
        # Prefer the simpler ask-style API that takes a single message,
        # since this is exactly what we want for natural-language probing.
        response = client.request_ask_with_domain(
            message=message,
            domain=domain,
            metadata=metadata,
        )

        if not response.ok or not response.value:
            print("\n[FAIL] Backend request was not ok.")
            if response.error:
                print(f"  kind: {response.error.kind}")
                print(f"  message: {response.error.message}")
                if response.error.status_code is not None:
                    print(f"  status: {response.error.status_code}")

            # region agent log
            _debug_log(
                hypothesis_id="H2",
                location="talk_to_backend.py:ask_backend:response_error",
                message="Backend response not ok",
                data={
                    "ok": response.ok,
                    "has_value": bool(response.value),
                    "error_kind": getattr(response.error, "kind", None),
                    "error_status": getattr(response.error, "status_code", None),
                },
            )
            # endregion
            return ""

        result = response.value
        text = getattr(result, "response_text", "")

        print("\nBACKEND -> USER")
        print("-" * 60)
        # Handle Unicode safely for Windows console
        try:
            import sys
            if sys.stdout.encoding and 'utf' not in sys.stdout.encoding.lower():
                # Try to encode as ASCII-safe representation
                safe_text = text.encode('ascii', 'replace').decode('ascii')
                print(safe_text)
            else:
                print(text)
        except Exception:
            # Fallback: print as repr to avoid encoding issues
            print(repr(text[:500]) if text else "(empty response)")

        # region agent log (no response content; metadata only)
        _debug_log(
            hypothesis_id="H3",
            location="talk_to_backend.py:ask_backend:response_ok",
            message="Backend response parsed successfully",
            data={
                "response_length": len(text or ""),
                "tokens_used": getattr(result, "tokens_used", None),
                "model": getattr(result, "model", None),
            },
        )
        # endregion

        return text
    except BackendRequestError as exc:
        print("\n[FAIL] BackendRequestError while talking to backend.")
        print(f"  kind: {exc.kind}")
        print(f"  message: {exc.message}")
        if exc.status_code is not None:
            print(f"  status: {exc.status_code}")

        # region agent log
        _debug_log(
            hypothesis_id="H4",
            location="talk_to_backend.py:ask_backend:BackendRequestError",
            message="BackendRequestError raised during ask_backend",
            data={
                "kind": exc.kind,
                "status_code": exc.status_code,
            },
        )
        # endregion
        return ""
    except Exception as exc:  # pragma: no cover - debug helper
        print("\n[FAIL] Unexpected error while talking to backend.")
        print(f"  type: {type(exc).__name__}")
        print(f"  message: {exc}")

        # region agent log
        _debug_log(
            hypothesis_id="H5",
            location="talk_to_backend.py:ask_backend:UnexpectedError",
            message="Unexpected exception in ask_backend",
            data={"exception_type": type(exc).__name__},
        )
        # endregion
        return ""


def raw_ask_backend(message: str) -> None:
    """
    Fallback: call the backend /api/ask endpoint directly with requests and
    print the raw JSON/text response so we can see exactly how it replies.
    """
    if not Config.BACKEND_URL:
        print("\n[RAW] BACKEND_URL not configured; cannot send raw request.")
        return
    if not Config.BACKEND_TOKEN:
        print("\n[RAW] BACKEND_TOKEN not set; cannot authenticate raw request.")
        return

    url = f"{Config.BACKEND_URL}/api/ask"
    headers = {
        "Authorization": f"Bearer {Config.BACKEND_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "message": message,
        "metadata": {
            "source": "daemon-script-raw",
            "client": "arcanos-daemon",
            "instanceId": "debug-script",
        },
    }

    print("\n[RAW] Sending direct POST to /api/ask ...")

    # region agent log (no user message content)
    _debug_log(
        hypothesis_id="H6",
        location="talk_to_backend.py:raw_ask_backend:before_post",
        message="About to send raw POST to /api/ask",
        data={
            "message_length": len(payload["message"]),
        },
    )
    # endregion
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=Config.BACKEND_REQUEST_TIMEOUT)
        print(f"[RAW] HTTP {resp.status_code}")
        print("[RAW] Response body:")
        
        # Handle Unicode safely for Windows console
        try:
            import sys
            if sys.stdout.encoding and 'utf' not in sys.stdout.encoding.lower():
                # Try to encode as ASCII-safe representation
                safe_text = resp.text.encode('ascii', 'replace').decode('ascii')
                print(safe_text)
            else:
                print(resp.text)
        except Exception:
            # Fallback: print as repr to avoid encoding issues
            print(repr(resp.text[:500]))
        
        # Parse and log the actual JSON structure
        try:
            response_json = resp.json()
            print(f"\n[RAW] Parsed JSON keys: {list(response_json.keys()) if isinstance(response_json, dict) else 'not a dict'}")
            
            # region agent log (no response body content; metadata only)
            _debug_log(
                hypothesis_id="H7",
                location="talk_to_backend.py:raw_ask_backend:after_post",
                message="Raw POST completed",
                data={
                    "status_code": resp.status_code,
                    "response_keys": list(response_json.keys()) if isinstance(response_json, dict) else None,
                    "has_response_field": "response" in response_json if isinstance(response_json, dict) else False,
                    "has_text_field": "text" in response_json if isinstance(response_json, dict) else False,
                    "has_message_field": "message" in response_json if isinstance(response_json, dict) else False,
                    "body_length": len(resp.text),
                },
            )
            # endregion
        except Exception as json_err:
            print(f"[RAW] Could not parse JSON: {json_err}")
            # region agent log (no body content)
            _debug_log(
                hypothesis_id="H7",
                location="talk_to_backend.py:raw_ask_backend:after_post",
                message="Raw POST completed but JSON parse failed",
                data={
                    "status_code": resp.status_code,
                    "parse_error": str(json_err),
                    "body_length": len(resp.text),
                },
            )
            # endregion
    except Exception as exc:  # pragma: no cover - debug helper
        print(f"[RAW] Error while calling backend directly: {exc}")

        # region agent log
        _debug_log(
            hypothesis_id="H8",
            location="talk_to_backend.py:raw_ask_backend:Exception",
            message="Exception during raw POST",
            data={"exception_type": type(exc).__name__},
        )
        # endregion


def main() -> int:
    print("=" * 60)
    print("ARCANOS BACKEND NATURAL-LANGUAGE TEST")
    print("=" * 60)
    print(f"Backend URL: {Config.BACKEND_URL or 'NOT CONFIGURED'}")
    print(f"Backend token: {'SET' if Config.BACKEND_TOKEN else 'NOT SET'}")

    try:
        client = make_client()
    except Exception as exc:
        print(f"\n[FAIL] Could not create backend client: {exc}")
        return 1

    # First prompt: simple greeting / connectivity check
    first_prompt = (
        "Hello! This is an automated test from my local ARCANOS CLI agent. "
        "Please respond briefly to confirm you're online and describe in one "
        "sentence what you can help me with."
    )
    first_reply = ask_backend(client, first_prompt, domain=None)

    # If structured client parsing failed or gave an empty reply, fall back to
    # a direct raw call so we can still see how the backend responds.
    if not first_reply:
        raw_ask_backend(first_prompt)

    # Second prompt: follow-up based on the first reply
    if first_reply:
        followup_prompt = (
            "Thanks for confirming. In one or two short sentences, explain "
            "how you expect a local automation agent to talk to you and what "
            "kind of instructions are most useful."
        )
        ask_backend(client, followup_prompt, domain=None)

    print("\n" + "=" * 60)
    print("END OF BACKEND TEST")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

