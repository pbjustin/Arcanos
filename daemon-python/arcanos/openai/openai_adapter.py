"""
Canonical OpenAI adapter surface for ARCANOS CLI runtime.

This module provides adapter-first methods so callers do not invoke
raw SDK resources directly.
"""

from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace
from typing import Any, Dict, Iterable, Optional, Union

from ..config import Config
from .request_builders import (
    build_chat_completion_request,
    build_embedding_request,
    build_transcription_request,
    build_vision_request,
)
from .unified_client import get_or_create_client


def _require_client() -> Any:
    """
    Purpose: Resolve singleton OpenAI client from unified client boundary.
    Inputs/Outputs: no inputs; returns initialized OpenAI client instance.
    Edge cases: Raises RuntimeError when client cannot be initialized.
    """
    client = get_or_create_client(Config)
    #audit Assumption: adapter methods require initialized singleton client; risk: deferred None dereference; invariant: non-null client before API call; handling: raise explicit runtime error.
    if client is None:
        raise RuntimeError("OpenAI client is not initialized")
    return client


def _responses_client(client: Any) -> Any:
    """
    Purpose: Resolve responses API resource from the OpenAI client.
    Inputs/Outputs: client instance; returns responses API resource.
    Edge cases: Raises AttributeError if client does not expose responses.
    """
    return getattr(client, "responses")


def _read_attr(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _to_input_message(message: Dict[str, Any]) -> Dict[str, Any]:
    role = str(message.get("role") or "user")
    content = message.get("content")

    if isinstance(content, str):
        return {
            "role": role,
            "content": [{"type": "input_text", "text": content}],
        }

    if isinstance(content, list):
        converted_parts: list[Dict[str, Any]] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = part.get("type")
            if part_type == "text":
                text = part.get("text")
                if isinstance(text, str):
                    converted_parts.append({"type": "input_text", "text": text})
            elif part_type == "image_url":
                image_url = part.get("image_url")
                if isinstance(image_url, dict):
                    url = image_url.get("url")
                    if isinstance(url, str) and url:
                        image_part: Dict[str, Any] = {
                            "type": "input_image",
                            "image_url": url,
                        }
                        detail = image_url.get("detail")
                        if isinstance(detail, str) and detail:
                            image_part["detail"] = detail
                        converted_parts.append(image_part)

        if converted_parts:
            return {"role": role, "content": converted_parts}

    fallback_text = "" if content is None else str(content)
    return {
        "role": role,
        "content": [{"type": "input_text", "text": fallback_text}],
    }


def _to_responses_payload(chat_payload: Dict[str, Any], stream: bool = False) -> Dict[str, Any]:
    messages = chat_payload.get("messages") or []
    request_payload: Dict[str, Any] = {
        "model": chat_payload.get("model") or Config.OPENAI_MODEL,
        "input": [_to_input_message(message) for message in messages],
    }

    temperature = chat_payload.get("temperature")
    if temperature is not None:
        request_payload["temperature"] = temperature

    max_tokens = chat_payload.get("max_tokens")
    if max_tokens is not None:
        request_payload["max_output_tokens"] = max_tokens

    timeout = chat_payload.get("timeout")
    if timeout is not None:
        request_payload["timeout"] = timeout

    if stream:
        request_payload["stream"] = True

    return request_payload


def _extract_output_text(response: Any) -> str:
    direct_output_text = _read_attr(response, "output_text")
    if isinstance(direct_output_text, str) and direct_output_text.strip():
        return direct_output_text

    chunks: list[str] = []
    output_items = _read_attr(response, "output") or []
    for output_item in output_items:
        if _read_attr(output_item, "type") != "message":
            continue
        content_items = _read_attr(output_item, "content") or []
        for content_item in content_items:
            item_type = _read_attr(content_item, "type")
            if item_type not in {"output_text", "text"}:
                continue
            text_value = _read_attr(content_item, "text")
            if isinstance(text_value, str) and text_value:
                chunks.append(text_value)

    return "".join(chunks)


def _extract_usage(response: Any) -> Any:
    usage = _read_attr(response, "usage") or {}

    input_tokens = _read_attr(usage, "input_tokens")
    if input_tokens is None:
        input_tokens = _read_attr(usage, "prompt_tokens")

    output_tokens = _read_attr(usage, "output_tokens")
    if output_tokens is None:
        output_tokens = _read_attr(usage, "completion_tokens")

    total_tokens = _read_attr(usage, "total_tokens")

    prompt_tokens_value = int(input_tokens or 0)
    completion_tokens_value = int(output_tokens or 0)
    total_tokens_value = int(total_tokens or (prompt_tokens_value + completion_tokens_value))

    return SimpleNamespace(
        total_tokens=total_tokens_value,
        prompt_tokens=prompt_tokens_value,
        completion_tokens=completion_tokens_value,
    )


def _to_chat_completion_shape(response: Any) -> Any:
    text = _extract_output_text(response)
    usage = _extract_usage(response)

    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=usage,
        raw_response=response,
    )


def _to_stream_delta_chunk(text_delta: str) -> Any:
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=SimpleNamespace(content=text_delta))],
        usage=None,
    )


def _to_stream_usage_chunk(response: Any) -> Any:
    return SimpleNamespace(choices=[], usage=_extract_usage(response))


