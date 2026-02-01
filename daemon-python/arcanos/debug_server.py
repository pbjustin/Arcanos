
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Union
from urllib.parse import parse_qs, urlparse

import requests

if TYPE_CHECKING:
    from cli import ArcanosCLI

from .config import Config, get_automation_auth, get_backend_base_url
from arcanos.debug import handle_request, liveness, log_audit_event, readiness, get_debug_logger


class DebugAPIHandler(BaseHTTPRequestHandler):
    cli_instance: "ArcanosCLI"
    _last_status_code: int = 200
    _request_id: Optional[str] = None

    def _is_localhost(self) -> bool:
        return (self.client_address[0] if self.client_address else None) == "127.0.0.1"

    def _consume_confirmation_token(self, token: str) -> bool:
        backend_url = (get_backend_base_url() or "").rstrip("/")
        if not backend_url:
            return False

        url = f"{backend_url}/debug/consume-confirm-token"
        headers = {"Content-Type": "application/json"}
        header_name, secret = get_automation_auth()
        if secret:
            headers[header_name] = secret
        try:
            response = requests.post(url, json={"token": token}, headers=headers, timeout=5)
            if response.status_code < 200 or response.status_code >= 300:
                return False
            payload = response.json() if response.content else {}
            return bool(payload.get("ok"))
        except requests.RequestException:
            return False

    def _check_auth(self) -> bool:
        header_name, secret = get_automation_auth()
        provided = self.headers.get(header_name)
        token_header = self.headers.get("x-arcanos-confirm-token")

        # //audit Assumption: automation secret is the primary gate; risk: unauthorized access; invariant: secret must match when configured; handling: allow only matching header.
        if secret and provided == secret:
            return True

        if token_header:
            # //audit Assumption: confirmation token is single-use; risk: replay without consumption; invariant: token must be consumed via backend; handling: call backend consume endpoint.
            return self._consume_confirmation_token(token_header)

        if not secret and self._is_localhost():
            logging.getLogger("arcanos.debug").warning(
                "ARCANOS_AUTOMATION_SECRET is not set; debug API available only from localhost."
            )
            return True

        return False

    def _send_response(
        self,
        status_code: int,
        data: Optional[Union[Dict[str, Any], List[Any]]] = None,
        error: Optional[str] = None,
    ):
        # Track last status code for middleware/metrics
        self._last_status_code = status_code

        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        response: Dict[str, Any] = {"ok": status_code >= 200 and status_code < 300}
        if error:
            response["error"] = error
        if data is not None:
            response.update(data if isinstance(data, dict) else {"data": data})

        self.wfile.write(json.dumps(response, indent=2).encode("utf-8"))

    def _read_body(self) -> Optional[Dict[str, Any]]:
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if not content_length:
                return None
            body_raw = self.rfile.read(content_length)
            return json.loads(body_raw)
        except (json.JSONDecodeError, TypeError):
            return None

    def _path_without_query(self) -> str:
        if "?" not in self.path:
            return self.path
        return self.path.split("?", 1)[0]

    def _query_params(self) -> Dict[str, List[str]]:
        try:
            parsed = urlparse(self.path)
            return parse_qs(parsed.query, keep_blank_values=False)
        except Exception:
            return {}

    def _check_authentication(self, require_auth: bool = True) -> bool:
        """
        Check if request is authenticated.
        
        Args:
            require_auth: If True, authentication is required. If False, only check if token is valid when provided.
        
        Returns:
            True if authenticated or auth not required, False otherwise.
        """
        # Health and ready endpoints are read-only and don't require auth
        path = self._path_without_query()
        if path in ("/debug/health", "/debug/ready", "/debug/metrics"):
            return True
        
        # If no token is configured, require explicit opt-in via Config
        if not Config.DEBUG_SERVER_TOKEN:
            # Allow unauthenticated access only if explicitly enabled (for development)
            # Use Config class (adapter boundary pattern)
            if not Config.DEBUG_SERVER_ALLOW_UNAUTHENTICATED:
                self._send_response(401, error="DEBUG_SERVER_TOKEN not configured. Set DEBUG_SERVER_TOKEN environment variable for security.")
                return False
            return True
        
        # Check Authorization header (Bearer token)
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
            if token == Config.DEBUG_SERVER_TOKEN:
                return True
        
        # Check X-Debug-Token header (alternative)
        token_header = self.headers.get("X-Debug-Token", "").strip()
        if token_header == Config.DEBUG_SERVER_TOKEN:
            return True
        
        # Check query parameter (disabled by default for security)
        if Config.DEBUG_SERVER_ALLOW_QUERY_TOKEN:
            params = self._query_params()
            if "token" in params and params["token"]:
                if params["token"][0] == Config.DEBUG_SERVER_TOKEN:
                    return True
        
        if require_auth:
            # Audit log: auth failure (without logging token)
            client_ip = getattr(self, "client_address", ("unknown",))[0]
            log_audit_event(
                "auth_failure",
                source="debug_server",
                client_ip=client_ip,
                path=self._path_without_query(),
                method=getattr(self, "command", "UNKNOWN")
            )
            if Config.DEBUG_SERVER_ALLOW_QUERY_TOKEN:
                error_msg = "Authentication required. Provide DEBUG_SERVER_TOKEN via Authorization: Bearer <token> header, X-Debug-Token header, or ?token=<token> query parameter."
            else:
                error_msg = "Authentication required. Provide DEBUG_SERVER_TOKEN via Authorization: Bearer <token> header or X-Debug-Token header. Query parameter authentication is disabled for security."
            self._send_response(401, error=error_msg)
            return False
        
        return True

    def do_GET(self):
        path = self._path_without_query()

        def _inner() -> None:
            if not self._check_auth():
                self._send_response(403, error="Forbidden")
                return

            if path == "/debug/status":
                self.get_status()
            elif path == "/debug/instance-id":
                self.get_instance_id()
            elif path == "/debug/chat-log":
                self.get_chat_log()
            elif path == "/debug/help":
                self.get_help()
            elif path.startswith("/debug/logs"):
                self.get_logs()
            elif path == "/debug/log-files":
                self.get_log_files()
            elif path.startswith("/debug/audit"):
                self.get_audit()
            elif path == "/debug/crash-reports":
                self.get_crash_reports()
            elif path == "/debug/health":
                self._get_health()
            elif path == "/debug/ready":
                self._get_ready()
            elif path == "/debug/metrics":
                self._get_metrics()
            else:
                self._send_response(404, error="Not Found")

        handle_request(self, path, _inner)

    def do_POST(self):
        path = self._path_without_query()

        def _inner() -> None:
            if not self._check_auth():
                self._send_response(403, error="Forbidden")
                return

            body = self._read_body()
            if body is None and path in ("/debug/ask", "/debug/run"):  # see can have empty body
                self._send_response(400, error="Invalid or missing JSON body")
                return

            if path == "/debug/ask":
                self.post_ask(body)
            elif path == "/debug/run":
                self.post_run(body)
            elif path == "/debug/see":
                self.post_see(body or {})
            else:
                self._send_response(404, error="Not Found")

        handle_request(self, path, _inner)

    def get_status(self):
        uptime = time.time() - self.cli_instance.start_time
        status_data = {
            "instanceId": getattr(self.cli_instance, "instance_id", None),
            "clientId": getattr(self.cli_instance, "client_id", None),
            "uptime": int(uptime),
            "backend_configured": bool(Config.BACKEND_URL),
            "version": Config.VERSION,
            "last_error": getattr(self.cli_instance, "_last_error", None),
        }
        self._send_response(200, status_data)

    def get_instance_id(self):
        instance_id = getattr(self.cli_instance, "instance_id", None)
        self._send_response(200, {"instanceId": instance_id})

    def get_chat_log(self):
        memory = self.cli_instance.memory
        # Assuming get_recent_conversations exists and returns a list of dicts
        raw_conversations = memory.get_recent_conversations(limit=10)
        chat_log = []
        for c in raw_conversations:
            chat_log.append({"role": "user", "message": c.get("user"), "timestamp": c.get("timestamp")})
            chat_log.append({"role": "assistant", "message": c.get("ai"), "timestamp": c.get("timestamp")})
        
        self._send_response(200, {
            "chat_log": chat_log,
            "last_error": getattr(self.cli_instance, "_last_error", None),
        })

    def get_help(self):
        """Return help text as JSON"""
        help_text = """
# ARCANOS Commands

### Conversation
- Just type naturally to chat with ARCANOS
- **help** - Show this help message
- **exit** / **quit** - Exit ARCANOS
- **deep <prompt>** / **backend <prompt>** - Force backend routing
- **deep:** / **backend:** - Prefix for backend routing in hybrid mode

### Vision
- **see** - Analyze screenshot
- **see camera** - Analyze webcam image
- **see backend** - Analyze screenshot via backend
- **see camera backend** - Analyze webcam image via backend

### Voice
- **voice** - Use voice input (one-time)
- **voice backend** - Use backend transcription
- **ptt** - Start push-to-talk mode (hold SPACEBAR)
- **speak** - Replay the last response (TTS)

### Terminal
- **run <command>** - Execute shell command (PowerShell on Windows, bash/sh on macOS/Linux)
  Examples: `run Get-Process` (Windows), `run ls -la` (macOS/Linux)

### System
- **stats** - Show usage statistics
- **clear** - Clear conversation history
- **reset** - Reset statistics
- **update** - Check for updates and download installer (if GITHUB_RELEASES_REPO is set)

### Examples
```
You: hey arcanos, what's the weather like today?
You: see
You: run Get-Date
You: voice
You: ptt
```
        """
        self._send_response(200, {"help_text": help_text.strip()})

    def get_logs(self):
        params = self._query_params()
        tail = 50
        if "tail" in params:
            try:
                tail = max(1, min(1000, int(params["tail"][0])))
            except (ValueError, IndexError):
                pass

        log_file = Config.LOG_DIR / "errors.log"
        if not log_file.exists():
            self._send_response(200, {"path": str(log_file), "lines": [], "total": 0, "error": "Log file not found."})
            return

        with open(log_file, "r", encoding="utf-8") as f:
            all_lines = f.readlines()
        
        total = len(all_lines)
        lines = all_lines[-tail:] if tail < total else all_lines
        
        self._send_response(200, {"path": str(log_file), "lines": lines, "total": total, "returned": len(lines)})

    def get_log_files(self):
        log_dir = Config.LOG_DIR
        files = []
        if log_dir.exists():
            for f in log_dir.iterdir():
                if f.is_file():
                    stat = f.stat()
                    files.append({"name": f.name, "mtime": stat.st_mtime, "size": stat.st_size})
        self._send_response(200, {"log_dir": str(log_dir), "files": files})

    def get_audit(self):
        params = self._query_params()
        limit = 50
        if "limit" in params:
            try:
                limit = max(1, min(500, int(params["limit"][0])))
            except (ValueError, IndexError):
                pass
        
        # Filtering by kind
        filter_kind = None
        if "filter" in params and params["filter"]:
            filter_kind = params["filter"][0].lower()
        
        with self.cli_instance._activity_lock:
            all_entries = list(self.cli_instance._activity)
        
        # Apply filter
        if filter_kind:
            all_entries = [e for e in all_entries if e.get("kind", "").lower() == filter_kind]
        
        # Sorting (default: newest first via deque order, but allow reverse)
        sort_order = "desc"
        if "order" in params and params["order"]:
            sort_order = params["order"][0].lower()
        
        if sort_order == "asc":
            all_entries = list(reversed(all_entries))
        
        total = len(all_entries)
        entries = all_entries[:limit]

        self._send_response(200, {"entries": entries, "total": total, "returned": len(entries), "limit": limit})

    def get_crash_reports(self):
        crash_dir = Config.CRASH_REPORTS_DIR
        files = []
        latest_content = None
        latest_file = None

        if crash_dir.exists():
            sorted_files = sorted(crash_dir.iterdir(), key=lambda f: f.stat().st_mtime, reverse=True)
            for f in sorted_files:
                if f.is_file():
                    stat = f.stat()
                    files.append({"name": f.name, "mtime": stat.st_mtime, "size": stat.st_size})
            if sorted_files:
                latest_file = sorted_files[0]
                with open(latest_file, "r", encoding="utf-8") as f:
                    latest_content = f.read()

        self._send_response(200, {"files": files, "latest_content": latest_content})

    def post_ask(self, body):
        message = body.get("message")
        if not message:
            self._send_response(400, error="Missing 'message' in request body")
            return

        route_override = body.get("route_override")
        result = self.cli_instance.handle_ask(message, route_override=route_override, return_result=True, from_debug=True)

        if result:
            self._send_response(200, result._asdict())
        else:
            self._send_response(500, error="Failed to handle 'ask' command.")

    def post_run(self, body: Dict[str, Any]):
        command = body.get("command")
        if not command:
            self._send_response(400, error="Missing 'command' in request body")
            return

        result = self.cli_instance.handle_run(command, return_result=True)
        self._send_response(200, result)

    def post_see(self, body: Dict[str, Any]):
        use_camera = body.get("use_camera", False)
        args = ["camera"] if use_camera else []
        result = self.cli_instance.handle_see(args, return_result=True)
        if result:
            self._send_response(200, result)
        else:
            self._send_response(500, error="Failed to handle 'see' command.")

    def _get_health(self) -> None:
        data = liveness()
        self._send_response(200, data)

    def _get_ready(self) -> None:
        data = readiness(self.cli_instance)
        status = 200 if data.get("ok") else 503
        self._send_response(status, data)

    def _get_metrics(self) -> None:
        # Text response, not JSON
        from arcanos.debug import get_metrics  # local import to avoid cycles

        payload = get_metrics().to_prometheus()
        self._last_status_code = 200
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    pass

def start_debug_server(cli: "ArcanosCLI", port: int):
    """Starts the debug HTTP server in a daemon thread."""

    class BoundDebugAPIHandler(DebugAPIHandler):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.cli_instance = cli
            super().__init__(*args, **kwargs)

    # //audit Assumption: debug API is local-only; risk: exposure if bound to 0.0.0.0; invariant: bind to localhost; handling: explicit 127.0.0.1.
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, BoundDebugAPIHandler)

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
