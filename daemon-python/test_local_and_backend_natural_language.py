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

sys.path.insert(0, str(BASE_DIR))

DEBUG_LOG_PATH = Path(r"c:\Users\pbjus\.cursor\debug.log")


def _log(
    kind: str,
    location: str,
    message: str,
    data: dict | None = None,
    hypothesis_id: str = "NL",
) -> None:
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
    try:
        with DEBUG_LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload) + "\n")
    except OSError:
        pass


def main() -> int:
    _log("info", "test_local_and_backend_natural_language:main", "Natural-language test start", {"cwd": str(BASE_DIR)})
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
        )

    try:
        from arcanos.config import Config
    except Exception as e:
        _log("error", "import:config", "Failed to import config", {"exception": str(e)}, "ERR")
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
    )
    if not Config.OPENAI_API_KEY or Config.OPENAI_API_KEY == "sk-dummy-api-key":
        _log(
            "improvement",
            "main:config",
            "OPENAI_API_KEY not set or dummy; local path may fail.",
            {"suggestion": "Set OPENAI_API_KEY in .env for local GPT tests."},
            "IMPROVE",
        )

    try:
        from arcanos.cli import ArcanosCLI
    except Exception as e:
        _log("error", "import:cli", "Failed to import ArcanosCLI", {"exception": str(e)}, "ERR")
        print(f"[FAIL] CLI import: {e}")
        return 1

    try:
        cli = ArcanosCLI()
    except Exception as e:
        _log("error", "main:cli_init", "Failed to create ArcanosCLI", {"exception": str(e)}, "ERR")
        print(f"[FAIL] CLI init: {e}")
        return 1

    prompt = "Hello! Reply in one short sentence: what can you help me with?"
    # ---- Local ----
    _log("info", "main:local:before", "Calling handle_ask (route=local)", {"prompt_preview": prompt[:80]})
    try:
        result_local = cli.handle_ask(prompt, route_override="local", return_result=True)
        if result_local is None:
            _log(
                "suspicious",
                "main:local:result",
                "Local handle_ask returned None (no response or rate limit).",
                {"prompt_preview": prompt[:60]},
                "SUSP",
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
                    "text_preview": (text or "")[:120],
                },
            )
            print(f"[LOCAL] {text[:200]}{'...' if len(text) > 200 else ''}")
    except Exception as e:
        _log(
            "error",
            "main:local:exception",
            "Local handle_ask raised",
            {"exception_type": type(e).__name__, "exception": str(e)[:200]},
            "ERR",
        )
        if "proxy" in str(e).lower():
            _log("improvement", "main:local:exception", "Proxy may be blocking OpenAI; unset HTTP_PROXY/HTTPS_PROXY to try direct connection.", {}, "IMPROVE")
        print(f"[FAIL] Local: {e}")

    # ---- Backend ----
    _log("info", "main:backend:before", "Calling handle_ask (route=backend)", {"prompt_preview": prompt[:80]})
    try:
        result_backend = cli.handle_ask(prompt, route_override="backend", return_result=True)
        if result_backend is None:
            _log(
                "suspicious",
                "main:backend:result",
                "Backend handle_ask returned None (unavailable or error).",
                {"prompt_preview": prompt[:60]},
                "SUSP",
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
                    "text_preview": (text or "")[:120],
                },
            )
            print(f"[BACKEND] {text[:200]}{'...' if len(text) > 200 else ''}")
    except Exception as e:
        _log(
            "error",
            "main:backend:exception",
            "Backend handle_ask raised",
            {"exception_type": type(e).__name__, "exception": str(e)[:200]},
            "ERR",
        )
        if "proxy" in str(e).lower():
            _log("improvement", "main:backend:exception", "Proxy may be blocking backend; unset HTTP_PROXY/HTTPS_PROXY to try direct connection.", {}, "IMPROVE")
        print(f"[FAIL] Backend: {e}")

    _log("info", "test_local_and_backend_natural_language:main", "Natural-language test end", {})
    print("\nDone. Check debug log for errors/suspicious/improvements.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
