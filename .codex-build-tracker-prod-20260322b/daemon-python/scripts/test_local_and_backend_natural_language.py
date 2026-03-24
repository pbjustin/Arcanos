"""
Natural-language test for both local and backend CLI paths.
Logs errors, suspicious behavior, and improvement notes to the shared debug log (NDJSON).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# Load .env before importing arcanos (config reads env on import)
BASE_DIR = Path(__file__).resolve().parent
env_path = BASE_DIR / ".env"
if env_path.exists():
    from dotenv import load_dotenv
    load_dotenv(env_path)


def _resolve_debug_log_path() -> Path:
    """Use DEBUG_LOG_PATH env if set, else Config.LOG_DIR / debug.log (portable, no PII in path)."""
    if os.environ.get("DEBUG_LOG_PATH"):
        return Path(os.environ["DEBUG_LOG_PATH"])
    from arcanos.config import Config
    return Config.LOG_DIR / "debug.log"


def _log(
    kind: str,
    location: str,
    message: str,
    data: dict | None = None,
    hypothesis_id: str = "NL",
    _log_path: Path | None = None,
) -> None:
    """Append NDJSON line; data must not contain user prompts or PII. Uses configurable path."""
    payload = {
        "sessionId": "debug-session",
        "runId": "natural-language-test",
        "hypothesisId": hypothesis_id,
        "kind": kind,
        "location": location,
        "message": message,
        "data": data or {},
        "timestamp": int(time.time() * 1000),
    }
    path = _log_path or _resolve_debug_log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload) + "\n")
    except OSError as e:
        import sys
        sys.stderr.write(f"Debug log write failed: {e}\n")


def main() -> int:
    _debug_log_path = _resolve_debug_log_path()
    _log("info", "test_local_and_backend_natural_language:main", "Natural-language test start", {"cwd": str(BASE_DIR)}, _log_path=_debug_log_path)
    # Log proxy env (presence only; do not log values)
    _proxy_http = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    _proxy_https = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if _proxy_http or _proxy_https:
        _log(
            "improvement",
            "main:env",
            "HTTP/HTTPS proxy env is set; requests may fail if proxy is unreachable.",
            {"HTTP_PROXY_set": bool(_proxy_http), "HTTPS_PROXY_set": bool(_proxy_https), "suggestion": "Unset HTTP_PROXY/HTTPS_PROXY for direct connectivity if not using a proxy."},
            "IMPROVE",
            _log_path=_debug_log_path,
        )

    try:
        from arcanos.config import Config
    except Exception as e:
        _log("error", "import:config", "Failed to import config", {"exception": str(e)}, "ERR", _log_path=_debug_log_path)
        print(f"[FAIL] Config import: {e}")
        return 1

    # Log config state (no secrets)
    _log(
        "info",
        "main:config",
        "Config loaded",
        {
            "BACKEND_URL_set": bool(Config.BACKEND_URL),
            "BACKEND_TOKEN_set": bool(Config.BACKEND_TOKEN),
            "OPENAI_API_KEY_set": bool(Config.OPENAI_API_KEY and Config.OPENAI_API_KEY != "sk-dummy-api-key"),
            "BACKEND_ROUTING_MODE": Config.BACKEND_ROUTING_MODE,
        },
        _log_path=_debug_log_path,
    )
    if not Config.OPENAI_API_KEY or Config.OPENAI_API_KEY == "sk-dummy-api-key":
        _log(
            "improvement",
            "main:config",
            "OPENAI_API_KEY not set or dummy; local path may fail.",
            {"suggestion": "Set OPENAI_API_KEY in .env for local GPT tests."},
            "IMPROVE",
            _log_path=_debug_log_path,
        )

    try:
        from arcanos.cli import ArcanosCLI
    except Exception as e:
        _log("error", "import:cli", "Failed to import ArcanosCLI", {"exception": str(e)}, "ERR", _log_path=_debug_log_path)
        print(f"[FAIL] CLI import: {e}")
        return 1

    try:
        cli = ArcanosCLI()
    except Exception as e:
        _log("error", "main:cli_init", "Failed to create ArcanosCLI", {"exception": str(e)}, "ERR", _log_path=_debug_log_path)
        print(f"[FAIL] CLI init: {e}")
        return 1

    prompt = "Hello! Reply in one short sentence: what can you help me with?"
    # ---- Local ---- (do not log user prompt content; log only non-PII metadata)
    _log("info", "main:local:before", "Calling handle_ask (route=local)", {"message_length": len(prompt)}, _log_path=_debug_log_path)
    try:
        result_local = cli.handle_ask(prompt, route_override="local", return_result=True)
        if result_local is None:
            _log(
                "suspicious",
                "main:local:result",
                "Local handle_ask returned None (no response or rate limit).",
                {"message_length": len(prompt)},
                "SUSP",
                _log_path=_debug_log_path,
            )
            print("[WARN] Local: no response (None).")
        else:
            text = getattr(result_local, "response_text", "") or ""
            _log(
                "info",
                "main:local:result",
                "Local response ok",
                {
                    "source": getattr(result_local, "source", None),
                    "model": getattr(result_local, "model", None),
                    "tokens_used": getattr(result_local, "tokens_used", None),
                    "response_length": len(text or ""),
                },
                _log_path=_debug_log_path,
            )
            print(f"[LOCAL] {text[:200]}{'...' if len(text) > 200 else ''}")
    except Exception as e:
        _log(
            "error",
            "main:local:exception",
            "Local handle_ask raised",
            {"exception_type": type(e).__name__, "exception": str(e)[:200]},
            "ERR",
            _log_path=_debug_log_path,
        )
        if "proxy" in str(e).lower():
            _log("improvement", "main:local:exception", "Proxy may be blocking OpenAI; unset HTTP_PROXY/HTTPS_PROXY to try direct connection.", {}, "IMPROVE", _log_path=_debug_log_path)
        print(f"[FAIL] Local: {e}")

    # ---- Backend ----
    _log("info", "main:backend:before", "Calling handle_ask (route=backend)", {"message_length": len(prompt)}, _log_path=_debug_log_path)
    try:
        result_backend = cli.handle_ask(prompt, route_override="backend", return_result=True)
        if result_backend is None:
            _log(
                "suspicious",
                "main:backend:result",
                "Backend handle_ask returned None (unavailable or error).",
                {"message_length": len(prompt)},
                "SUSP",
                _log_path=_debug_log_path,
            )
            print("[WARN] Backend: no response (None).")
        else:
            text = getattr(result_backend, "response_text", "") or ""
            _log(
                "info",
                "main:backend:result",
                "Backend response ok",
                {
                    "source": getattr(result_backend, "source", None),
                    "model": getattr(result_backend, "model", None),
                    "tokens_used": getattr(result_backend, "tokens_used", None),
                    "response_length": len(text or ""),
                },
                _log_path=_debug_log_path,
            )
            print(f"[BACKEND] {text[:200]}{'...' if len(text) > 200 else ''}")
    except Exception as e:
        _log(
            "error",
            "main:backend:exception",
            "Backend handle_ask raised",
            {"exception_type": type(e).__name__, "exception": str(e)[:200]},
            "ERR",
            _log_path=_debug_log_path,
        )
        if "proxy" in str(e).lower():
            _log("improvement", "main:backend:exception", "Proxy may be blocking backend; unset HTTP_PROXY/HTTPS_PROXY to try direct connection.", {}, "IMPROVE", _log_path=_debug_log_path)
        print(f"[FAIL] Backend: {e}")

    _log("info", "test_local_and_backend_natural_language:main", "Natural-language test end", {}, _log_path=_debug_log_path)
    print("\nDone. Check debug log for errors/suspicious/improvements.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
