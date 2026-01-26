
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple, Union

if TYPE_CHECKING:
    from cli import ArcanosCLI

from config import Config
from memory import Memory

class DebugAPIHandler(BaseHTTPRequestHandler):
    cli_instance: "ArcanosCLI"

    def _send_response(
        self,
        status_code: int,
        data: Optional[Union[Dict[str, Any], List[Any]]] = None,
        error: Optional[str] = None,
    ):
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

    def do_GET(self):
        try:
            if self.path == "/debug/status":
                self.get_status()
            elif self.path == "/debug/instance-id":
                self.get_instance_id()
            elif self.path == "/debug/chat-log":
                self.get_chat_log()
            elif self.path.startswith("/debug/logs"):
                self.get_logs()
            elif self.path == "/debug/log-files":
                self.get_log_files()
            elif self.path.startswith("/debug/audit"):
                self.get_audit()
            elif self.path == "/debug/crash-reports":
                self.get_crash_reports()
            else:
                self._send_response(404, error="Not Found")
        except Exception as e:
            self._send_response(500, error=f"Internal Server Error: {e}")

    def do_POST(self):
        try:
            body = self._read_body()
            if body is None and self.path in ("/debug/ask", "/debug/run"): # see can have empty body
                self._send_response(400, error="Invalid or missing JSON body")
                return

            if self.path == "/debug/ask":
                self.post_ask(body)
            elif self.path == "/debug/run":
                self.post_run(body)
            elif self.path == "/debug/see":
                self.post_see(body or {})
            else:
                self._send_response(404, error="Not Found")
        except Exception as e:
            self._send_response(500, error=f"Internal Server Error: {e}")

    def get_status(self):
        uptime = time.time() - self.cli_instance.start_time
        status_data = {
            "instanceId": self.cli_instance.daemon_service.instance_id if self.cli_instance.daemon_service else None,
            "clientId": self.cli_instance.daemon_service.client_id if self.cli_instance.daemon_service else None,
            "uptime": int(uptime),
            "backend_configured": bool(Config.BACKEND_URL),
            "version": Config.VERSION,
            "last_error": getattr(self.cli_instance, "_last_error", None),
        }
        self._send_response(200, status_data)

    def get_instance_id(self):
        instance_id = self.cli_instance.daemon_service.instance_id if self.cli_instance.daemon_service else None
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

    def get_logs(self):
        tail = 50
        if "?" in self.path:
            query = self.path.split("?", 1)[1]
            params = dict(p.split("=") for p in query.split("&"))
            tail = int(params.get("tail", 50))

        log_file = Config.LOG_DIR / "errors.log"
        if not log_file.exists():
            self._send_response(200, {"path": str(log_file), "lines": [], "error": "Log file not found."})
            return

        with open(log_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        self._send_response(200, {"path": str(log_file), "lines": lines[-tail:]})

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
        limit = 50
        if "?" in self.path:
            query = self.path.split("?", 1)[1]
            params = dict(p.split("=") for p in query.split("&"))
            limit = int(params.get("limit", 50))
        
        with self.cli_instance._activity_lock:
            entries = list(self.cli_instance._activity)[:limit]

        self._send_response(200, {"entries": entries})

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


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    pass

def start_debug_server(cli: "ArcanosCLI", port: int):
    """Starts the debug HTTP server in a daemon thread."""

    def handler(*args, **kwargs):
        # We need to pass the CLI instance to the handler.
        # This is a bit of a hack, but it's the cleanest way with http.server.
        handler_class = DebugAPIHandler
        handler_class.cli_instance = cli
        return handler_class(*args, **kwargs)

    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, handler)

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
