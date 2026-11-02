"""Exercise the installed SDK with in-memory transport, never a provider."""

from __future__ import annotations

import asyncio
import importlib
import json

import openai
import pytest
from packaging.version import Version

from arcanos.config import Config
from arcanos.gpt_client import GPTClient
from arcanos.openai import openai_adapter, unified_client
from arcanos.openai.request_builders import extract_response_text


# SDK 3 changed its default transport; exercise that transport on each major.
http = importlib.import_module(
    "httpx2" if Version(openai.__version__).major >= 3 else "httpx"
)


def response_body():
    return {
        "id": "resp-synthetic",
        "object": "response",
        "created_at": 1,
        "model": "gpt-test",
        "status": "completed",
        "output": [{
            "id": "msg-synthetic",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": "Synthetic answer", "annotations": []}],
        }],
        "usage": {"input_tokens": 2, "output_tokens": 3, "total_tokens": 5},
    }


def stream_body():
    events = [
        {"type": "response.output_text.delta", "delta": "Synthetic answer", "item_id": "msg-synthetic", "output_index": 0, "content_index": 0, "sequence_number": 1},
        {"type": "response.completed", "response": response_body(), "sequence_number": 2},
    ]
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()


def test_canonical_constructor_uses_sdk_default_transport(monkeypatch):
    monkeypatch.setattr(Config, "OPENAI_MODEL", "gpt-test")
    client = unified_client.create_openai_client(unified_client.ClientOptions(
        api_key="test-sdk-compatibility-key",
        base_url="https://provider.invalid/v1", timeout=1250,
    ), config=Config)
    assert client is not None
    try:
        assert isinstance(client._client, http.Client)
        assert client.timeout == 1.25
        assert client.max_retries == 2
    finally:
        client.close()


@pytest.fixture
def sdk_client(monkeypatch):
    requests = []
    replies = []

    def handle(request):
        requests.append(request)
        reply = replies.pop(0) if replies else http.Response(200, json=response_body())
        if isinstance(reply, Exception):
            raise reply
        return reply

    transport_client = http.Client(transport=http.MockTransport(handle))
    sdk_constructor = openai.OpenAI
    constructor_options = []

    def construct(**kwargs):
        constructor_options.append(kwargs)
        return sdk_constructor(http_client=transport_client, **kwargs)

    monkeypatch.setattr(unified_client, "OpenAI", construct)
    monkeypatch.setattr(Config, "OPENAI_API_KEY", "test-sdk-compatibility-key")
    monkeypatch.setattr(Config, "OPENAI_BASE_URL", "https://provider.invalid/v1")
    monkeypatch.setattr(Config, "OPENAI_MODEL", "gpt-test")
    # Keep retry ownership/count real without sleeping on synthetic failures.
    monkeypatch.setattr("openai._base_client.time.sleep", lambda seconds: None)
    unified_client.reset_client()
    client = unified_client.get_or_create_client(Config)
    assert client is not None
    assert unified_client.get_or_create_client(Config) is client
    yield client, requests, replies, constructor_options
    client.close()
    unified_client.reset_client()


def test_canonical_constructor_and_responses_round_trip(sdk_client):
    client, requests, _, options = sdk_client
    result = openai_adapter.chat_completion(
        "current question", system_prompt="synthetic instructions",
        conversation_history=[{"user": "previous question", "ai": "previous answer"}],
        temperature=0.0, max_tokens=32,
    )
    assert extract_response_text(result) == "Synthetic answer"
    assert result.usage.total_tokens == 5
    assert client.max_retries == 2
    assert options == [{"api_key": "test-sdk-compatibility-key", "timeout": 60.0, "base_url": "https://provider.invalid/v1"}]
    assert requests[0].url.path == "/v1/responses"
    payload = json.loads(requests[0].content)
    assert payload["input"][1]["content"][0] == {"type": "output_text", "text": "previous answer"}
    assert payload["instructions"] == "synthetic instructions"
    assert payload["temperature"] == 0.0
    assert payload["max_output_tokens"] == 32


def test_gpt_client_uses_real_sdk_response_and_usage(sdk_client):
    result, tokens, cost = GPTClient().ask("synthetic question")
    assert result == "Synthetic answer"
    assert tokens == 5
    assert cost > 0


