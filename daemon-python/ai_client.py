"""
OpenAI client factory for the ARCANOS daemon.
Centralizes SDK initialization and caching.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from openai import OpenAI

from config import Config
from openai_key_validation import normalize_openai_api_key


@dataclass(frozen=True)
class OpenAIClientSettings:
    """
    Purpose: Hold OpenAI client configuration settings.
    Inputs/Outputs: api_key, base_url, organization, project.
    Edge cases: api_key must be non-empty or client creation fails.
    """

    api_key: str
    base_url: Optional[str] = None
    organization: Optional[str] = None
    project: Optional[str] = None


def _normalize_optional(value: Optional[str]) -> Optional[str]:
    if not value:
        # //audit assumption: empty value should be ignored; risk: invalid config; invariant: None for empty; strategy: return None.
        return None
    trimmed = value.strip()
    if not trimmed:
        # //audit assumption: whitespace-only should be ignored; risk: invalid config; invariant: None; strategy: return None.
        return None
    return trimmed


def resolve_openai_settings(api_key: Optional[str] = None) -> OpenAIClientSettings:
    """
    Purpose: Resolve OpenAI client settings using optional override and Config defaults.
    Inputs/Outputs: api_key override; returns OpenAIClientSettings.
    Edge cases: Raises ValueError when api_key is missing.
    """
    # //audit assumption: normalization strips placeholders; risk: false negatives; invariant: valid key or None; strategy: normalize override and config.
    resolved_api_key = normalize_openai_api_key(api_key) or normalize_openai_api_key(Config.OPENAI_API_KEY)
    if not resolved_api_key:
        # //audit assumption: API key required; risk: client unusable; invariant: key present; strategy: raise error.
        raise ValueError("OpenAI API key is required")

    return OpenAIClientSettings(
        api_key=resolved_api_key,
        base_url=_normalize_optional(getattr(Config, "OPENAI_BASE_URL", None)),
        organization=_normalize_optional(getattr(Config, "OPENAI_ORG_ID", None)),
        project=_normalize_optional(getattr(Config, "OPENAI_PROJECT_ID", None))
    )


def create_openai_client(settings: OpenAIClientSettings) -> OpenAI:
    """
    Purpose: Instantiate an OpenAI client from settings.
    Inputs/Outputs: OpenAIClientSettings; returns OpenAI client.
    Edge cases: Raises ValueError if api_key is missing.
    """
    if not settings.api_key:
        # //audit assumption: api_key required; risk: client init failure; invariant: api_key present; strategy: raise error.
        raise ValueError("OpenAI API key is required")

    return OpenAI(
        api_key=settings.api_key,
        base_url=settings.base_url,
        organization=settings.organization,
        project=settings.project
    )


class OpenAIClientProvider:
    """
    Purpose: Provide cached OpenAI clients for reuse.
    Inputs/Outputs: settings and factory; returns OpenAI client on demand.
    Edge cases: Raises ValueError if configuration is invalid.
    """

    def __init__(
        self,
        settings: OpenAIClientSettings,
        client_factory: Callable[[OpenAIClientSettings], OpenAI] = create_openai_client
    ) -> None:
        """
        Purpose: Initialize the provider with settings and factory.
        Inputs/Outputs: settings, client_factory; stores internal cache.
        Edge cases: settings.api_key must be non-empty.
        """
        self._settings = settings
        self._client_factory = client_factory
        self._client: Optional[OpenAI] = None

    def get_client(self) -> OpenAI:
        """
        Purpose: Return cached OpenAI client or create a new one.
        Inputs/Outputs: none; returns OpenAI client.
        Edge cases: Raises ValueError if client creation fails.
        """
        if self._client is not None:
            # //audit assumption: cached client is valid; risk: stale config; invariant: reuse client; strategy: return cache.
            return self._client

        self._client = self._client_factory(self._settings)
        return self._client

    def clear_cache(self) -> None:
        """
        Purpose: Clear cached OpenAI client instance.
        Inputs/Outputs: none; resets internal cache.
        Edge cases: Safe to call when cache is empty.
        """
        # //audit assumption: cache reset safe; risk: none; invariant: cache cleared; strategy: set to None.
        self._client = None
