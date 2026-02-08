"""Tests for canonical Python OpenAI adapter module."""

from __future__ import annotations

from types import SimpleNamespace

from arcanos.openai import openai_adapter


def test_chat_completion_uses_adapter_boundary(monkeypatch):
    """chat_completion should route to client.chat.completions.create with expected payload."""

    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return {"ok": True, "payload": kwargs}

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=FakeCompletions()),
    )

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    result = openai_adapter.chat_completion(
        user_message="hello",
        system_prompt="system",
        temperature=0.2,
        max_tokens=128,
        model="gpt-test",
    )

    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0]["model"] == "gpt-test"
    assert calls[0]["messages"][-1]["content"] == "hello"
    assert calls[0]["timeout"] > 0


def test_vision_completion_uses_adapter_boundary(monkeypatch):
    """vision_completion should route vision payload through chat completions."""

    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return {"ok": True}

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=FakeCompletions()),
    )

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    result = openai_adapter.vision_completion(
        user_message="describe image",
        image_base64="ZmFrZQ==",
        model="gpt-vision-test",
    )

    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0]["model"] == "gpt-vision-test"
    assert calls[0]["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")


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
    assert calls[0]["model"]


def test_chat_completion_preserves_explicit_zero_generation_values(monkeypatch):
    """chat_completion should preserve explicit 0/0.0 generation overrides."""

    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return {"ok": True}

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=FakeCompletions()),
    )

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    result = openai_adapter.chat_completion(
        user_message="zero override",
        temperature=0.0,
        max_tokens=0,
    )

    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0]["temperature"] == 0.0
    assert calls[0]["max_tokens"] == 0


def test_chat_stream_preserves_explicit_zero_generation_values(monkeypatch):
    """chat_stream should preserve explicit 0/0.0 generation overrides."""

    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return []

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=FakeCompletions()),
    )

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    stream = openai_adapter.chat_stream(
        user_message="zero override stream",
        temperature=0.0,
        max_tokens=0,
    )

    assert stream == []
    assert len(calls) == 1
    assert calls[0]["temperature"] == 0.0
    assert calls[0]["max_tokens"] == 0


def test_vision_completion_preserves_explicit_zero_generation_values(monkeypatch):
    """vision_completion should preserve explicit 0/0.0 generation overrides."""

    calls = []

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return {"ok": True}

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=FakeCompletions()),
    )

    monkeypatch.setattr(openai_adapter, "_require_client", lambda: fake_client)

    result = openai_adapter.vision_completion(
        user_message="describe image",
        image_base64="ZmFrZQ==",
        temperature=0.0,
        max_tokens=0,
    )

    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0]["temperature"] == 0.0
    assert calls[0]["max_tokens"] == 0
