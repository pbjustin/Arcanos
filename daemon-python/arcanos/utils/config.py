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
    Resolves environment variable with Railway fallbacks
    
    Checks multiple environment variable names in priority order:
    1. Primary variable name
    2. Railway-prefixed variable name
    3. Fallback variable names (if provided)
    
    This ensures Railway-native configuration resolution.
    """
    # Check primary key
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
    Checks if running in Railway environment
    
    Returns:
        True if running on Railway
    """
    return bool(
        os.getenv("RAILWAY_ENVIRONMENT") or
        os.getenv("RAILWAY_PROJECT_ID") or
        os.getenv("RAILWAY_SERVICE_NAME")
    )


def resolve_openai_key() -> Optional[str]:
    """Resolves OpenAI API key with Railway fallbacks"""
    return get_env_var("OPENAI_API_KEY", [
        "RAILWAY_OPENAI_API_KEY",
        "API_KEY",
        "OPENAI_KEY"
    ])


def resolve_openai_base_url() -> Optional[str]:
    """Resolves OpenAI base URL with Railway fallbacks"""
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
        
        # OpenAI Configuration
        "openaiApiKey": resolve_openai_key(),
        "openaiBaseUrl": resolve_openai_base_url(),
        "defaultModel": get_env_var("OPENAI_MODEL", [
            "RAILWAY_OPENAI_MODEL",
            "FINETUNED_MODEL_ID",
            "FINE_TUNED_MODEL_ID",
            "AI_MODEL"
        ]) or Config.OPENAI_MODEL,
        "fallbackModel": get_env_var("FALLBACK_MODEL", [
            "AI_FALLBACK_MODEL",
            "RAILWAY_OPENAI_FALLBACK_MODEL"
        ]) or "gpt-4",
        "gpt5Model": get_env_var("GPT5_MODEL") or "gpt-5",
        "gpt51Model": get_env_var("GPT51_MODEL") or "gpt-5.1",
        
        # Railway Configuration
        "railwayEnvironment": os.getenv("RAILWAY_ENVIRONMENT"),
        "railwayProjectId": os.getenv("RAILWAY_PROJECT_ID")
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
