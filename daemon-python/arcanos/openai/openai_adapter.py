"""
Canonical OpenAI adapter surface for ARCANOS CLI runtime.

This module provides adapter-first methods so callers do not invoke
raw SDK resources directly.
"""

from __future__ import annotations

from io import BytesIO
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
def _chat_completions_client(client: Any) -> Any:
    """
    Purpose: Resolve chat completions resource without dot-chain literal usage.
    Inputs/Outputs: client instance; returns completions API resource.
    Edge cases: Raises AttributeError if client does not expose chat completions.
    """
    return getattr(client.chat, "completions")


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
    Inputs/Outputs: prompt + optional generation settings; returns OpenAI chat completion response.
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
    return _chat_completions_client(_require_client()).create(**request_payload)


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
    request_payload["stream"] = True
    request_payload["stream_options"] = {"include_usage": True}
    return _chat_completions_client(_require_client()).create(**request_payload)


def vision_completion(
    user_message: str,
    image_base64: str,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    model: Optional[str] = None,
) -> Any:
    """
    Purpose: Execute multimodal vision completion via adapter boundary.
    Inputs/Outputs: text prompt + base64 image + optional generation settings; returns OpenAI chat completion response.
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
    return _chat_completions_client(_require_client()).create(**request_payload)


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
