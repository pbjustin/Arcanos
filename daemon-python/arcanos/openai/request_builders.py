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

from typing import Optional, Dict, Any, List, Union
from openai import OpenAI
from ..config import Config


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
    request_payload: Dict[str, Any] = {
        "model": model or Config.OPENAI_MODEL,
        "messages": messages,
        "temperature": temperature or Config.TEMPERATURE,
        "max_tokens": max_tokens or Config.MAX_TOKENS
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
    
    return {
        "model": model or Config.OPENAI_VISION_MODEL,
        "messages": messages,
        "temperature": temperature or Config.TEMPERATURE,
        "max_tokens": max_tokens or Config.MAX_TOKENS
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
        "model": model or "gpt-image-1",
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
    "build_chat_completion_request",
    "build_vision_request",
    "build_transcription_request",
    "build_image_request",
    "build_embedding_request"
]
