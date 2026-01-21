"""
IPC WebSocket client for daemon-backend communication.
"""

from __future__ import annotations

import json
import platform
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlparse, urlunparse

try:
    import websocket  # type: ignore
except ImportError:  # pragma: no cover - handled at runtime
    websocket = None

from backend_auth_client import normalize_backend_url
from error_handler import logger


class IpcClientInitError(RuntimeError):
    """
    Purpose: Raised when IPC client cannot initialize required dependencies.
    Inputs/Outputs: Error message describing missing dependency.
    Edge cases: Raised when websocket-client is not installed.
    """


@dataclass(frozen=True)
class IpcCommandRequest:
    """
    Purpose: Represent a command request from backend.
    Inputs/Outputs: command_id, name, issued_at, optional payload.
    Edge cases: payload may be None for command-only messages.
    """

    command_id: str
    name: str
    issued_at: str
    payload: Optional[Mapping[str, Any]] = None


@dataclass(frozen=True)
class IpcCommandResponse:
    """
    Purpose: Represent a command response sent to backend.
    Inputs/Outputs: ok flag, optional payload, optional error.
    Edge cases: payload should be None when ok is False.
    """

    ok: bool
    payload: Optional[Mapping[str, Any]] = None
    error: Optional[str] = None


def build_ws_url(
    base_url: Optional[str],
    ws_path: str,
    explicit_ws_url: Optional[str] = None
) -> Optional[str]:
    """
    Purpose: Build WebSocket URL from base URL and path or explicit override.
    Inputs/Outputs: base_url, ws_path, explicit_ws_url; returns ws url or None.
    Edge cases: Returns None when base_url is missing or invalid.
    """
    if explicit_ws_url:
        # //audit assumption: explicit WS URL is authoritative; risk: malformed URL; invariant: use explicit URL; strategy: return override.
        return explicit_ws_url.strip()

    if not base_url:
        # //audit assumption: base URL required to build WS URL; risk: no IPC; invariant: None returned; strategy: return None.
        return None

    normalized_base = normalize_backend_url(base_url)
    parsed = urlparse(normalized_base)
    if parsed.scheme not in {"http", "https"}:
        # //audit assumption: only http/https supported; risk: invalid scheme; invariant: None; strategy: return None.
        return None

    normalized_path = ws_path if ws_path.startswith("/") else f"/{ws_path}"
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunparse((ws_scheme, parsed.netloc, normalized_path, "", "", ""))