def test_responses_stream_deserializes_typed_events(sdk_client, monkeypatch):
    _, requests, replies, _ = sdk_client
    monkeypatch.delenv("OPENAI_STORE", raising=False)
    replies.append(http.Response(200, headers={"content-type": "text/event-stream"}, content=stream_body()))
    with openai_adapter.chat_stream("synthetic question") as stream:
        events = list(stream)
    assert events[0].type == "response.output_text.delta"
    assert events[0].delta == "Synthetic answer"
    assert events[1].type == "response.completed"
    assert events[1].response.usage.total_tokens == 5
    assert json.loads(requests[0].content)["store"] is False


def test_vision_payload_passes_real_sdk(sdk_client):
    _, requests, _, _ = sdk_client
    result = openai_adapter.vision_completion("describe", "ZmFrZQ==")
    assert extract_response_text(result) == "Synthetic answer"
    assert json.loads(requests[0].content)["input"][0]["content"][1]["image_url"] == "data:image/png;base64,ZmFrZQ=="


def test_transcription_multipart_passes_real_sdk(sdk_client):
    _, requests, replies, _ = sdk_client
    replies.append(http.Response(200, json={"text": "Synthetic transcript"}))
    assert openai_adapter.transcribe(b"synthetic-audio", filename="synthetic.wav").text == "Synthetic transcript"
    assert requests[0].url.path == "/v1/audio/transcriptions"
    assert b"synthetic.wav" in requests[0].content


def test_embeddings_pass_real_sdk(sdk_client):
    _, requests, replies, _ = sdk_client
    replies.append(http.Response(200, json={"object": "list", "model": "text-embedding-3-small", "data": [{"object": "embedding", "index": 0, "embedding": [0.1]}], "usage": {"prompt_tokens": 1, "total_tokens": 1}}))
    assert openai_adapter.embeddings("synthetic").data[0].embedding == [0.1]
    assert requests[0].url.path == "/v1/embeddings"


@pytest.mark.parametrize("status,error_type,mapped_type,attempts", [
    (400, openai.BadRequestError, ValueError, 1),
    (401, openai.AuthenticationError, ValueError, 1),
    (404, openai.NotFoundError, ValueError, 1),
    (429, openai.RateLimitError, RuntimeError, 3),
    (500, openai.InternalServerError, RuntimeError, 3),
])
def test_error_taxonomy_mapping_and_retry_bound(sdk_client, status, error_type, mapped_type, attempts):
    _, requests, replies, _ = sdk_client
    body = {"error": {"message": "synthetic failure", "type": "synthetic_error", "code": "synthetic"}}
    replies.extend(http.Response(status, json=body) for _ in range(attempts))
    with pytest.raises(error_type):
        openai_adapter.chat_completion("synthetic question")
    assert len(requests) == attempts
    requests.clear()
    replies.extend(http.Response(status, json=body) for _ in range(attempts))
    with pytest.raises(mapped_type):
        GPTClient().ask("synthetic question")
    assert len(requests) == attempts


def test_connection_failure_mapping_and_retry_bound(sdk_client):
    _, requests, replies, _ = sdk_client
    replies.extend(http.ConnectError("synthetic connection failure") for _ in range(3))
    with pytest.raises(ConnectionError, match="Failed to connect"):
        GPTClient().ask("synthetic question")
    assert len(requests) == 3


def test_async_responses_and_stream_sdk_surface():
    """The daemon uses sync clients; check upstream async transport independently."""
    requests = []

    def handle(request):
        requests.append(request)
        if json.loads(request.content).get("stream"):
            return http.Response(200, headers={"content-type": "text/event-stream"}, content=stream_body())
        return http.Response(200, json=response_body())

    async def run():
        async with openai.AsyncOpenAI(api_key="test-sdk-key", base_url="https://provider.invalid/v1", http_client=http.AsyncClient(transport=http.MockTransport(handle))) as client:
            response = await client.responses.create(model="gpt-test", input="synthetic")
            assert response.output_text == "Synthetic answer"
            stream = await client.responses.create(model="gpt-test", input="synthetic", stream=True)
            async with stream:
                events = [event async for event in stream]
            assert events[0].delta == "Synthetic answer"
            assert events[1].response.usage.total_tokens == 5

    asyncio.run(run())
    assert len(requests) == 2
