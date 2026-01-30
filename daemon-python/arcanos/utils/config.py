"""
Enhanced Configuration Utilities for Python CLI Agent

Enhances configuration utilities with Railway fallbacks and type-safe access.
Follows Railway-native patterns: stateless, deterministic, environment-variable-based.
"""

import os
from typing import Optional, List, Dict, Any
from ..config import Config
import logging

logger = logging.getLogger("arcanos.config")


def get_env_var(key: str, fallbacks: Optional[List[str]] = None) -> Optional[str]:
    """
    Resolves environment variable with Railway fallbacks.
    
    DEPRECATED: Use Config class directly instead of this function.
    This function is kept for backward compatibility but should be migrated to Config.
    
    Checks multiple environment variable names in priority order:
    1. Primary variable name
    2. Railway-prefixed variable name
    3. Fallback variable names (if provided)
    
    This ensures Railway-native configuration resolution.
    """
    # Prefer Config for known keys (adapter boundary pattern)
    if key == "OPENAI_API_KEY":
        return Config.OPENAI_API_KEY if Config.OPENAI_API_KEY else None
    
    # Fallback to os.getenv for backward compatibility (will be removed)
    primary_value = os.getenv(key)
    if primary_value and primary_value.strip():
        return primary_value.strip()
    
    # Check Railway-prefixed key
    railway_key = f"RAILWAY_{key}"
    railway_value = os.getenv(railway_key)
    if railway_value and railway_value.strip():
        return railway_value.strip()
    
    # Check fallback keys
    if fallbacks:
        for fallback in fallbacks:
            fallback_value = os.getenv(fallback)
            if fallback_value and fallback_value.strip():
                return fallback_value.strip()
    
    return None


def is_railway_environment() -> bool:
    """
    Checks if running in Railway environment.
    
    DEPRECATED: Use Config class or check Railway env vars directly.
    This function is kept for backward compatibility.
    
    Returns:
        True if running on Railway
    """
    # Use Config if available, fallback to env check
    # Note: Config doesn't expose isRailway yet, so check env directly
    return bool(
        os.getenv("RAILWAY_ENVIRONMENT") or
        os.getenv("RAILWAY_PROJECT_ID") or
        os.getenv("RAILWAY_SERVICE_NAME")
    )


def resolve_openai_key() -> Optional[str]:
    """
    Resolves OpenAI API key from Config (preferred) or Railway fallbacks.
    
    DEPRECATED: Use Config.OPENAI_API_KEY directly instead.
    """
    # Prefer Config (adapter boundary pattern)
    if Config.OPENAI_API_KEY:
        return Config.OPENAI_API_KEY
    
    # Fallback to env for backward compatibility
    return get_env_var("OPENAI_API_KEY", [
        "RAILWAY_OPENAI_API_KEY",
        "API_KEY",
        "OPENAI_KEY"
    ])


def resolve_openai_base_url() -> Optional[str]:
    """
    Resolves OpenAI base URL with Railway fallbacks.
    
    DEPRECATED: Config doesn't expose base URL yet, so this uses env fallback.
    """
    return get_env_var("OPENAI_BASE_URL", [
        "OPENAI_API_BASE_URL",
        "OPENAI_API_BASE"
    ])


def get_config() -> Dict[str, Any]:
    """
    Gets unified application configuration
    
    Resolves all configuration values with Railway fallbacks
    and provides type-safe access to configuration.
    """
    return {
        # Server Configuration
        "nodeEnv": os.getenv("NODE_ENV", "development"),
        "isRailway": is_railway_environment(),
        
        # OpenAI Configuration (prefer Config, fallback to env)
        "openaiApiKey": Config.OPENAI_API_KEY or resolve_openai_key(),
        "openaiBaseUrl": resolve_openai_base_url(),
        "defaultModel": Config.OPENAI_MODEL,  # Config is canonical
        "fallbackModel": getattr(Config, "FALLBACK_MODEL", None) or "gpt-4",
        "gpt5Model": get_env_var("GPT5_MODEL") or "gpt-5",
        "gpt51Model": get_env_var("GPT51_MODEL") or "gpt-5.1",
        
        # Railway Configuration (use Config when available)
        "railwayEnvironment": os.getenv("RAILWAY_ENVIRONMENT"),  # TODO: Add to Config
        "railwayProjectId": os.getenv("RAILWAY_PROJECT_ID")  # TODO: Add to Config
    }


def validate_config() -> Dict[str, Any]:
    """
    Validates application configuration
    
    Checks for required configuration values and provides
    warnings for missing optional but recommended values.
    
    Returns:
        Dictionary with 'valid', 'errors', and 'warnings' keys
    """
    errors: List[str] = []
    warnings: List[str] = []
    config = get_config()
    
    # Required configuration checks
    if not config["openaiApiKey"]:
        warnings.append("OPENAI_API_KEY not set - AI endpoints will return mock responses")
    
    # Railway-specific checks
    if config["isRailway"]:
        if not config["railwayEnvironment"]:
            warnings.append("RAILWAY_ENVIRONMENT not set - Railway environment detection may be incomplete")
        
        if not config["railwayProjectId"]:
            warnings.append("RAILWAY_PROJECT_ID not set - Railway project identification may be incomplete")
    
    # Log validation results
    if errors or warnings:
        if errors:
            logger.error(
                "Configuration validation failed",
                extra={"module": "config.unified", "errors": errors}
            )
        
        if warnings:
            logger.warning(
                "Configuration validation warnings",
                extra={"module": "config.unified", "warnings": warnings}
            )
    else:
        logger.info(
            "Configuration validation passed",
            extra={
                "module": "config.unified",
                "isRailway": config["isRailway"],
                "environment": config["nodeEnv"]
            }
        )
    
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings
    }


__all__ = [
    "get_env_var",
    "is_railway_environment",
    "resolve_openai_key",
    "resolve_openai_base_url",
    "get_config",
    "validate_config"
]
