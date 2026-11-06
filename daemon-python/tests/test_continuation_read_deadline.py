"""Recovery reads bound real response bodies and stop without abandoned reader threads."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import select
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
    closed = threading.Event()
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
                    closed.set()
                    break
                begun.set()
                if mode in ("deadline", "stop"):
                    time.sleep(0.08)  # Every chunk arrives inside the inactivity limit.
            try:
                if select.select([self.connection], [], [], 1)[0] and not self.connection.recv(1):
                    closed.set()
            except OSError:
                closed.set()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    cli = make_cli(base_url=f"http://127.0.0.1:{server.server_port}", monitor_clock=time.monotonic)
    cli.handle_ask("original question")
    controller = cli._conversation_recovery

    # The native sender selects the production cancellable transport; a wrapper
    # would instead exercise the explicit synthetic sender compatibility seam.
    controller.reader._request_sender = requests.request
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
        assert closed.wait(1), "The completed/stopped read left its connection open"
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


@pytest.mark.parametrize("mode", ["headers_stop", "headers_deadline", "status_deadline", "silent_headers_stop", "silent_body_stop"])
def test_real_header_acquisition_cancels_without_late_completion(recovery_profile, mode):
    """Cancellation must reach the real connection before Requests can return a response."""
    make_cli, wire = recovery_profile
    begun = threading.Event()
    disconnected = threading.Event()
    reads = []
    payload = json.dumps(_completed(answer="The original accepted answer.")).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == f"/jobs/{JOB}/result"
            assert self.headers.get("x-arcanos-job-read-token") == CAPABILITY
            assert not self.headers.get("x-arcanos-daemon-token")
            reads.append(self.path)
            try:
                if mode == "silent_body_stop":
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                elif mode.startswith("headers_"):
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Synthetic-Progress: ")
                    self.wfile.flush()
                begun.set()
                # Observe socket closure without waiting for a subsequent write.
                # A real slow peer can otherwise keep the inactivity clock fresh.
                for _ in range(60):
                    if select.select([self.connection], [], [], 0.1)[0]:
                        if not self.connection.recv(1):
                            disconnected.set()
                            return
                    if mode == "status_deadline":
                        self.wfile.write(b"H")
                        self.wfile.flush()
                    elif mode.startswith("headers_"):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                if mode.startswith("headers_"):
                    self.wfile.write(b"\r\nContent-Length: " + str(len(payload)).encode() + b"\r\n\r\n" + payload)
                elif mode == "silent_headers_stop":
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                elif mode == "silent_body_stop":
                    self.wfile.write(payload)
                self.wfile.flush()
            except OSError:
                disconnected.set()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    cli = make_cli(base_url=f"http://127.0.0.1:{server.server_port}", monitor_clock=time.monotonic)
    cli.handle_ask("original question")
    controller = cli._conversation_recovery
    controller.reader._request_sender = requests.request
    try:
        if mode.endswith("_stop"):
            controller.start()
            assert begun.wait(5), "The original job GET never reached the slow peer"
            started = time.monotonic()
            controller.stop()
            elapsed = time.monotonic() - started
            assert not controller.thread.is_alive(), f"Recovery worker survived stop after {elapsed:.3f}s"
            assert elapsed < 1, f"Cancellation waited for socket inactivity ({elapsed:.3f}s)"
        else:
            from arcanos.backend_client_models import BackendChatContinuation
            started = time.monotonic()
            result = controller.reader.request_chat_job_result(BackendChatContinuation(JOB, CAPABILITY))
            elapsed = time.monotonic() - started
            assert not result.ok and result.error.kind == "timeout"
            assert elapsed < 2.6, f"Peer progress bypassed the total read deadline ({elapsed:.3f}s)"
        assert disconnected.wait(1), "The cancelled/deadline-expired read left its connection open"
        assert reads == [f"/jobs/{JOB}/result"]
        assert len(controller.store.load()) == 1
        assert cli.memory.get_statistics()["total_requests"] == 0
        assert cli.rate_limiter.tokens_today == 0
        assert "The original accepted answer." not in cli.console.file.getvalue()
        assert CAPABILITY not in cli.console.file.getvalue()
        assert wire["posts"] == wire["providers"] == 1
        cli.audio.speak.assert_not_called()
    finally:
        controller.stop()
        if controller.thread:
            controller.thread.join(timeout=10)
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=3)
