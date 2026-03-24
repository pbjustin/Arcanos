"""Pytest fixtures for debug server tests."""
import threading
import time
from collections import deque
from unittest.mock import MagicMock
from typing import Any

import pytest

from arcanos.config import Config


@pytest.fixture
def mock_cli_instance():
    """Create a mock CLI instance with required attributes."""
    cli = MagicMock()
    cli.instance_id = "test-instance-123"
    cli.client_id = "test-client"
    cli.start_time = time.time()
    cli._activity = deque(maxlen=200)
    cli._activity_lock = threading.Lock()
    cli._last_error = None
    
    # Mock memory
    cli.memory = MagicMock()
    cli.memory.get_recent_conversations = MagicMock(return_value=[])
    
    # Mock backend client (optional)
    cli.backend_client = None
    
    # Mock handler methods
    cli.handle_ask = MagicMock(return_value=None)
    cli.handle_run = MagicMock(return_value={"output": "test", "exit_code": 0})
    cli.handle_see = MagicMock(return_value={"analysis": "test"})
    
    return cli


@pytest.fixture
def sample_activity_entries():
    """Sample activity entries for testing."""
    return [
        {"ts": "2024-01-01T00:00:00Z", "kind": "ask", "detail": "test message"},
        {"ts": "2024-01-01T00:01:00Z", "kind": "run", "detail": "ls -la"},
        {"ts": "2024-01-01T00:02:00Z", "kind": "error", "detail": "test error"},
    ]
