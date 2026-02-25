"""Tests for canonical Python OpenAI adapter module."""

from __future__ import annotations

from types import SimpleNamespace

from arcanos.openai import openai_adapter


def make_response(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        output=[
            SimpleNamespace(
                type="message",
                content=[SimpleNamespace(type="output_text", text=text)],
            )
        ],
        usage=SimpleNamespace(input_tokens=11, output_tokens=7, total_tokens=18),
    )


def test_chat_completion_uses_responses_adapter_boundary(monkeypatch):
    """chat_completion should route to client responses create with expected payload."""

    calls = []

    class FakeResponses:
        def create(self, **kwargs):
            calls.append(kwargs)
            return make_response("hello from responses")

    fake_client = SimpleNamespace(responses=FakeResponses())

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    result = openai_adapter.chat_completion(
        user_message="hello",
        system_prompt="system",
        temperature=0.2,
        max_tokens=128,
        model="gpt-test",
    )

    assert len(calls) == 1
    assert calls[0]["model"] == "gpt-test"
    assert calls[0]["input"][-1]["content"][0]["text"] == "hello"
    assert calls[0]["timeout"] > 0
    assert result.choices[0].message.content == "hello from responses"
    assert result.usage.total_tokens == 18


def test_vision_completion_uses_responses_adapter_boundary(monkeypatch):
    """vision_completion should route converted multimodal payload through responses API."""

    calls = []

    class FakeResponses:
        def create(self, **kwargs):
            calls.append(kwargs)
            return make_response("vision ok")

    fake_client = SimpleNamespace(responses=FakeResponses())

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    result = openai_adapter.vision_completion(
        user_message="describe image",
        image_base64="ZmFrZQ==",
        model="gpt-vision-test",
    )

    assert result.choices[0].message.content == "vision ok"
    assert len(calls) == 1
    assert calls[0]["model"] == "gpt-vision-test"
    assert calls[0]["input"][0]["content"][1]["type"] == "input_image"
    assert calls[0]["input"][0]["content"][1]["image_url"].startswith("data:image/png;base64,")


def test_transcribe_wraps_audio_bytes_as_named_file(monkeypatch):
    """transcribe should pass a named in-memory file to transcription client."""

    calls = []

    class FakeTranscriptions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(text="ok")

    fake_client = SimpleNamespace(
        audio=SimpleNamespace(transcriptions=FakeTranscriptions()),
    )

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    response = openai_adapter.transcribe(b"audio-bytes", filename="sample.wav")

    assert response.text == "ok"
    assert len(calls) == 1
    assert calls[0]["file"].name == "sample.wav"
    assert calls[0]["model"] is not None


def test_chat_completion_preserves_explicit_zero_generation_values(monkeypatch):
    """chat_completion should preserve explicit 0/0.0 generation overrides."""

    calls = []

    class FakeResponses:
        def create(self, **kwargs):
            calls.append(kwargs)
            return make_response("zero")

    fake_client = SimpleNamespace(responses=FakeResponses())

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    result = openai_adapter.chat_completion(
        user_message="zero override",
        temperature=0.0,
        max_tokens=0,
    )

    assert result.choices[0].message.content == "zero"
    assert len(calls) == 1
    assert calls[0]["temperature"] == 0.0
    assert calls[0]["max_output_tokens"] == 0


def test_chat_stream_preserves_explicit_zero_generation_values(monkeypatch):
    """chat_stream should preserve explicit 0/0.0 generation overrides."""

    calls = []

    class FakeResponses:
        def create(self, **kwargs):
            calls.append(kwargs)
            return [
                SimpleNamespace(type="response.output_text.delta", delta="stream-chunk"),
                SimpleNamespace(type="response.completed", response=make_response("stream final")),
            ]

    fake_client = SimpleNamespace(responses=FakeResponses())

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    stream = list(
        openai_adapter.chat_stream(
            user_message="zero override stream",
            temperature=0.0,
            max_tokens=0,
        )
    )

    assert len(calls) == 1
    assert calls[0]["temperature"] == 0.0
    assert calls[0]["max_output_tokens"] == 0
    assert stream[0].choices[0].delta.content == "stream-chunk"
    assert stream[1].usage.total_tokens == 18


def test_vision_completion_preserves_explicit_zero_generation_values(monkeypatch):
    """vision_completion should preserve explicit 0/0.0 generation overrides."""

    calls = []

    class FakeResponses:
        def create(self, **kwargs):
            calls.append(kwargs)
            return make_response("vision zero")

    fake_client = SimpleNamespace(responses=FakeResponses())

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    result = openai_adapter.vision_completion(
        user_message="describe image",
        image_base64="ZmFrZQ==",
        temperature=0.0,
        max_tokens=0,
    )

    assert result.choices[0].message.content == "vision zero"
    assert len(calls) == 1
    assert calls[0]["temperature"] == 0.0
    assert calls[0]["max_output_tokens"] == 0
