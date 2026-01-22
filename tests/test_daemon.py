"""
ARCANOS Python Tests
Comprehensive test suite for daemon functionality.
"""

import pytest
from unittest.mock import Mock, patch, MagicMock
from pathlib import Path
import json

# Import modules to test
from daemon-python.config import Config
from daemon-python.schema import Memory
from daemon-python.gpt_client import GPTClient
from daemon-python.rate_limiter import RateLimiter
from daemon-python.terminal import TerminalController


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

    @patch('daemon-python.gpt_client.OpenAI')
    def test_gpt_client_initialization(self, mock_openai):
        """Test GPT client initialization"""
        with pytest.raises(ValueError):
            GPTClient(api_key="")

    @patch('daemon-python.gpt_client.OpenAI')
    def test_ask_method(self, mock_openai):
        """Test ask method with mock"""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content="Test response"))]
        mock_response.usage = MagicMock(total_tokens=10, prompt_tokens=5, completion_tokens=5)
        mock_client.chat.completions.create.return_value = mock_response

        mock_openai.return_value = mock_client

        client = GPTClient(api_key="test-key")
        client.client = mock_client

        response, tokens, cost = client.ask("Hello")
        assert response == "Test response"
        assert tokens == 10
        assert cost > 0


# Run tests
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
