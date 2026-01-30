"""
Unified OpenAI Client Wrapper for Python CLI Agent

Provides consistent client initialization, credential resolution, and health checks
following OpenAI SDK best practices and Railway-native patterns.

Features:
- Railway-first credential resolution with fallbacks
- Stateless, deterministic initialization
- Health check capabilities
- Type-safe model selection
- Audit trail for all operations
"""

import os
from typing import Optional, Dict, Any
from datetime import datetime
from openai import OpenAI
from ..config import Config
from ..utils.telemetry import record_trace_event
import logging

logger = logging.getLogger("arcanos.openai")

# Singleton client instance
_singleton_client: Optional[OpenAI] = None
_initialization_attempted = False

# API timeout default (config should be injected)
API_TIMEOUT_MS_DEFAULT = 60000


class ClientOptions:
    """Client initialization options"""
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: Optional[int] = None,
        singleton: bool = True
    ):
        self.api_key = api_key
        self.base_url = base_url
        self.timeout = timeout or API_TIMEOUT_MS
        self.singleton = singleton


class HealthStatus:
    """Health status for OpenAI client"""
    def __init__(
        self,
        healthy: bool,
        api_key_configured: bool,
        api_key_source: Optional[str],
        default_model: str,
        fallback_model: str,
        error: Optional[str] = None
    ):
        self.healthy = healthy
        self.api_key_configured = api_key_configured
        self.api_key_source = api_key_source
        self.default_model = default_model
        self.fallback_model = fallback_model
        self.error = error
        self.last_check = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "healthy": self.healthy,
            "apiKeyConfigured": self.api_key_configured,
            "apiKeySource": self.api_key_source,
            "defaultModel": self.default_model,
            "fallbackModel": self.fallback_model,
            "error": self.error,
            "lastCheck": self.last_check
        }


def resolve_openai_key(config: Optional[Config] = None) -> Optional[str]:
    """
    Resolves OpenAI API key from Config (preferred) or environment fallback.
    
    Args:
        config: Config instance (preferred). If None, falls back to os.getenv for backward compatibility.
    
    Returns:
        API key string or None if not found
    """
    # Prefer Config if provided (adapter boundary pattern)
    if config:
        key = config.OPENAI_API_KEY
        if key and key.strip():
            normalized = key.strip().lower()
            # Skip placeholder values
            if normalized not in {"", "your-openai-api-key-here", "your-openai-key-here"}:
                return key.strip()
        return None
    
    # Fallback to env for backward compatibility (will be removed in future)
    key_priority = [
        "OPENAI_API_KEY",
        "RAILWAY_OPENAI_API_KEY",
        "API_KEY",
        "OPENAI_KEY"
    ]
    
    for key_name in key_priority:
        value = os.getenv(key_name)
        if value and value.strip():
            normalized = value.strip().lower()
            if normalized not in {"", "your-openai-api-key-here", "your-openai-key-here"}:
                return value.strip()
    
    return None


def resolve_openai_base_url(config: Optional[Config] = None) -> Optional[str]:
    """
    Resolves OpenAI base URL from Config (preferred) or environment fallback.
    
    Args:
        config: Config instance (preferred). If None, falls back to os.getenv for backward compatibility.
    
    Returns:
        Base URL string or None if not found
    """
    # Config doesn't have base URL yet, so fallback to env for now
    # TODO: Add base URL to Config class
    url_candidates = [
        os.getenv("OPENAI_BASE_URL"),
        os.getenv("OPENAI_API_BASE_URL"),
        os.getenv("OPENAI_API_BASE")
    ]
    
    for url in url_candidates:
        if url and url.strip():
            return url.strip()
    
    return None


def get_openai_key_source(config: Optional[Config] = None) -> Optional[str]:
    """
    Gets the source of the API key (from Config or env).
    
    Args:
        config: Config instance (preferred). If None, checks env for backward compatibility.
    
    Returns:
        Source identifier string or None
    """
    config_to_use = config or Config
    
    # If using Config and key is set, return Config source
    if config_to_use.OPENAI_API_KEY and config_to_use.OPENAI_API_KEY.strip():
        normalized = config_to_use.OPENAI_API_KEY.strip().lower()
        if normalized not in {"", "your-openai-api-key-here", "your-openai-key-here"}:
            return "OPENAI_API_KEY"  # Config always uses this key name
    
    # Fallback to env check for backward compatibility
    key_priority = [
        "OPENAI_API_KEY",
        "RAILWAY_OPENAI_API_KEY",
        "API_KEY",
        "OPENAI_KEY"
    ]
    
    for key_name in key_priority:
        value = os.getenv(key_name)
        if value and value.strip():
            normalized = value.strip().lower()
            if normalized not in {"", "your-openai-api-key-here", "your-openai-key-here"}:
                return key_name
    
    return None


def has_valid_api_key(config: Optional[Config] = None) -> bool:
    """
    Checks if a valid API key is configured
    
    Args:
        config: Config instance (preferred). If None, uses module-level Config.
    """
    config_to_use = config or Config
    return resolve_openai_key(config_to_use) is not None


