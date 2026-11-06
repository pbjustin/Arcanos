"""Acceptance observations must not change real HTTP or client validation."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time


def test_native_response_observer_preserves_malformed_http_responses(monkeypatch, tmp_path):
    """Exercise the installed response hook and actual client against controlled HTTP bodies."""
    repository = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(repository / "daemon-python/scripts"))
    from local_action_acceptance.common import clean_env

    job_id = "51883102-2222-4222-8222-222222222222"
    capability = "v1." + "R" * 43
    accepted = {"ok": True, "status": "running", "jobId": job_id, "result": {},
                "poll": f"/jobs/{job_id}/result", "jobReadToken": capability,
                "jobReadTokenHeader": "x-arcanos-job-read-token"}
    pending = {"jobId": job_id, "status": "pending", "jobStatus": "running", "result": None}
    malformed = [b"not-json", b"[]", b"null", b'"scalar"']
    counters = {"/gpt/arcanos-daemon": 0, f"/jobs/{job_id}/result": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.respond()

        def respond(self):
            if self.path in counters:
                index = counters[self.path] % 5
                counters[self.path] += 1
                body = malformed[index] if index < 4 else json.dumps(accepted if self.command == "POST" else pending).encode()
            else:
                body = json.dumps(pending).encode() if self.path.startswith("/jobs/") else b"not-json"
            self.send_response(202 if self.command == "POST" else 200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.path == "/jobs/slow-observer/result":
                for chunk in body:
                    try:
                        self.wfile.write(bytes([chunk]))
                        self.wfile.flush()
                    except OSError:
                        break
                    time.sleep(0.06)
            else:
                self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    case = tmp_path / "case"
    env = clean_env(case, repository, base_url, extra={
        "BACKEND_TOKEN": "synthetic-observer-writing-credential-1234567890",
        "CONVERSATION_RECOVERY_ENABLED": "false",
    })
    env["PYTHONPATH"] += os.pathsep + str(repository / "tests/fixtures")
    scenario = case / "scenario.json"
    scenario.write_text(json.dumps({"credentials": {"gpt": env["BACKEND_TOKEN"]}}), encoding="utf-8")
    env["ACCEPTANCE_NATIVE_SCENARIO"] = str(scenario)
    child = r'''
from contextlib import redirect_stdout
import io, json, os, time
from pathlib import Path
from urllib.parse import urlsplit
import arcanos.env as runtime_env
runtime_env._BOOTSTRAPPED = True
runtime_env._BASE_DIR = Path(os.environ["DATA_DIR"])
with redirect_stdout(io.StringIO()):
    import requests
    from daemon_registry_client import install_native_observers
    from arcanos.backend_client import BackendApiClient
    from arcanos.backend_client_models import BackendChatContinuation
    install_native_observers()
    original_json = requests.Response.json
    json_calls = {}
    def counted_json(response, *args, **kwargs):
        path = urlsplit(response.url).path
        json_calls[path] = json_calls.get(path, 0) + 1
        return original_json(response, *args, **kwargs)
    requests.Response.json = counted_json
    base = os.environ["BACKEND_URL"]
    job = "51883102-2222-4222-8222-222222222222"
    capability = "v1." + "R" * 43
    direct = []
    for method, path in (("post", "/gpt/arcanos-daemon"), ("get", f"/jobs/{job}/result")):
        for index in range(5):
            try:
                response = requests.request(method, base + path)
                direct.append({"path": path, "index": index, "status": response.status_code,
                               "body": response.text if index < 4 else "valid-object", "error": None})
            except Exception as error:
                direct.append({"path": path, "index": index, "error": type(error).__name__})
    client = BackendApiClient(base, lambda: os.environ["BACKEND_TOKEN"])
    parsed = []
    for operation in ("chat", "result"):
        for index in range(5):
            try:
                response = client.request_chat_completion([{"role":"user","content":"synthetic question"}]) if operation == "chat" else client.request_chat_job_result(BackendChatContinuation(job, capability))
                parsed.append({"operation": operation, "index": index, "kind": response.error.kind,
                               "continuation": response.error.continuation is not None})
            except Exception as error:
                parsed.append({"operation": operation, "index": index, "raised": type(error).__name__})
    requests.get(base + "/unobserved")
    started = time.monotonic()
    streamed = requests.get(base + "/jobs/slow-observer/result", stream=True)
    stream_header_seconds = time.monotonic() - started
    stream_json_calls = json_calls.get("/jobs/slow-observer/result", 0)
    streamed.close()
    observations = Path(os.environ["ACCEPTANCE_CASE_ROOT"]) / "observations.jsonl"
    observed = [json.loads(line) for line in observations.read_text(encoding="utf-8").splitlines()]
    observations.unlink()
    observations.mkdir()
    observation_write_error = None
    try:
        requests.get(base + "/jobs/metadata-fixture/result")
    except Exception as error:
        observation_write_error = type(error).__name__
print(json.dumps({"direct": direct, "parsed": parsed, "json_calls": json_calls,
                  "observed": observed, "observation_write_error": observation_write_error,
                  "stream_header_seconds": stream_header_seconds, "stream_json_calls": stream_json_calls}))
'''
    try:
        result = subprocess.run([sys.executable, "-B", "-c", child], env=env, cwd=case,
                                capture_output=True, text=True, encoding="utf-8", timeout=30)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert result.returncode == 0, result.stderr
    receipt = json.loads(result.stdout)
    assert all(row["error"] is None for row in receipt["direct"]), receipt["direct"]
    assert [row["status"] for row in receipt["direct"]] == [202] * 5 + [200] * 5
    assert [row["body"] for row in receipt["direct"][:4]] == [body.decode() for body in malformed]
    assert [row["kind"] for row in receipt["parsed"]] == ["pending"] * 5 + ["parse"] * 4 + ["pending"]
    assert [row["continuation"] for row in receipt["parsed"]] == [False] * 4 + [True] + [False] * 4 + [True]
    assert receipt["json_calls"] == {"/gpt/arcanos-daemon": 15, f"/jobs/{job_id}/result": 15,
                                      "/jobs/metadata-fixture/result": 1}
    assert receipt["observation_write_error"] is None
    assert receipt["stream_header_seconds"] < 1
    assert receipt["stream_json_calls"] == 0
    assert sum(row["event"] == "accepted_response" and row["valid_capability"] for row in receipt["observed"]) == 2
    assert capability not in result.stdout
    assert counters == {"/gpt/arcanos-daemon": 10, f"/jobs/{job_id}/result": 10}
