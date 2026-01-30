"""
Backend authentication helpers for daemon URLs.
"""

from __future__ import annotations

from urllib.parse import urlparse


def validate_backend_url(base_url: str, allow_http_dev: bool = False) -> str:
    """
    Purpose: Validate backend URL and enforce HTTPS for non-local URLs.
    Inputs/Outputs: base_url string, allow_http_dev flag; returns normalized URL or raises ValueError.
    Edge cases: Empty input returns empty string; localhost/127.0.0.1 allows HTTP; non-local HTTP requires allow_http_dev flag.
    """
    if not base_url:
        return ""
    
    base_url = base_url.strip()
    if not base_url:
        return ""
    
    parsed = urlparse(base_url)
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname or ""
    hostname_lower = hostname.lower()
    
    # Allow HTTP for localhost/127.0.0.1 or when explicitly allowed for dev
    is_localhost = hostname_lower in ("localhost", "127.0.0.1", "::1")
    allow_http = is_localhost or allow_http_dev
    
    if scheme == "http" and not allow_http:
        raise ValueError(
            f"Backend URL must use HTTPS for non-local URLs. "
            f"Got: {base_url}. "
            f"Use https:// or set BACKEND_ALLOW_HTTP=true for development."
        )
    
    if scheme not in ("http", "https"):
        raise ValueError(
            f"Backend URL must use http:// or https:// scheme. Got: {base_url}"
        )
    
    # Normalize: remove trailing slash
    normalized = base_url.rstrip("/")
    
    if scheme == "http" and allow_http_dev and not is_localhost:
        # Log warning when HTTP is explicitly allowed for non-localhost
        import logging
        logger = logging.getLogger("arcanos.backend_auth")
        logger.warning(
            f"Backend URL uses HTTP with BACKEND_ALLOW_HTTP=true: {normalized}. "
            f"This should only be used in development environments."
        )
    
    return normalized


def normalize_backend_url(base_url: str, allow_http_dev: bool = False) -> str:
    """
    Purpose: Normalize backend base URL for request building with HTTPS enforcement.
    Inputs/Outputs: base_url string, optional allow_http_dev flag; returns normalized URL without trailing slash.
    Edge cases: Empty input returns empty string; validates HTTPS unless localhost or allow_http_dev is True.
    """
    if not base_url:
        return ""
    
    # Validate and normalize URL (enforces HTTPS for non-local URLs)
    return validate_backend_url(base_url, allow_http_dev)