class IpcClient:
    """
    Purpose: Manage IPC WebSocket connection to backend with retry and heartbeat.
    Inputs/Outputs: Uses token provider and command handler; exposes start/stop and send_event APIs.
    Edge cases: Handles missing token or URL by retrying with backoff.
    """

    def __init__(
        self,
        base_url: Optional[str],
        token_provider: Callable[[], Optional[str]],
        ws_path: str,
        heartbeat_interval_seconds: int,
        reconnect_max_seconds: int,
        command_handler: Callable[[IpcCommandRequest], IpcCommandResponse],
        ws_url: Optional[str] = None,
        logger_instance: Optional[Any] = None,
        websocket_factory: Optional[Callable[..., Any]] = None,
        sleep_fn: Callable[[float], None] = time.sleep,
        time_fn: Callable[[], float] = time.time,
        auth_required: bool = True,
        auth_header_name: str = "Authorization",
        auth_header_prefix: Optional[str] = "Bearer",
        auth_mode: str = "jwt",
        daemon_gpt_id: Optional[str] = None,
        daemon_gpt_header_name: str = "OpenAI-GPT-ID"
    ) -> None:
        """
        Purpose: Initialize IPC client with configuration and dependencies.
        Inputs/Outputs: backend URL, token provider, intervals, auth settings, daemon GPT header; prepares client state.
        Edge cases: Raises IpcClientInitError if websocket-client is missing.
        """
        if websocket is None and websocket_factory is None:
            # //audit assumption: websocket-client required; risk: IPC unavailable; invariant: dependency present; strategy: raise error.
            raise IpcClientInitError("websocket-client is required for IPC support")

        self._base_url = base_url
        self._ws_url = ws_url
        self._ws_path = ws_path
        self._token_provider = token_provider
        self._heartbeat_interval_seconds = max(5, heartbeat_interval_seconds)
        self._reconnect_max_seconds = max(5, reconnect_max_seconds)
        self._command_handler = command_handler
        self._websocket_factory = websocket_factory or websocket.WebSocketApp
        self._sleep = sleep_fn
        self._time = time_fn
        self._logger = logger_instance or logger
        self._auth_required = auth_required
        # //audit assumption: header name may be empty; risk: missing auth header; invariant: fallback to Authorization; strategy: strip and default.
        self._auth_header_name = auth_header_name.strip() or "Authorization"
        # //audit assumption: prefix optional; risk: wrong auth scheme; invariant: preserve None; strategy: strip or keep None.
        self._auth_header_prefix = auth_header_prefix.strip() if auth_header_prefix is not None else None
        # //audit assumption: auth mode normalized; risk: invalid mode; invariant: lowercased value; strategy: strip and lower.
        self._auth_mode = auth_mode.strip().lower() or "jwt"
        # //audit assumption: daemon GPT ID optional; risk: whitespace/empty values; invariant: trimmed or None; strategy: strip and fallback.
        self._daemon_gpt_id = daemon_gpt_id.strip() if daemon_gpt_id else None
        # //audit assumption: daemon GPT header name may be empty; risk: missing header; invariant: default header used; strategy: strip and fallback.
        self._daemon_gpt_header_name = daemon_gpt_header_name.strip() or "OpenAI-GPT-ID"
        self._client_id = "arcanos-daemon"
        self._instance_id = str(uuid.uuid4())
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._connected_event = threading.Event()
        self._ws_lock = threading.Lock()
        self._ws_app: Optional[Any] = None
        self._reconnect_delay_seconds = 1

    def is_connected(self) -> bool:
        """
        Purpose: Report whether IPC connection is active.
        Inputs/Outputs: none; returns bool connection state.
        Edge cases: Returns False when connection is not established.
        """
        return self._connected_event.is_set()

    def start(self) -> None:
        """
        Purpose: Start background IPC connection loop.
        Inputs/Outputs: none; spawns worker thread if not running.
        Edge cases: Subsequent calls are ignored when already running.
        """
        if self._thread and self._thread.is_alive():
            # //audit assumption: thread already running; risk: duplicate threads; invariant: single thread; strategy: return.
            return

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """
        Purpose: Stop IPC connection loop and close socket.
        Inputs/Outputs: none; stops worker thread and closes connection.
        Edge cases: Safe to call when not running.
        """
        self._stop_event.set()
        with self._ws_lock:
            if self._ws_app is not None:
                # //audit assumption: ws app can be closed; risk: close failure; invariant: best-effort close; strategy: try/except.
                try:
                    self._ws_app.close()
                except Exception:
                    pass
        if self._thread:
            # //audit assumption: thread may be running; risk: hang on join; invariant: join with timeout; strategy: join.
            self._thread.join(timeout=2)

    def send_event(
        self,
        event_type: str,
        payload: Mapping[str, Any],
        event_id: Optional[str] = None,
        source: Optional[str] = None
    ) -> bool:
        """
        Purpose: Send an event message to the backend.
        Inputs/Outputs: event_type, payload, optional event_id/source; returns True on send.
        Edge cases: Returns False if not connected or send fails.
        """
        if not self.is_connected():
            # //audit assumption: must be connected to send; risk: event dropped; invariant: connection required; strategy: return False.
            return False

        message = {
            "type": "event",
            "eventType": event_type,
            "eventId": event_id or str(uuid.uuid4()),
            "sentAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "payload": dict(payload),
            "source": source or "daemon"
        }
        return self._send_message(message)

    def _run_loop(self) -> None:
        # //audit assumption: run loop repeats until stopped; risk: busy loop; invariant: stop_event breaks loop; strategy: check stop_event.
        while not self._stop_event.is_set():
            ws_url = build_ws_url(self._base_url, self._ws_path, self._ws_url)
            token = self._token_provider()

            if not ws_url:
                # //audit assumption: URL required; risk: cannot connect; invariant: retry with backoff; strategy: sleep and retry.
                self._logger.warning("IPC waiting for backend URL")
                self._sleep(self._reconnect_delay_seconds)
                self._increase_backoff()
                continue

            if not token and self._auth_required:
                # //audit assumption: auth required when enabled; risk: unauthorized connection; invariant: retry with backoff; strategy: sleep and retry.
                auth_label = "token" if self._auth_mode == "jwt" else "API key"
                self._logger.warning("IPC waiting for backend %s", auth_label)
                self._sleep(self._reconnect_delay_seconds)
                self._increase_backoff()
                continue

            headers: list[str] = []
            if token:
                # //audit assumption: token should be sent when available; risk: unauthorized connection; invariant: header attached; strategy: set header.
                headers.append(f"{self._auth_header_name}: {self._build_auth_header_value(token)}")
            self._append_daemon_gpt_header(headers)

            def on_open(_: Any) -> None:
                # //audit assumption: connection opened; risk: missing hello; invariant: hello sent; strategy: send hello.
                self._connected_event.set()
                self._reconnect_delay_seconds = 1
                self._send_hello()
                self._start_heartbeat_thread()

            def on_message(_: Any, message: str) -> None:
                self._handle_message(message)

            def on_error(_: Any, error: Exception) -> None:
                # //audit assumption: socket errors possible; risk: silent failure; invariant: error logged; strategy: log warning.
                self._logger.warning("IPC socket error: %s", error)

            def on_close(_: Any, status_code: int, reason: str) -> None:
                # //audit assumption: connection closed; risk: stale state; invariant: connected flag cleared; strategy: clear state.
                self._connected_event.clear()
                self._logger.info("IPC connection closed (%s): %s", status_code, reason)

            ws_app = self._websocket_factory(
                ws_url,
                header=headers,
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close
            )

            with self._ws_lock:
                self._ws_app = ws_app

            try:
                ws_app.run_forever(ping_interval=self._heartbeat_interval_seconds, ping_timeout=10)
            except Exception as exc:
                # //audit assumption: run_forever can fail; risk: disconnect; invariant: retry; strategy: log and retry.
                self._logger.warning("IPC run loop failed: %s", exc)
            finally:
                self._connected_event.clear()
                with self._ws_lock:
                    self._ws_app = None

            if self._stop_event.is_set():
                # //audit assumption: stop requested; risk: extra reconnect; invariant: exit loop; strategy: break.
                break

            self._sleep(self._reconnect_delay_seconds)
            self._increase_backoff()

    def _increase_backoff(self) -> None:
        # //audit assumption: backoff should grow; risk: tight retry loop; invariant: bounded backoff; strategy: exponential with max.
        self._reconnect_delay_seconds = min(self._reconnect_delay_seconds * 2, self._reconnect_max_seconds)

    def _start_heartbeat_thread(self) -> None:
        def heartbeat_loop() -> None:
            # //audit assumption: heartbeat runs while connected; risk: orphan thread; invariant: stop on disconnect; strategy: loop on flags.
            while self.is_connected() and not self._stop_event.is_set():
                self._send_message({
                    "type": "heartbeat",
                    "sentAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "status": "ok"
                })
                self._sleep(self._heartbeat_interval_seconds)

        thread = threading.Thread(target=heartbeat_loop, daemon=True)
        thread.start()

    def _build_auth_header_value(self, token: str) -> str:
        """
        Purpose: Build authorization header value from token and optional prefix.
        Inputs/Outputs: token string; returns header value string.
        Edge cases: Empty prefix yields raw token.
        """
        # //audit assumption: prefix may be None; risk: missing prefix; invariant: raw token allowed; strategy: return token.
        if not self._auth_header_prefix:
            return token
        # //audit assumption: prefix may be whitespace; risk: malformed header; invariant: non-empty prefix; strategy: strip and fallback.
        trimmed_prefix = self._auth_header_prefix.strip()
        if not trimmed_prefix:
            return token
        return f"{trimmed_prefix} {token}"

    def _append_daemon_gpt_header(self, headers: list[str]) -> None:
        """
        Purpose: Append daemon GPT ID header to WebSocket headers.
        Inputs/Outputs: headers list mutated in place; no return.
        Edge cases: Skips when ID missing or header would override existing header.
        """
        if not self._daemon_gpt_id:
            # //audit assumption: daemon GPT ID optional; risk: header omitted; invariant: no header when missing; strategy: return.
            return
        header_name = self._daemon_gpt_header_name
        if not header_name:
            # //audit assumption: header name required; risk: malformed header; invariant: skip when empty; strategy: return.
            return
        # //audit assumption: header comparison should be case-insensitive; risk: overwrite auth header; invariant: avoid conflicts; strategy: normalize names.
        existing_names: set[str] = set()
        for entry in headers:
            if ":" not in entry:
                # //audit assumption: malformed header line; risk: parse failure; invariant: skip entry; strategy: continue.
                continue
            existing_names.add(entry.split(":", 1)[0].strip().lower())
        if header_name.lower() in existing_names:
            # //audit assumption: do not overwrite existing header; risk: auth clobbered; invariant: existing header preserved; strategy: skip.
            return
        headers.append(f"{header_name}: {self._daemon_gpt_id}")

    def _send_hello(self) -> None:
        hello_message = {
            "type": "hello",
            "clientId": self._client_id,
            "sentAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "version": platform.python_version(),
            "capabilities": ["command", "event", "heartbeat"],
            "platform": platform.platform(),
            "instanceId": self._instance_id
        }
        self._send_message(hello_message)

    def _send_message(self, message: Mapping[str, Any]) -> bool:
        payload = json.dumps(message, ensure_ascii=True)
        with self._ws_lock:
            if not self._ws_app:
                # //audit assumption: ws app required; risk: message dropped; invariant: connection exists; strategy: return False.
                return False
            try:
                self._ws_app.send(payload)
                return True
            except Exception as exc:
                # //audit assumption: send can fail; risk: message dropped; invariant: error logged; strategy: return False.
                self._logger.warning("IPC send failed: %s", exc)
                return False

    def _handle_message(self, raw_message: str) -> None:
        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            # //audit assumption: payload must be JSON; risk: malformed message; invariant: ignore; strategy: return.
            return

        message_type = payload.get("type") if isinstance(payload, dict) else None
        if message_type == "command":
            # //audit assumption: command messages should be handled; risk: missed commands; invariant: handler called; strategy: dispatch.
            self._handle_command(payload)
        elif message_type == "hello_ack":
            # //audit assumption: hello_ack confirms connection; risk: missing ack; invariant: log ack; strategy: log info.
            self._logger.info("IPC hello_ack received")
        elif message_type == "error":
            # //audit assumption: server error should be surfaced; risk: silent failure; invariant: log warning; strategy: log.
            self._logger.warning("IPC server error: %s", payload.get("message"))

    def _handle_command(self, payload: Mapping[str, Any]) -> None:
        command_id = payload.get("commandId")
        name = payload.get("name")
        issued_at = payload.get("issuedAt")
        if not isinstance(command_id, str) or not isinstance(name, str) or not isinstance(issued_at, str):
            # //audit assumption: command requires identifiers; risk: invalid command; invariant: ignore; strategy: return.
            return

        request = IpcCommandRequest(
            command_id=command_id,
            name=name,
            issued_at=issued_at,
            payload=payload.get("payload") if isinstance(payload.get("payload"), dict) else None
        )
        try:
            response = self._command_handler(request)
        except Exception as exc:
            # //audit assumption: command handler can fail; risk: unhandled exception; invariant: error response sent; strategy: return error.
            self._logger.warning("IPC command handler failed: %s", exc)
            response = IpcCommandResponse(ok=False, error="IPC command handler failed")
        result_message = {
            "type": "command_result",
            "commandId": request.command_id,
            "ok": response.ok,
            "respondedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "payload": dict(response.payload) if response.payload and response.ok else None,
            "error": response.error if not response.ok else None
        }
        self._send_message(result_message)
