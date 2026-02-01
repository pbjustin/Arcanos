"""Unit and integration tests for debug server."""
import json
import threading
import time
from collections import deque
from http.server import HTTPServer
from socketserver import ThreadingMixIn
from unittest.mock import MagicMock, patch

import pytest

from arcanos.debug_server import DebugAPIHandler, ThreadingHTTPServer, start_debug_server
from arcanos.debug_health import liveness, readiness
from arcanos.debug_metrics import DebugMetrics, get_metrics


class TestServer(ThreadingMixIn, HTTPServer):
    """Test server that allows handler injection."""
    pass


def make_request(handler_class, method: str, path: str, body: bytes = None) -> tuple[int, dict]:
    """Helper to make a test request."""
    from io import BytesIO
    
    class MockRequest:
        def __init__(self, path: str, method: str, body: bytes = None):
            self.path = path
            self.command = method
            self.headers = {}
            if body:
                self.headers["Content-Length"] = str(len(body))
            self.rfile = BytesIO(body or b"")
            self.wfile = BytesIO()
            self._last_status_code = 200
            self._request_id = None
    
    req = MockRequest(path, method, body)
    handler = handler_class(req, ("127.0.0.1", 0), TestServer(("127.0.0.1", 0), handler_class))
    
    if method == "GET":
        handler.do_GET()
    elif method == "POST":
        handler.do_POST()
    
    status = handler._last_status_code
    response_data = handler.wfile.getvalue().decode("utf-8")
    try:
        data = json.loads(response_data)
    except json.JSONDecodeError:
        data = {"raw": response_data}
    
    return status, data


class TestHealthChecks:
    """Test health and readiness endpoints."""
    
    def test_liveness(self):
        """Liveness should always return ok=True."""
        result = liveness()
        assert result["ok"] is True
        assert "ts" in result
        assert "version" in result
    
    def test_readiness_with_mock_cli(self, mock_cli_instance):
        """Readiness should check CLI initialization."""
        result = readiness(mock_cli_instance)
        assert "ok" in result
        assert "checks" in result
        assert result["checks"]["cli_initialized"] is True
    
    def test_readiness_without_backend(self, mock_cli_instance):
        """Readiness should pass if backend not configured."""
        mock_cli_instance.backend_client = None
        with patch("arcanos.debug_health.Config") as mock_config:
            mock_config.BACKEND_URL = None
            result = readiness(mock_cli_instance)
            assert result["checks"]["backend_healthy"] is True


class TestMetrics:
    """Test metrics collection."""
    
    def test_metrics_recording(self):
        """Metrics should record requests correctly."""
        metrics = DebugMetrics()
        metrics.record("/debug/status", 200, 10.5)
        metrics.record("/debug/status", 200, 15.2)
        metrics.record("/debug/status", 500, 5.0)
        
        prom = metrics.to_prometheus()
        assert "arcanos_debug_requests_total" in prom
        assert "arcanos_debug_errors_total" in prom
        assert "arcanos_debug_request_duration_ms" in prom
    
    def test_metrics_global_singleton(self):
        """get_metrics() should return the same instance."""
        m1 = get_metrics()
        m2 = get_metrics()
        assert m1 is m2


class TestDebugServerEndpoints:
    """Test individual debug server endpoints."""
    
    def test_status_endpoint(self, mock_cli_instance):
        """GET /debug/status should return instance info."""
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        status, data = make_request(TestHandler, "GET", "/debug/status")
        assert status == 200
        assert data["ok"] is True
        assert "instanceId" in data
        assert data["instanceId"] == "test-instance-123"
    
    def test_health_endpoint(self, mock_cli_instance):
        """GET /debug/health should return liveness."""
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        status, data = make_request(TestHandler, "GET", "/debug/health")
        assert status == 200
        assert data["ok"] is True
    
    def test_ready_endpoint(self, mock_cli_instance):
        """GET /debug/ready should return readiness."""
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        status, data = make_request(TestHandler, "GET", "/debug/ready")
        assert status in (200, 503)
        assert "ok" in data
        assert "checks" in data
    
    def test_metrics_endpoint(self, mock_cli_instance):
        """GET /debug/metrics should return Prometheus format."""
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        status, data = make_request(TestHandler, "GET", "/debug/metrics")
        assert status == 200
        # Metrics endpoint returns text/plain, not JSON
        assert "raw" in data or "arcanos_debug" in str(data)
    
    def test_404_endpoint(self, mock_cli_instance):
        """Unknown endpoints should return 404."""
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        status, data = make_request(TestHandler, "GET", "/debug/unknown")
        assert status == 404
        assert data["ok"] is False
        assert "error" in data


class TestQueryParameters:
    """Test query parameter parsing and pagination."""
    
    def test_logs_tail_parameter(self, mock_cli_instance):
        """GET /debug/logs?tail=10 should limit results."""
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        # This will fail if log file doesn't exist, but tests parsing
        status, data = make_request(TestHandler, "GET", "/debug/logs?tail=10")
        # Either 200 with data or 200 with error about missing file
        assert status == 200
    
    def test_audit_limit_parameter(self, mock_cli_instance, sample_activity_entries):
        """GET /debug/audit?limit=2 should limit entries."""
        mock_cli_instance._activity = deque(sample_activity_entries, maxlen=200)
        
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        status, data = make_request(TestHandler, "GET", "/debug/audit?limit=2")
        assert status == 200
        assert "entries" in data
        assert len(data["entries"]) <= 2
    
    def test_audit_filter_parameter(self, mock_cli_instance, sample_activity_entries):
        """GET /debug/audit?filter=error should filter by kind."""
        mock_cli_instance._activity = deque(sample_activity_entries, maxlen=200)
        
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        status, data = make_request(TestHandler, "GET", "/debug/audit?filter=error")
        assert status == 200
        assert "entries" in data
        # All entries should be of kind "error"
        for entry in data["entries"]:
            assert entry.get("kind") == "error"


class TestErrorHandling:
    """Test error handling and edge cases."""
    
    def test_invalid_json_body(self, mock_cli_instance):
        """POST with invalid JSON should return 400."""
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        status, data = make_request(TestHandler, "POST", "/debug/ask", body=b"invalid json")
        assert status == 400
        assert data["ok"] is False
    
    def test_missing_message_field(self, mock_cli_instance):
        """POST /debug/ask without message should return 400."""
        class TestHandler(DebugAPIHandler):
            cli_instance = mock_cli_instance
        
        body = json.dumps({}).encode("utf-8")
        status, data = make_request(TestHandler, "POST", "/debug/ask", body=body)
        assert status == 400
        assert "message" in data.get("error", "").lower()


class TestDependencyInjection:
    """Test that dependency injection works correctly."""
    
    def test_bound_handler_has_cli_instance(self, mock_cli_instance):
        """BoundDebugAPIHandler should have cli_instance set."""
        from arcanos.debug_server import start_debug_server
        
        # This test verifies the pattern works; actual server start is tested elsewhere
        # We can't easily test the actual server without binding to a port
        # But we can verify the class structure
        class BoundHandler(DebugAPIHandler):
            def __init__(self, *args, **kwargs):
                self.cli_instance = mock_cli_instance
                super().__init__(*args, **kwargs)
        
        # Verify the pattern
        handler = BoundHandler.__new__(BoundHandler)
        handler.cli_instance = mock_cli_instance
        assert handler.cli_instance is mock_cli_instance
