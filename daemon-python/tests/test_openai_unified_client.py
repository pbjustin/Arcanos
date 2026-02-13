"""Tests for Python unified OpenAI client lifecycle."""

from __future__ import annotations

from arcanos.config import Config
from arcanos.env import set_env_value
from arcanos.openai import unified_client


def test_resolve_openai_key_prefers_config(monkeypatch):
    """resolve_openai_key should return Config key before deprecated env shim."""

    monkeypatch.setattr(Config, "OPENAI_API_KEY", "config-priority-key", raising=False)
    set_env_value("OPENAI_API_KEY", "env-secondary-key")

    assert unified_client.resolve_openai_key(Config) == "config-priority-key"


def test_create_openai_client_returns_none_without_key(monkeypatch):
    """create_openai_client should return None when no valid key is available."""

    monkeypatch.setattr(Config, "OPENAI_API_KEY", "", raising=False)
    set_env_value("OPENAI_API_KEY", "")

    unified_client.reset_client()
    created = unified_client.create_openai_client(config=Config)
    assert created is None


def test_singleton_lifecycle_reset_and_recreate(monkeypatch):
    """get_or_create_client should reuse singleton and reset_client should clear it."""

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    monkeypatch.setattr(unified_client, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(Config, "OPENAI_API_KEY", "singleton-key", raising=False)
    monkeypatch.setattr(Config, "OPENAI_MODEL", "gpt-test", raising=False)

    unified_client.reset_client()
    client_one = unified_client.get_or_create_client(Config)
    client_two = unified_client.get_or_create_client(Config)

    assert client_one is client_two
    assert client_one is not None
    assert getattr(client_one, "kwargs", {}).get("api_key") == "singleton-key"

    unified_client.reset_client()
    assert unified_client.get_client() is None
