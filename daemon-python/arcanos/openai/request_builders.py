"""
Standardized Request Builder Patterns for Python CLI Agent

Provides reusable request builders for all OpenAI API operations:
- Chat completions (with ARCANOS routing message)
- Vision requests
- Audio transcription
- Image generation
- Embeddings

Features:
- Railway-native patterns (stateless, deterministic)
- Consistent request structure
- Type-safe builders
- ARCANOS routing message injection
- Audit trail for all requests
"""

from typing import Any, Dict, List, Optional, Union

from ..config import Config


def _normalize_content_to_text(content: Any) -> str:
    """
    Purpose: Normalize mixed message content payloads into plain text.
    Inputs/Outputs: arbitrary message content -> normalized string.
    Edge cases: Unknown content parts resolve to empty strings.
    """
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        normalized_parts: List[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            #audit Assumption: text-like parts should preserve deterministic prompt content; risk: silent data loss in multimodal lists; invariant: text and input_text parts are extracted when present; handling: collect supported text fields only.
            if part.get("type") in {"text", "input_text"} and isinstance(part.get("text"), str):
                normalized_parts.append(part["text"])
        return "\n".join(part for part in normalized_parts if part)

    return ""


def extract_response_text(response: Any, fallback: str = "") -> str:
    """
    Purpose: Extract normalized text output from Responses API payloads.
    Inputs/Outputs: OpenAI response object -> output text string.
    Edge cases: Falls back to scanning output content when output_text shortcut is absent.
    """
    output_text = getattr(response, "output_text", None)
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    output = getattr(response, "output", None)
    if not isinstance(output, list):
        return fallback

    for item in output:
        if not isinstance(item, dict):
            continue
        content_list = item.get("content", [])
        if not isinstance(content_list, list):
            continue
        for content_item in content_list:
            if not isinstance(content_item, dict):
                continue
            if content_item.get("type") == "output_text" and isinstance(content_item.get("text"), str):
                candidate = content_item["text"].strip()
                if candidate:
                    return candidate
    return fallback


def build_responses_request(
    prompt: str,
    system_prompt: Optional[str] = None,
    model: Optional[str] = None,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    conversation_history: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """
    Purpose: Build canonical Responses API request payload for text interactions.
    Inputs/Outputs: prompt + generation controls -> responses.create payload.
    Edge cases: Missing history/system prompts degrade to single user message input.
    """
    resolved_temperature = Config.TEMPERATURE if temperature is None else temperature
    resolved_max_tokens = Config.MAX_TOKENS if max_tokens is None else max_tokens

    input_items: List[Dict[str, Any]] = []
    if conversation_history:
        for conversation_item in conversation_history[-5:]:
            #audit Assumption: conversation history keys follow user/ai schema; risk: malformed history breaks context reconstruction; invariant: only string values are emitted into response input; handling: guard each key before append.
            if isinstance(conversation_item.get("user"), str):
                input_items.append({
                    "role": "user",
                    "content": [{"type": "input_text", "text": conversation_item["user"]}]
                })
            if isinstance(conversation_item.get("ai"), str):
                input_items.append({
                    "role": "assistant",
                    "content": [{"type": "input_text", "text": conversation_item["ai"]}]
                })

    input_items.append({
        "role": "user",
        "content": [{"type": "input_text", "text": prompt}]
    })

    payload: Dict[str, Any] = {
        "model": model or Config.OPENAI_MODEL,
        "input": input_items,
        "temperature": resolved_temperature,
        "max_output_tokens": resolved_max_tokens,
    }

    if system_prompt:
        payload["instructions"] = system_prompt
    if top_p is not None:
        payload["top_p"] = top_p

    return payload


def build_vision_responses_request(
    prompt: str,
    image_base64: str,
    model: Optional[str] = None,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Purpose: Build canonical Responses API request payload for vision interactions.
    Inputs/Outputs: prompt + base64 image -> responses.create payload.
    Edge cases: Uses PNG data URL format when MIME metadata is unavailable.
    """
    resolved_temperature = Config.TEMPERATURE if temperature is None else temperature
    resolved_max_tokens = Config.MAX_TOKENS if max_tokens is None else max_tokens

    return {
        "model": model or Config.OPENAI_VISION_MODEL,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "image_url": f"data:image/png;base64,{image_base64}"},
                ],
            }
        ],
        "temperature": resolved_temperature,
        "max_output_tokens": resolved_max_tokens,
    }
def build_chat_completion_request(
    prompt: str,
    system_prompt: Optional[str] = None,
    model: Optional[str] = None,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    frequency_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    conversation_history: Optional[List[Dict[str, str]]] = None,
    include_routing_message: bool = True
) -> Dict[str, Any]:
    """
    Builds a chat completion request with ARCANOS routing message
    
    Automatically prepends ARCANOS routing message to ensure proper
    model routing and behavior. This is the standard way to create
    chat completion requests in the codebase.
    """
    # Build messages array
    messages: List[Dict[str, str]] = []
    
    # Add system prompt if provided
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    
    # Add conversation history
    if conversation_history:
        for conv in conversation_history[-5:]:  # Last 5 conversations
            if "user" in conv:
                messages.append({"role": "user", "content": conv["user"]})
            if "ai" in conv:
                messages.append({"role": "assistant", "content": conv["ai"]})
    
    # Add user prompt
    messages.append({"role": "user", "content": prompt})
    
    # Build request payload
    # //audit assumption: callers may intentionally pass 0/0.0 generation values; risk: truthy fallback would override explicit intent; invariant: defaults only when values are omitted (None); strategy: explicit None checks before payload construction.
    resolved_temperature = Config.TEMPERATURE if temperature is None else temperature
    resolved_max_tokens = Config.MAX_TOKENS if max_tokens is None else max_tokens

    request_payload: Dict[str, Any] = {
        "model": model or Config.OPENAI_MODEL,
        "messages": messages,
        "temperature": resolved_temperature,
        "max_tokens": resolved_max_tokens,
    }
    
    if top_p is not None:
        request_payload["top_p"] = top_p
    if frequency_penalty is not None:
        request_payload["frequency_penalty"] = frequency_penalty
    if presence_penalty is not None:
        request_payload["presence_penalty"] = presence_penalty
    
    return request_payload


def build_vision_request(
    prompt: str,
    image_base64: str,
    model: Optional[str] = None,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    detail: str = "auto"
) -> Dict[str, Any]:
    """
    Builds a vision request for image analysis
    
    Creates a properly formatted vision request with image data
    and user prompt.
    """
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/png;base64,{image_base64}",
                        "detail": detail
                    }
                }
            ]
        }
    ]
    
    # //audit assumption: explicit zero generation values can be intentional for deterministic behavior; risk: truthy fallback drops explicit value; invariant: defaults apply only for None; strategy: explicit None checks.
    resolved_temperature = Config.TEMPERATURE if temperature is None else temperature
    resolved_max_tokens = Config.MAX_TOKENS if max_tokens is None else max_tokens

    return {
        "model": model or Config.OPENAI_VISION_MODEL,
        "messages": messages,
        "temperature": resolved_temperature,
        "max_tokens": resolved_max_tokens,
    }


def build_transcription_request(
    audio_file: Any,  # File-like object or bytes
    filename: str,
    model: Optional[str] = None,
    language: Optional[str] = None,
    response_format: str = "json",
    temperature: Optional[float] = None
) -> Dict[str, Any]:
    """
    Builds a transcription request for audio processing
    
    Creates a properly formatted transcription request with audio file.
    """
    request_params: Dict[str, Any] = {
        "file": audio_file,
        "model": model or Config.OPENAI_TRANSCRIBE_MODEL,
        "response_format": response_format
    }
    
    if language:
        request_params["language"] = language
    
    if temperature is not None:
        request_params["temperature"] = temperature
    
    return request_params


def build_image_request(
    prompt: str,
    size: str = "1024x1024",
    model: Optional[str] = None,
    quality: str = "standard",
    n: int = 1,
    response_format: str = "b64_json"
) -> Dict[str, Any]:
    """
    Builds an image generation request
    
    Creates a properly formatted image generation request.
    """
    return {
        # Prefer configurable image model when available, fall back to
        # the default literal used in main.
        "model": model or Config.OPENAI_IMAGE_MODEL,
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "n": n,
        "response_format": response_format
    }


def build_embedding_request(
    input_text: Union[str, List[str]],
    model: str = "text-embedding-3-small",
    user: Optional[str] = None
) -> Dict[str, Any]:
    """
    Builds an embedding request
    
    Creates a properly formatted embedding request.
    """
    request_params: Dict[str, Any] = {
        "model": model,
        "input": input_text
    }
    
    if user:
        request_params["user"] = user
    
    return request_params


__all__ = [
    "_normalize_content_to_text",
    "extract_response_text",
    "build_responses_request",
    "build_vision_responses_request",
    "build_chat_completion_request",
    "build_vision_request",
    "build_transcription_request",
    "build_image_request",
    "build_embedding_request"
]
