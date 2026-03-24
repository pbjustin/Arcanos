from __future__ import annotations

from pathlib import Path

from arcanos.credential_bootstrap import bootstrap_credentials
import arcanos.credential_bootstrap as credential_bootstrap_module


def test_bootstrap_credentials_drops_expired_backend_token(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(credential_bootstrap_module.Config, "ENV_PATH", tmp_path / ".env")
    monkeypatch.setattr(credential_bootstrap_module.Config, "FALLBACK_ENV_PATH", None)
    monkeypatch.setattr(credential_bootstrap_module.Config, "OPENAI_API_KEY", "sk-test-openai")
    monkeypatch.setattr(credential_bootstrap_module.Config, "BACKEND_URL", "https://backend.example.com")
    monkeypatch.setattr(credential_bootstrap_module.Config, "BACKEND_TOKEN", "expired-backend-token")
    monkeypatch.setattr(credential_bootstrap_module.Config, "BACKEND_LOGIN_EMAIL", "operator@example.com")
    monkeypatch.setattr(credential_bootstrap_module.Config, "BACKEND_JWT_SECRET", None)
    monkeypatch.setattr(credential_bootstrap_module.Config, "BACKEND_JWT_PUBLIC_KEY", None)
    monkeypatch.setattr(credential_bootstrap_module.Config, "BACKEND_JWT_JWKS_URL", None)
    monkeypatch.setattr(credential_bootstrap_module, "_init_bootstrap_trace_path", lambda: None)
    monkeypatch.setattr(credential_bootstrap_module, "_write_bootstrap_trace", lambda *args, **kwargs: None)
    monkeypatch.setattr(credential_bootstrap_module, "_seed_env_file_if_missing", lambda *args, **kwargs: False)
    monkeypatch.setattr(credential_bootstrap_module, "is_jwt_expired", lambda token, now: True)

    result = bootstrap_credentials(
        input_provider=lambda prompt: (_ for _ in ()).throw(AssertionError(f"unexpected prompt: {prompt}"))
    )

    assert result.openai_api_key == "sk-test-openai"
    assert result.backend_login_email == "operator@example.com"
    assert result.backend_token is None
