"""
ARCANOS Python Tests
Comprehensive test suite for daemon functionality.
"""

import pytest
from unittest.mock import MagicMock
from pathlib import Path
import sys

# Ensure daemon-python is importable
ROOT_DIR = Path(__file__).resolve().parents[1]
DAEMON_DIR = ROOT_DIR / "daemon-python"
sys.path.insert(0, str(DAEMON_DIR))

# Import modules to test
from config import Config
from schema import Memory
from gpt_client import GPTClient
from rate_limiter import RateLimiter
from terminal import TerminalController
from ai_client import resolve_openai_settings
from openai_key_validation import normalize_openai_api_key
from ipc_client import build_ws_url
from credential_bootstrap import bootstrap_credentials
from conversation_routing import determine_conversation_route
from backend_client import BackendApiClient


class TestConfig:
    """Test configuration module"""

    def test_config_validation(self):
        """Test config validation"""
        is_valid, errors = Config.validate()
        # Should have at least API key error if not set
        assert isinstance(is_valid, bool)
        assert isinstance(errors, list)

    def test_dangerous_commands(self):
        """Test dangerous commands list"""
        dangerous = Config.get_dangerous_commands()
        assert isinstance(dangerous, list)
        assert len(dangerous) > 0


class TestMemory:
    """Test memory/schema module"""

    def test_memory_initialization(self, tmp_path):
        """Test memory initialization"""
        memory_file = tmp_path / "test_memories.json"
        memory = Memory(file_path=memory_file)

        assert memory.data is not None
        assert "conversations" in memory.data
        assert "statistics" in memory.data
        assert "settings" in memory.data

    def test_add_conversation(self, tmp_path):
        """Test adding conversations"""
        memory_file = tmp_path / "test_memories.json"
        memory = Memory(file_path=memory_file)

        initial_count = len(memory.data["conversations"])
        memory.add_conversation("Hello", "Hi there!", 10, 0.001)

        assert len(memory.data["conversations"]) == initial_count + 1
        assert memory.data["statistics"]["total_requests"] == initial_count + 1

    def test_get_recent_conversations(self, tmp_path):
        """Test getting recent conversations"""
        memory_file = tmp_path / "test_memories.json"
        memory = Memory(file_path=memory_file)

        memory.add_conversation("Test 1", "Response 1", 10, 0.001)
        memory.add_conversation("Test 2", "Response 2", 10, 0.001)

        recent = memory.get_recent_conversations(limit=5)
        assert len(recent) <= 5

    def test_user_preferences(self, tmp_path):
        """Test user preferences"""
        memory_file = tmp_path / "test_memories.json"
        memory = Memory(file_path=memory_file)

        memory.set_user_preference("theme", "dark")
        assert memory.get_user_preference("theme") == "dark"
        assert memory.get_user_preference("nonexistent", "default") == "default"


class TestRateLimiter:
    """Test rate limiter"""

    def test_rate_limiter_initialization(self):
        """Test rate limiter initialization"""
        limiter = RateLimiter()
        assert limiter.tokens_today == 0
        assert limiter.cost_today == 0.0

    def test_can_make_request(self):
        """Test request allowance check"""
        limiter = RateLimiter()
        can_request, reason = limiter.can_make_request()
        assert isinstance(can_request, bool)

    def test_record_request(self):
        """Test recording requests"""
        limiter = RateLimiter()
        initial_tokens = limiter.tokens_today
        limiter.record_request(100, 0.01)
        assert limiter.tokens_today == initial_tokens + 100

    def test_usage_stats(self):
        """Test getting usage stats"""
        limiter = RateLimiter()
        stats = limiter.get_usage_stats()
        assert "requests_this_hour" in stats
        assert "tokens_today" in stats
        assert "cost_today" in stats


class TestTerminalController:
    """Test terminal controller"""

    def test_terminal_initialization(self):
        """Test terminal controller initialization"""
        controller = TerminalController()
        assert controller.dangerous_commands is not None

    def test_command_safety_check(self):
        """Test command safety checking"""
        controller = TerminalController()

        # Safe command
        is_safe, reason = controller.is_command_safe("Get-Date")
        assert is_safe is True

        # Dangerous command
        is_safe, reason = controller.is_command_safe("rm -rf /")
        if not controller.allow_dangerous:
            assert is_safe is False
            assert reason is not None

    def test_execute_safe_command(self):
        """Test executing safe command"""
        controller = TerminalController()

        # Execute simple PowerShell command
        stdout, stderr, return_code = controller.execute_powershell("Write-Output 'test'")

        assert stdout is not None or stderr is not None
        assert isinstance(return_code, int)


