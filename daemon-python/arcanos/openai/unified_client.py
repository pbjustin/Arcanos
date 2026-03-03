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
_OPENAI_KEY_PLACEHOLDERS = {"", "your-openai-api-key-here", "your-openai-key-here"}


def _normalize_secret_candidate(value: Optional[str]) -> Optional[str]:
    """
    Purpose: Normalize and validate secret-like string values.
    Inputs/Outputs: optional raw value; returns trimmed valid value or None.
    Edge cases: Placeholder values are treated as missing.
    """
    if not value:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if normalized.lower() in _OPENAI_KEY_PLACEHOLDERS:
        return None
    return normalized


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
        self.timeout = timeout or API_TIMEOUT_MS_DEFAULT
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
    Resolves OpenAI API key from Config.
    
    Args:
        config: Config instance (preferred). If None, uses module-level Config.
    
    Returns:
        API key string or None if not found
    """
    config_to_use = config or Config
    configured_key = _normalize_secret_candidate(getattr(config_to_use, "OPENAI_API_KEY", None))
    #audit Assumption: Config is canonical for runtime credentials; risk: hidden env drift; invariant: Config value preferred when present; handling: return normalized configured key.
    if configured_key:
        return configured_key
    return None


def resolve_openai_base_url(config: Optional[Config] = None) -> Optional[str]:
    """
    Resolves OpenAI base URL from Config.
    
    Args:
        config: Config instance (preferred). If None, uses module-level Config.
    
    Returns:
        Base URL string or None if not found
    """
    config_to_use = config or Config
    configured_url = getattr(config_to_use, "OPENAI_BASE_URL", None)
    if configured_url and configured_url.strip():
        return configured_url.strip()
    return None


def get_openai_key_source(config: Optional[Config] = None) -> Optional[str]:
    """
    Gets the source of the API key from Config.
    
    Args:
        config: Config instance (preferred). If None, checks module-level Config.
    
    Returns:
        Source identifier string or None
    """
    config_to_use = config or Config

    configured_key = _normalize_secret_candidate(getattr(config_to_use, "OPENAI_API_KEY", None))
    if configured_key:
        return "OPENAI_API_KEY"
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
        config: Config instance (preferred). If None, uses module-level Config hydration.
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
                extra={"operation": "createOpenAIClient", "component": "openai.unified"}
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
                "component": "openai.unified",
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
            extra={"component": "openai.unified", "operation": "createOpenAIClient"},
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
            extra={"component": "openai.unified", "operation": "getOrCreateClient"}
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
    
    record_trace_event("openai.client.reset", {"component": "openai.unified"})
    logger.info(
        "OpenAI client reset",
        extra={"component": "openai.unified", "operation": "resetClient"}
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


def get_gpt5_model(config: Optional[Config] = None) -> str:
    """
    Gets the GPT-5 model from Config.
    
    Args:
        config: Config instance (preferred). If None, uses module-level Config.
    
    Returns:
        GPT-5 model name string
    """
    config_to_use = config or Config
    gpt5_model = getattr(config_to_use, "GPT5_MODEL", None) or getattr(config_to_use, "GPT51_MODEL", None)
    if gpt5_model:
        return gpt5_model
    return "gpt-5.1"


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