def create_openai_client(options: Optional[ClientOptions] = None, config: Optional[Config] = None) -> Optional[OpenAI]:
    """
    Creates a new OpenAI client with config-based credential resolution
    
    This function follows adapter boundary pattern:
    - Accepts Config instance (preferred) or falls back to env
    - Stateless initialization (no local state dependencies)
    - Deterministic behavior (same inputs = same outputs)
    - Comprehensive error handling and logging
    
    Args:
        options: Client initialization options (optional)
        config: Config instance (preferred). If None, falls back to os.getenv for backward compatibility.
    """
    if options is None:
        options = ClientOptions()
    
    # Use Config if provided, otherwise use module-level Config
    config_to_use = config or Config
    
    trace_id = record_trace_event("openai.client.create.start", {
        "hasApiKeyOverride": bool(options.api_key),
        "hasBaseURLOverride": bool(options.base_url),
        "timeout": options.timeout
    })
    
    try:
        # Resolve API key from config (adapter boundary pattern)
        api_key = options.api_key or resolve_openai_key(config_to_use)
        
        if not api_key:
            logger.warning(
                "OpenAI API key not configured - AI endpoints will return mock responses",
                extra={"operation": "createOpenAIClient", "module": "openai.unified"}
            )
            record_trace_event("openai.client.create.no_key", {"traceId": trace_id})
            return None
        
        # Resolve base URL from config
        base_url = options.base_url or resolve_openai_base_url(config_to_use)
        timeout = options.timeout or API_TIMEOUT_MS_DEFAULT
        
        # Create client instance
        client_kwargs = {
            "api_key": api_key,
            "timeout": timeout / 1000.0  # Convert ms to seconds
        }
        
        if base_url:
            client_kwargs["base_url"] = base_url
        
        client = OpenAI(**client_kwargs)
        
        record_trace_event("openai.client.create.success", {
            "traceId": trace_id,
            "model": config_to_use.OPENAI_MODEL,
            "source": get_openai_key_source(config_to_use)
        })
        
        logger.info(
            "✅ OpenAI client created",
            extra={
                "module": "openai.unified",
                "operation": "createOpenAIClient",
                "model": config_to_use.OPENAI_MODEL,
                "source": get_openai_key_source(config_to_use)
            }
        )
        
        return client
    except Exception as error:
        error_message = str(error)
        logger.error(
            "❌ Failed to create OpenAI client",
            extra={"module": "openai.unified", "operation": "createOpenAIClient"},
            exc_info=error
        )
        
        record_trace_event("openai.client.create.error", {
            "traceId": trace_id,
            "error": error_message
        })
        
        return None


def get_or_create_client(config: Optional[Config] = None) -> Optional[OpenAI]:
    """
    Gets or creates the singleton OpenAI client
    
    Uses singleton pattern for consistent client reuse across the application.
    Initializes on first call with config-based credential resolution.
    
    Args:
        config: Config instance (preferred). If None, uses module-level Config.
    """
    global _singleton_client, _initialization_attempted
    
    if _singleton_client:
        return _singleton_client
    
    # Prevent multiple simultaneous initialization attempts
    if _initialization_attempted:
        logger.warning(
            "OpenAI client initialization already attempted, returning None",
            extra={"module": "openai.unified", "operation": "getOrCreateClient"}
        )
        return None
    
    config_to_use = config or Config
    _initialization_attempted = True
    _singleton_client = create_openai_client(ClientOptions(singleton=True), config=config_to_use)
    
    return _singleton_client


def validate_client_health() -> HealthStatus:
    """
    Validates OpenAI client health
    
    Performs comprehensive health check including:
    - API key configuration
    - Client initialization status
    """
    configured = has_valid_api_key()
    initialized = _singleton_client is not None
    
    health = HealthStatus(
        healthy=configured and initialized,
        api_key_configured=configured,
        api_key_source=get_openai_key_source(Config),
        default_model=Config.OPENAI_MODEL,
        fallback_model=getattr(Config, "FALLBACK_MODEL", "gpt-4"),
    )
    # Record the actual check time for observability
    health.last_check = datetime.now().isoformat()
    if not health.healthy:
        if not configured:
            health.error = "API key not configured"
        elif not initialized:
            health.error = "Client not initialized"
    
    return health


def reset_client() -> None:
    """
    Resets the singleton client
    
    Useful for testing or when credentials change.
    Clears singleton instance and allows re-initialization.
    """
    global _singleton_client, _initialization_attempted
    
    _singleton_client = None
    _initialization_attempted = False
    
    record_trace_event("openai.client.reset", {"module": "openai.unified"})
    logger.info(
        "OpenAI client reset",
        extra={"module": "openai.unified", "operation": "resetClient"}
    )


def get_client() -> Optional[OpenAI]:
    """
    Gets the current singleton client without creating a new one
    
    Returns:
        Current singleton client or None if not initialized
    """
    return _singleton_client


def get_default_model() -> str:
    """Gets the default model from configuration"""
    return Config.OPENAI_MODEL


def get_fallback_model() -> str:
    """Gets the fallback model from configuration"""
    return getattr(Config, "FALLBACK_MODEL", "gpt-4")


def get_gpt5_model() -> str:
    """Gets the GPT-5 model from environment"""
    return os.getenv("GPT51_MODEL") or os.getenv("GPT5_MODEL") or "gpt-5.1"


# Exports for backward compatibility
__all__ = [
    "create_openai_client",
    "get_or_create_client",
    "get_client",
    "validate_client_health",
    "reset_client",
    "get_default_model",
    "get_fallback_model",
    "get_gpt5_model",
    "has_valid_api_key",
    "get_openai_key_source",
    "resolve_openai_key",
    "resolve_openai_base_url",
    "API_TIMEOUT_MS_DEFAULT",
    "ClientOptions",
    "HealthStatus"
]
