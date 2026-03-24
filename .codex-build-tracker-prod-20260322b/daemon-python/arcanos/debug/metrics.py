import threading
import time
from typing import Dict, Tuple


class DebugMetrics:
    """
    In-process metrics store for the debug server.

    Thread-safe and lightweight; no external dependencies.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # endpoint -> (count, error_count)
        self._counts: Dict[str, Tuple[int, int]] = {}
        # endpoint -> (total_duration_ms, max_duration_ms)
        self._latencies: Dict[str, Tuple[float, float]] = {}
        self._start_time = time.time()

    def record(
        self,
        endpoint: str,
        status_code: int,
        duration_ms: float,
    ) -> None:
        with self._lock:
            total, errors = self._counts.get(endpoint, (0, 0))
            total += 1
            if status_code >= 400:
                errors += 1
            self._counts[endpoint] = (total, errors)

            total_lat, max_lat = self._latencies.get(endpoint, (0.0, 0.0))
            total_lat += duration_ms
            if duration_ms > max_lat:
                max_lat = duration_ms
            self._latencies[endpoint] = (total_lat, max_lat)

    def to_prometheus(self) -> str:
        """
        Render metrics in a simple Prometheus text exposition format.
        """
        lines = []
        uptime = int(time.time() - self._start_time)
        lines.append("# TYPE arcanos_debug_uptime_seconds counter")
        lines.append(f"arcanos_debug_uptime_seconds {uptime}")

        lines.append("# TYPE arcanos_debug_requests_total counter")
        lines.append("# TYPE arcanos_debug_errors_total counter")
        lines.append("# TYPE arcanos_debug_request_duration_ms summary")

        with self._lock:
            for endpoint, (count, errors) in self._counts.items():
                safe_endpoint = endpoint.replace('"', '\\"')
                lines.append(
                    f'arcanos_debug_requests_total{{endpoint="{safe_endpoint}"}} {count}'
                )
                lines.append(
                    f'arcanos_debug_errors_total{{endpoint="{safe_endpoint}"}} {errors}'
                )

            for endpoint, (total_lat, max_lat) in self._latencies.items():
                safe_endpoint = endpoint.replace('"', '\\"')
                avg = total_lat / max(self._counts.get(endpoint, (1, 0))[0], 1)
                lines.append(
                    f'arcanos_debug_request_duration_ms_sum{{endpoint="{safe_endpoint}"}} {total_lat:.3f}'
                )
                lines.append(
                    f'arcanos_debug_request_duration_ms_count{{endpoint="{safe_endpoint}"}} {self._counts.get(endpoint, (0, 0))[0]}'
                )
                lines.append(
                    f'arcanos_debug_request_duration_ms_max{{endpoint="{safe_endpoint}"}} {max_lat:.3f}'
                )

        return "\n".join(lines) + "\n"


_GLOBAL_METRICS = DebugMetrics()


def get_metrics() -> DebugMetrics:
    return _GLOBAL_METRICS
