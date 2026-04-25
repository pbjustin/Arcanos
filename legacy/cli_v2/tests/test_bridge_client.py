import sys
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge.client import BackendClient


class FakeResponse:
    def __init__(self, status_code, text, url="https://backend.example.com/gpt/arcanos-daemon"):
        self.status_code = status_code
        self.text = text
        self.url = url

    def json(self):
        import json

        return json.loads(self.text)

    def raise_for_status(self):
        raise AssertionError("raise_for_status must not be called before reading the body")


def make_runtime():
    return SimpleNamespace(
        backend_url="https://backend.example.com",
        runtime_version="2.0.0",
        schema_version="1.0.0",
        trace_id="trace_test_bridge",
        mode="CONNECTED",
    )


def test_bridge_preserves_structured_non_2xx_backend_body(monkeypatch):
    response = FakeResponse(
        503,
        '{"ok":false,"traceId":"trace_prod","error":{"code":"OPENAI_API_KEY_MISSING"}}',
    )

    monkeypatch.setattr("bridge.client.requests.post", lambda *args, **kwargs: response)

    runtime = make_runtime()
    result = BackendClient(runtime).analyze({"task": "diagnostics"}, [])

    assert runtime.mode == "DEGRADED"
    assert result.meta["status"] == 503
    assert result.meta["url"] == "https://backend.example.com/gpt/arcanos-daemon"
    assert result.meta["body"]["traceId"] == "trace_prod"
    assert result.meta["body"]["error"]["code"] == "OPENAI_API_KEY_MISSING"
    assert "OPENAI_API_KEY_MISSING" in result.result


def test_bridge_preserves_plain_text_non_2xx_backend_body(monkeypatch):
    response = FakeResponse(502, "upstream gateway failure")
    monkeypatch.setattr("bridge.client.requests.post", lambda *args, **kwargs: response)

    runtime = make_runtime()
    result = BackendClient(runtime).analyze({"task": "diagnostics"}, [])

    assert runtime.mode == "DEGRADED"
    assert result.meta == {
        "status": 502,
        "url": "https://backend.example.com/gpt/arcanos-daemon",
        "body": "upstream gateway failure",
    }
    assert "upstream gateway failure" in result.result


def test_bridge_still_parses_success_response(monkeypatch):
    response = FakeResponse(
        200,
        '{"result":"ok","contract_version":"1.0.0","actions":[],"module":"test"}',
    )
    monkeypatch.setattr("bridge.client.requests.post", lambda *args, **kwargs: response)

    runtime = make_runtime()
    result = BackendClient(runtime).analyze({"task": "diagnostics"}, [])

    assert runtime.mode == "CONNECTED"
    assert result.result == "ok"
    assert result.module == "test"