def chat_completion(
    user_message: str,
    system_prompt: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    conversation_history: Optional[list[dict[str, str]]] = None,
    model: Optional[str] = None,
) -> Any:
    """
    Purpose: Execute non-streaming chat completion via adapter boundary.
    Inputs/Outputs: prompt + optional generation settings; returns chat-completion-shaped response.
    Edge cases: Uses Config defaults when optional values are omitted.
    """
    # //audit assumption: callers may intentionally pass explicit zero values; risk: truthy fallback overrides 0/0.0; invariant: only None should trigger defaults; handling: explicit None checks before request build.
    resolved_temperature = Config.TEMPERATURE if temperature is None else temperature
    resolved_max_tokens = Config.MAX_TOKENS if max_tokens is None else max_tokens

    request_payload: Dict[str, Any] = build_chat_completion_request(
        prompt=user_message,
        system_prompt=system_prompt,
        model=model or Config.OPENAI_MODEL,
        max_tokens=resolved_max_tokens,
        temperature=resolved_temperature,
        conversation_history=conversation_history,
    )
    request_payload["timeout"] = Config.REQUEST_TIMEOUT

    response = _responses_client(_require_client()).create(
        **_to_responses_payload(request_payload, stream=False)
    )
    return _to_chat_completion_shape(response)


def chat_stream(
    user_message: str,
    system_prompt: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    conversation_history: Optional[list[dict[str, str]]] = None,
    model: Optional[str] = None,
) -> Iterable[Any]:
    """
    Purpose: Execute streaming chat completion via adapter boundary.
    Inputs/Outputs: prompt + optional generation settings; returns iterable stream chunks.
    Edge cases: Includes usage stats in final stream chunk for token accounting.
    """
    # //audit assumption: stream callers may pass explicit zero values for deterministic tests/limits; risk: truthy fallback masks explicit intent; invariant: only None resolves to defaults; handling: explicit None checks.
    resolved_temperature = Config.TEMPERATURE if temperature is None else temperature
    resolved_max_tokens = Config.MAX_TOKENS if max_tokens is None else max_tokens

    request_payload: Dict[str, Any] = build_chat_completion_request(
        prompt=user_message,
        system_prompt=system_prompt,
        model=model or Config.OPENAI_MODEL,
        max_tokens=resolved_max_tokens,
        temperature=resolved_temperature,
        conversation_history=conversation_history,
    )
    request_payload["timeout"] = Config.REQUEST_TIMEOUT

    stream = _responses_client(_require_client()).create(
        **_to_responses_payload(request_payload, stream=True)
    )

    def _iterate_stream() -> Iterable[Any]:
        saw_completed_event = False
        for event in stream:
            event_type = _read_attr(event, "type")
            if event_type == "response.output_text.delta":
                delta = _read_attr(event, "delta")
                if isinstance(delta, str) and delta:
                    yield _to_stream_delta_chunk(delta)
            elif event_type == "response.completed":
                completed_response = _read_attr(event, "response")
                if completed_response is not None:
                    saw_completed_event = True
                    yield _to_stream_usage_chunk(completed_response)

        if not saw_completed_event and _read_attr(stream, "response") is not None:
            yield _to_stream_usage_chunk(_read_attr(stream, "response"))

    return _iterate_stream()


def vision_completion(
    user_message: str,
    image_base64: str,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    model: Optional[str] = None,
) -> Any:
    """
    Purpose: Execute multimodal vision completion via adapter boundary.
    Inputs/Outputs: text prompt + base64 image + optional generation settings; returns chat-completion-shaped response.
    Edge cases: Defaults to configured vision model when model override is omitted.
    """
    # //audit assumption: vision callers may explicitly pass 0/0.0 values; risk: truthy fallback erases explicit values; invariant: defaults apply only when parameter is omitted (None); handling: explicit None checks.
    resolved_temperature = Config.TEMPERATURE if temperature is None else temperature
    resolved_max_tokens = Config.MAX_TOKENS if max_tokens is None else max_tokens

    request_payload = build_vision_request(
        prompt=user_message,
        image_base64=image_base64,
        model=model or Config.OPENAI_VISION_MODEL,
        max_tokens=resolved_max_tokens,
        temperature=resolved_temperature,
    )
    request_payload["timeout"] = Config.REQUEST_TIMEOUT

    response = _responses_client(_require_client()).create(
        **_to_responses_payload(request_payload, stream=False)
    )
    return _to_chat_completion_shape(response)


def transcribe(
    audio_bytes: bytes,
    filename: str = "speech.wav",
    model: Optional[str] = None,
) -> Any:
    """
    Purpose: Execute audio transcription via adapter boundary.
    Inputs/Outputs: raw audio bytes + filename/model; returns OpenAI transcription response.
    Edge cases: Bytes are wrapped into in-memory file object with provided filename.
    """
    audio_file = BytesIO(audio_bytes)
    audio_file.name = filename

    request_payload = build_transcription_request(
        audio_file=audio_file,
        filename=filename,
        model=model or Config.OPENAI_TRANSCRIBE_MODEL,
    )
    request_payload["timeout"] = Config.REQUEST_TIMEOUT
    return _require_client().audio.transcriptions.create(**request_payload)


def embeddings(
    input_text: Union[str, list[str]],
    model: str = "text-embedding-3-small",
    user: Optional[str] = None,
) -> Any:
    """
    Purpose: Execute embedding generation via adapter boundary.
    Inputs/Outputs: embedding input + optional model/user; returns OpenAI embedding response.
    Edge cases: Supports single string or list-of-strings payloads.
    """
    request_payload = build_embedding_request(
        input_text=input_text,
        model=model,
        user=user,
    )
    return _require_client().embeddings.create(**request_payload)
