"""Recovery reads bound real response bodies and stop without abandoned reader threads."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading
import time

import pytest
import requests

from .test_automatic_conversation_recovery import CAPABILITY, JOB, _completed, recovery_profile


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Actual Windows protected continuation required")


@pytest.mark.parametrize("mode", ["deadline", "stop", "oversized", "complete", "auth401", "auth403", "long_length", "header_delay"])
def test_real_continuation_body_budget_and_shutdown(recovery_profile, mode):
    """One admitted job stays protected when its sole real GET is slow, cancelled or oversized."""
    make_cli, wire = recovery_profile
    begun = threading.Event()
    reads = []
    closed = []
    answer = "x" * (512 * 1024 + 1) if mode in ("oversized", "auth401", "auth403") else "Original bounded answer."
    payload = json.dumps(_completed(answer=answer)).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == f"/jobs/{JOB}/result"
            assert self.headers.get("x-arcanos-job-read-token") == CAPABILITY
            reads.append(self.path)
            if mode == "header_delay":
                time.sleep(0.6)
            self.send_response(int(mode[-3:]) if mode.startswith("auth") else 200)
            self.send_header("Content-Length", "9" * 5000 if mode == "long_length" else str(len(payload)))
            self.end_headers()
            width = max(1, len(payload) // (100 if mode == "stop" else 40))
            for offset in range(0, len(payload), width):
                try:
                    self.wfile.write(payload[offset:offset + width])
                    self.wfile.flush()
                except OSError:
                    break
                begun.set()
                if mode in ("deadline", "stop"):
                    time.sleep(0.08)  # Every chunk arrives inside the inactivity limit.

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    cli = make_cli(base_url=f"http://127.0.0.1:{server.server_port}", monitor_clock=time.monotonic)
    cli.handle_ask("original question")
    controller = cli._conversation_recovery

    def sender(*args, **kwargs):
        response = requests.request(*args, **kwargs)
        close = response.close

        def observed_close():
            closed.append(True)
            close()

        response.close = observed_close
        return response

    controller.reader._request_sender = sender
    try:
        if mode == "stop":
            controller.start()
            assert begun.wait(5)
            started = time.monotonic()
            controller.stop()
            assert not controller.thread.is_alive()
            assert time.monotonic() - started < 1
        else:
            from arcanos.backend_client_models import BackendChatContinuation
            started = time.monotonic()
            result = controller.reader.request_chat_job_result(BackendChatContinuation(JOB, CAPABILITY))
            elapsed = time.monotonic() - started
            if mode in ("complete", "header_delay"):
                assert result.ok and result.value.response_text == answer
            else:
                assert not result.ok
                if mode.startswith("auth"):
                    assert result.error.kind == "auth" and result.error.status_code == int(mode[-3:])
                if mode == "deadline":
                    assert result.error.kind == "timeout"
                    assert elapsed < 2.6
        assert closed
        assert len(reads) == 1
        assert len(controller.store.load()) == 1
        assert cli.memory.get_statistics()["total_requests"] == 0
        assert wire["posts"] == wire["providers"] == 1
        assert CAPABILITY not in cli.console.file.getvalue()
    finally:
        controller.stop()
        if controller.thread:
            controller.thread.join(timeout=10)
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=3)
