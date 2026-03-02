"""Tests for backend token resolution compatibility logic."""

from __future__ import annotations

import importlib



def _reload_config_module(monkeypatch, **env_overrides):
    """
    Purpose: Reload config module with deterministic environment overrides.
    Inputs/Outputs: monkeypatch fixture and env mapping; returns reloaded config module.
    Edge cases: Clears unspecified auth envs to avoid leakage across tests.
    """
    for env_key in ("BACKEND_TOKEN", "ARCANOS_API_KEY", "ADMIN_KEY"):
        env_value = env_overrides.get(env_key)
        if env_value is None:
            monkeypatch.delenv(env_key, raising=False)
        else:
            monkeypatch.setenv(env_key, env_value)
    import arcanos.config as config_module

    return importlib.reload(config_module)



def test_config_backend_token_prefers_backend_token(monkeypatch):
    """Config.BACKEND_TOKEN should prioritize BACKEND_TOKEN when multiple secrets exist."""
    config_module = _reload_config_module(
        monkeypatch,
        BACKEND_TOKEN="backend-token-value",
        ARCANOS_API_KEY="arcanos-api-key",
        ADMIN_KEY="admin-key",
    )

    # //audit assumption: canonical backend token must win precedence; failure risk: wrong secret used and auth mismatch; expected invariant: BACKEND_TOKEN selected first; handling strategy: assert explicit precedence.
    assert config_module.Config.BACKEND_TOKEN == "backend-token-value"



def test_config_backend_token_falls_back_to_arcanos_api_key(monkeypatch):
    """Config.BACKEND_TOKEN should use ARCANOS_API_KEY when BACKEND_TOKEN is missing."""
    config_module = _reload_config_module(
        monkeypatch,
        BACKEND_TOKEN=None,
        ARCANOS_API_KEY="arcanos-api-key",
        ADMIN_KEY="admin-key",
    )

    # //audit assumption: fallback to ARCANOS_API_KEY preserves backend auth compatibility; failure risk: false offline status in Railway; expected invariant: fallback key is accepted; handling strategy: assert fallback selection.
    assert config_module.Config.BACKEND_TOKEN == "arcanos-api-key"



def test_config_backend_token_falls_back_to_admin_key(monkeypatch):
    """Config.BACKEND_TOKEN should use ADMIN_KEY only when other token envs are unavailable."""
    config_module = _reload_config_module(
        monkeypatch,
        BACKEND_TOKEN=None,
        ARCANOS_API_KEY=None,
        ADMIN_KEY="admin-key",
    )

    # //audit assumption: ADMIN_KEY fallback is last-resort compatibility path; failure risk: accidental precedence inversion; expected invariant: admin key used only after other tokens absent; handling strategy: assert final fallback.
    assert config_module.Config.BACKEND_TOKEN == "admin-key"



def test_config_backend_token_none_when_no_auth_env(monkeypatch):
    """Config.BACKEND_TOKEN should be None when no supported auth env var is set."""
    config_module = _reload_config_module(
        monkeypatch,
        BACKEND_TOKEN=None,
        ARCANOS_API_KEY=None,
        ADMIN_KEY=None,
    )

    # //audit assumption: empty auth env must fail closed; failure risk: blank credential treated as valid; expected invariant: token remains None; handling strategy: assert missing token.
    assert config_module.Config.BACKEND_TOKEN is None