class TestGPTClient:
    """Test GPT client (mocked)"""

    def test_gpt_client_initialization(self, monkeypatch):
        """Test GPT client initialization"""
        monkeypatch.setattr(Config, "OPENAI_API_KEY", "")
        with pytest.raises(ValueError):
            GPTClient(api_key="")

    def test_ask_method(self):
        """Test ask method with mock"""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content="Test response"))]
        mock_response.usage = MagicMock(total_tokens=10, prompt_tokens=5, completion_tokens=5)
        mock_client.chat.completions.create.return_value = mock_response

        provider = MagicMock()
        provider.get_client.return_value = mock_client

        client = GPTClient(api_key="test-key", client_provider=provider)

        response, tokens, cost = client.ask("Hello")
        assert response == "Test response"
        assert tokens == 10
        assert cost > 0


class TestAiClient:
    """Test OpenAI client helper functions"""

    def test_resolve_openai_settings_with_override(self):
        """Test resolving OpenAI settings with API key override"""
        settings = resolve_openai_settings(api_key="test-key")
        assert settings.api_key == "test-key"

    def test_resolve_openai_settings_rejects_placeholder(self):
        """Test resolving OpenAI settings rejects placeholder values"""
        with pytest.raises(ValueError):
            resolve_openai_settings(api_key="sk-your-api-key-here")


class TestOpenAiKeyValidation:
    """Test OpenAI API key validation helpers"""

    def test_normalize_openai_api_key_accepts_valid(self):
        """Test normalization accepts non-placeholder keys"""
        assert normalize_openai_api_key("sk-proj-abc123") == "sk-proj-abc123"

    def test_normalize_openai_api_key_rejects_placeholder(self):
        """Test normalization rejects placeholder keys"""
        assert normalize_openai_api_key("sk-your-api-key-here") is None
        assert normalize_openai_api_key("{{OPENAI_API_KEY}}") is None


class TestIpcClientHelpers:
    """Test IPC helper functions"""

    def test_build_ws_url(self):
        """Test WebSocket URL construction"""
        ws_url = build_ws_url("https://example.com", "/ws/daemon")
        assert ws_url == "wss://example.com/ws/daemon"

    def test_build_ws_url_missing_base(self):
        """Test WebSocket URL construction with missing base URL"""
        ws_url = build_ws_url(None, "/ws/daemon")
        assert ws_url is None


class TestCredentialBootstrap:
    """Test credential bootstrap behavior"""

    def test_bootstrap_skips_backend_login_when_prompt_disabled(self, monkeypatch, tmp_path):
        """Test bootstrap avoids backend login prompts when disabled"""
        monkeypatch.setattr(Config, "OPENAI_API_KEY", "sk-test-key")
        monkeypatch.setattr(Config, "BACKEND_URL", "https://example.com")
        monkeypatch.setattr(Config, "BACKEND_TOKEN", "")
        monkeypatch.setattr(Config, "BACKEND_AUTH_MODE", "jwt")
        monkeypatch.setattr(Config, "BACKEND_LOGIN_PROMPT_ENABLED", False)

        def fail_input(_: str) -> str:
            raise AssertionError("input provider should not be called")

        def fail_password(_: str) -> str:
            raise AssertionError("password provider should not be called")

        def fail_login(*_args, **_kwargs):
            raise AssertionError("login requester should not be called")

        result = bootstrap_credentials(
            env_path=tmp_path / ".env",
            input_provider=fail_input,
            password_provider=fail_password,
            login_requester=fail_login
        )

        assert result.backend_token is None

    def test_bootstrap_skips_login_when_api_key_mode(self, monkeypatch, tmp_path):
        """Test bootstrap avoids login prompts when API key auth is enabled"""
        monkeypatch.setattr(Config, "OPENAI_API_KEY", "sk-test-key")
        monkeypatch.setattr(Config, "BACKEND_URL", "https://example.com")
        monkeypatch.setattr(Config, "BACKEND_AUTH_MODE", "api_key")
        monkeypatch.setattr(Config, "BACKEND_API_KEY", "")

        def fail_input(_: str) -> str:
            raise AssertionError("input provider should not be called")

        def fail_password(_: str) -> str:
            raise AssertionError("password provider should not be called")

        def fail_login(*_args, **_kwargs):
            raise AssertionError("login requester should not be called")

        result = bootstrap_credentials(
            env_path=tmp_path / ".env",
            input_provider=fail_input,
            password_provider=fail_password,
            login_requester=fail_login
        )

        assert result.backend_token is None


