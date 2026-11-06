"""A cancellable, single-GET Requests lifetime, with no persistent helper process.

Job/writing credentials cross only anonymous stdin. The child imports no daemon configuration,
cannot create jobs, and has its own hard lifetime if the foreground dies. Keeping
Requests here preserves its proxy, certificate verification and decoding behavior.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from typing import Callable
from urllib.parse import urlsplit
from uuid import UUID


MAX_RESPONSE_BYTES = 512 * 1024
MAX_INPUT_BYTES = 4096  # Fits the Windows anonymous stdin pipe without a blocking bulk write.
MAX_WIRE_BYTES = 768 * 1024
_ENVIRONMENT = frozenset(name.lower() for name in (
    "SystemRoot", "WINDIR", "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PYTHONHOME", "PYTHONNOUSERSITE", "NETRC",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
))


def _validate(url: str, headers: dict) -> None:
    """Accept only the existing original-job result surface, never arbitrary work."""
    parsed = urlsplit(url)
    match = re.search(r"/jobs/([0-9a-f-]{36})/result\Z", parsed.path)
    if (parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or match is None
            or str(UUID(match[1])) != match[1]):
        raise ValueError("Invalid continuation coordinates")
    if set(headers) - {"Content-Type", "Authorization", "x-gpt-id", "x-arcanos-job-read-token"}:
        raise ValueError("Invalid continuation headers")
    if re.fullmatch(r"v1\.[A-Za-z0-9_-]{43}", headers.get("x-arcanos-job-read-token", "")) is None:
        raise ValueError("Invalid continuation capability")


def get_response(url: str, headers: dict, timeout: float, cancelled: Callable[[], bool]):
    """Run exactly one read; cancel, terminate and reap it before returning an error."""
    import requests

    started = time.monotonic()
    try:
        _validate(url, headers)
        wire = json.dumps({"url": url, "headers": headers}, ensure_ascii=True).encode("ascii")
        if len(wire) > MAX_INPUT_BYTES or not 0 < timeout <= 2:
            raise ValueError("Invalid continuation transport bounds")
    except (ValueError, TypeError):
        raise requests.RequestException("Conversation recovery transport input is invalid.") from None
    if cancelled():
        raise requests.Timeout("Conversation recovery read stopped.")
    child = None
    try:
        environment = {key: value for key, value in os.environ.items() if key.lower() in _ENVIRONMENT}
        # Preserve the parent's installed Requests dependencies even when its
        # user profile is isolated. Never inherit arbitrary PYTHONPATH/startup
        # hooks: -S loads only these resolved library roots, without sitecustomize.
        libraries = set()
        for name in ("requests", "urllib3", "certifi", "idna", "charset_normalizer", "chardet", "socks"):
            spec = importlib.util.find_spec(name)
            if spec is not None and spec.origin:
                source = Path(spec.origin).resolve()
                libraries.add(str(source.parent.parent if spec.submodule_search_locations else source.parent))
        environment["PYTHONPATH"] = os.pathsep.join(sorted(libraries))
        child = subprocess.Popen(
            [sys.executable, "-B", "-S", str(Path(__file__).resolve()), "--worker", str(timeout)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=environment,
            close_fds=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        while True:
            remaining = timeout - (time.monotonic() - started)
            if cancelled() or remaining <= 0:
                raise requests.Timeout("Conversation recovery read stopped or exceeded its deadline.")
            try:
                output, _ = child.communicate(input=wire, timeout=min(0.05, remaining))
                break
            except subprocess.TimeoutExpired:
                wire = None  # communicate retains its input across bounded waits.
        if cancelled() or time.monotonic() - started >= timeout:
            raise requests.Timeout("Conversation recovery read stopped or exceeded its deadline.")
        if child.returncode == 124:
            raise requests.Timeout("Conversation recovery read exceeded its deadline.")
        if child.returncode != 0 or len(output) > MAX_WIRE_BYTES:
            raise requests.RequestException("Conversation recovery transport failed.")
        try:
            payload = json.loads(output)
            body = base64.b64decode(payload["body"], validate=True)
            if len(body) > MAX_RESPONSE_BYTES or not 100 <= payload["status"] <= 599:
                raise ValueError("Invalid continuation response")
            response = requests.Response()
            response.status_code = payload["status"]
            response.headers.update(payload["headers"])
            response.url = url
            response.encoding = requests.utils.get_encoding_from_headers(response.headers)
            response._content = body
            response._content_consumed = True
            return response
        except (ValueError, TypeError, KeyError):
            raise requests.RequestException("Conversation recovery transport returned invalid data.") from None
    except requests.RequestException:
        raise
    except OSError:
        raise requests.RequestException("Conversation recovery transport could not start.") from None
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            # Reap the child and join communicate's pipe reader, including on
            # cancellation. No reader or network operation escapes this call.
            child.communicate()


def _worker(lifetime: float) -> None:
    """One Requests GET, including DNS/TLS, dies even if its parent cannot clean up."""
    watchdog = threading.Timer(lifetime, os._exit, args=(124,))
    watchdog.daemon = True
    watchdog.start()
    try:
        payload = json.loads(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1))
        url, headers = payload["url"], payload["headers"]
        _validate(url, headers)
        import requests

        with requests.get(url, headers=headers, timeout=lifetime, allow_redirects=False, stream=True) as response:
            body = bytearray()
            # Auth/redirect status is authoritative without consuming an
            # attacker-controlled body or following credentials elsewhere.
            if response.status_code not in (401, 403) and not 300 <= response.status_code < 400:
                length = response.headers.get("Content-Length", "").lstrip("0") or "0"
                if length.isdecimal() and (len(length) > 6 or int(length) > MAX_RESPONSE_BYTES):
                    raise ValueError("Oversized continuation response")
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise ValueError("Oversized continuation response")
                    body.extend(chunk)
            # Only existing JSON/status parsing metadata returns to the daemon.
            metadata = {name: response.headers[name] for name in ("Content-Type", "Retry-After") if name in response.headers}
            if sum(len(key) + len(value) for key, value in metadata.items()) > 16 * 1024:
                raise ValueError("Oversized continuation metadata")
            result = {"status": response.status_code, "headers": metadata,
                      "body": base64.b64encode(body).decode("ascii")}
        sys.stdout.buffer.write(json.dumps(result).encode("ascii"))
        sys.stdout.buffer.flush()
    finally:
        watchdog.cancel()
        watchdog.join()


if __name__ == "__main__":
    # The helper has no generic command or provider operation. Never print raw
    # request exceptions: they can contain proxy credentials or response text.
    try:
        if len(sys.argv) != 3 or sys.argv[1] != "--worker" or not 0 < float(sys.argv[2]) <= 2:
            raise ValueError("Invalid worker invocation")
        _worker(float(sys.argv[2]))
    except BaseException:
        sys.exit(1)
