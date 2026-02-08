"""
OpenAI utilities for ARCANOS CLI Agent.
"""

from .openai_adapter import (
    chat_completion,
    chat_stream,
    vision_completion,
    transcribe,
    embeddings,
)
from .unified_client import (
    API_TIMEOUT_MS_DEFAULT,
    ClientOptions,
    HealthStatus,
    create_openai_client,
    get_client,
    get_default_model,
    get_fallback_model,
    get_gpt5_model,
    get_openai_key_source,
    get_or_create_client,
    has_valid_api_key,
    reset_client,
    resolve_openai_base_url,
    resolve_openai_key,
    validate_client_health,
)

__all__ = [
    "API_TIMEOUT_MS_DEFAULT",
    "ClientOptions",
    "HealthStatus",
    "chat_completion",
    "chat_stream",
    "create_openai_client",
    "embeddings",
    "get_client",
    "get_default_model",
    "get_fallback_model",
    "get_gpt5_model",
    "get_openai_key_source",
    "get_or_create_client",
    "has_valid_api_key",
    "reset_client",
    "resolve_openai_base_url",
    "resolve_openai_key",
    "transcribe",
    "validate_client_health",
    "vision_completion",
]