class TestBackendApiClient:
    """Test backend API client behavior"""

    def test_request_allows_missing_token_when_auth_disabled(self):
        """Test backend client skips auth header when auth is disabled"""
        class FakeResponse:
            def __init__(self):
                self.status_code = 200
                self.text = ""

            def json(self):
                return {
                    "response": "ok",
                    "tokens": 0,
                    "cost": 0.0,
                    "model": "test-model"
                }

        def fake_request(method, url, headers=None, json=None, timeout=None):
            assert headers is not None
            assert "Authorization" not in headers
            return FakeResponse()

        client = BackendApiClient(
            base_url="https://example.com",
            token_provider=lambda: None,
            auth_required=False,
            request_sender=fake_request
        )

        response = client.request_chat_completion(
            messages=[{"role": "user", "content": "hello"}],
            temperature=0.1,
            model="test-model"
        )

        assert response.ok is True
        assert response.value is not None
        assert response.value.response_text == "ok"

    def test_request_uses_api_key_header_when_configured(self):
        """Test backend client uses API key header when configured"""
        class FakeResponse:
            def __init__(self):
                self.status_code = 200
                self.text = ""

            def json(self):
                return {
                    "response": "ok",
                    "tokens": 0,
                    "cost": 0.0,
                    "model": "test-model"
                }

        def fake_request(method, url, headers=None, json=None, timeout=None):
            assert headers is not None
            assert headers.get("X-API-Key") == "test-api-key"
            assert "Authorization" not in headers
            return FakeResponse()

        client = BackendApiClient(
            base_url="https://example.com",
            token_provider=lambda: "test-api-key",
            auth_required=True,
            auth_header_name="X-API-Key",
            auth_header_prefix=None,
            auth_mode="api_key",
            request_sender=fake_request
        )

        response = client.request_chat_completion(
            messages=[{"role": "user", "content": "hello"}],
            temperature=0.1,
            model="test-model"
        )

        assert response.ok is True
        assert response.value is not None

    def test_request_includes_daemon_gpt_id_header(self):
        """Test backend client includes daemon GPT ID header when configured"""
        class FakeResponse:
            def __init__(self):
                self.status_code = 200
                self.text = ""

            def json(self):
                return {
                    "response": "ok",
                    "tokens": 0,
                    "cost": 0.0,
                    "model": "test-model"
                }

        def fake_request(method, url, headers=None, json=None, timeout=None):
            assert headers is not None
            assert headers.get("Authorization") == "Bearer test-token"
            assert headers.get("OpenAI-GPT-ID") == "gpt-test-id"
            return FakeResponse()

        client = BackendApiClient(
            base_url="https://example.com",
            token_provider=lambda: "test-token",
            auth_required=True,
            auth_header_name="Authorization",
            auth_header_prefix="Bearer",
            daemon_gpt_id="gpt-test-id",
            daemon_gpt_header_name="OpenAI-GPT-ID",
            request_sender=fake_request
        )

        response = client.request_chat_completion(
            messages=[{"role": "user", "content": "hello"}],
            temperature=0.1,
            model="test-model"
        )

        assert response.ok is True
        assert response.value is not None


class TestConversationRouting:
    """Test conversation routing heuristics"""

    def test_auto_route_by_keyword(self):
        """Test auto routing to backend when keywords match"""
        decision = determine_conversation_route(
            user_message="query the database for recent users",
            routing_mode="hybrid",
            deep_prefixes=["deep:", "backend:"],
            auto_route_enabled=True,
            auto_route_keywords=["database", "sql"],
            auto_route_min_words=0
        )
        assert decision.route == "backend"

    def test_auto_route_by_word_count(self):
        """Test auto routing to backend when word count threshold is met"""
        message = "This request has enough words to exceed the minimum threshold for backend routing."
        decision = determine_conversation_route(
            user_message=message,
            routing_mode="hybrid",
            deep_prefixes=["deep:", "backend:"],
            auto_route_enabled=True,
            auto_route_keywords=[],
            auto_route_min_words=8
        )
        assert decision.route == "backend"

    def test_auto_route_disabled_defaults_local(self):
        """Test auto routing disabled keeps local route"""
        decision = determine_conversation_route(
            user_message="query the database for recent users",
            routing_mode="hybrid",
            deep_prefixes=["deep:", "backend:"],
            auto_route_enabled=False,
            auto_route_keywords=["database"],
            auto_route_min_words=0
        )
        assert decision.route == "local"

    def test_prefix_override_routes_backend(self):
        """Test prefix-based routing overrides heuristics"""
        decision = determine_conversation_route(
            user_message="deep: check status",
            routing_mode="hybrid",
            deep_prefixes=["deep:", "backend:"],
            auto_route_enabled=False,
            auto_route_keywords=[],
            auto_route_min_words=0
        )
        assert decision.route == "backend"
        assert decision.normalized_message == "check status"


# Run tests
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
