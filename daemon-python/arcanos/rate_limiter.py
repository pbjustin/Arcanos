"""
Rate Limiter for ARCANOS
Tracks and enforces request, token, and cost limits.
"""

import time
import math
import threading
from datetime import datetime, timedelta
from typing import Optional
from .config import Config


class RateLimiter:
    """Manages rate limiting for API requests"""

    def __init__(self):
        self.requests_per_hour: list[float] = []
        self.tokens_today: int = 0
        self.cost_today: float = 0.0
        self.last_reset: datetime = datetime.now()
        self._recovered_requests: dict[str, float] = {}
        self._lock = threading.RLock()

    def _reset_daily_limits(self) -> None:
        """Reset daily limits if it's a new day"""
        now = datetime.now()
        if now.date() > self.last_reset.date():
            self.tokens_today = 0
            self.cost_today = 0.0
            self.last_reset = now

    def _clean_hourly_requests(self) -> None:
        """Remove requests older than 1 hour"""
        cutoff = time.time() - 3600
        self.requests_per_hour = [t for t in self.requests_per_hour if t > cutoff]

    def can_make_request(self) -> tuple[bool, Optional[str]]:
        """
        Check if request is allowed under rate limits
        Returns: (allowed, reason_if_denied)
        """
        with self._lock:
            self._reset_daily_limits()
            self._clean_hourly_requests()

            # Check hourly request limit
            if len(self.requests_per_hour) >= Config.MAX_REQUESTS_PER_HOUR:
                wait_time = int(3600 - (time.time() - self.requests_per_hour[0]))
                return False, f"Hourly request limit reached ({Config.MAX_REQUESTS_PER_HOUR}). Try again in {wait_time // 60}m {wait_time % 60}s."

            # Check daily token limit
            if self.tokens_today >= Config.MAX_TOKENS_PER_DAY:
                return False, f"Daily token limit reached ({Config.MAX_TOKENS_PER_DAY:,}). Resets at midnight."

            # Check daily cost limit
            if self.cost_today >= Config.MAX_COST_PER_DAY:
                return False, f"Daily cost limit reached (${Config.MAX_COST_PER_DAY:.2f}). Resets at midnight."

            return True, None

    def record_request(self, tokens: int, cost: float) -> None:
        """Record a completed request"""
        with self._lock:
            self._reset_daily_limits()
            self.requests_per_hour.append(time.time())
            self.tokens_today += tokens
            self.cost_today += cost

    def record_recovered_request(
        self, delivery_id: str, tokens: int, cost: float, recorded_at: float,
    ) -> bool:
        """Hydrate an authoritative completion once, charging its actual day and hour.

        This method records local limit usage only; it never submits inference.
        SQLite remains the durable deduplication source across process restarts.
        """
        if (not isinstance(delivery_id, str) or len(delivery_id) != 64
                or any(char not in "0123456789abcdef" for char in delivery_id)
                or isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 0
                or isinstance(cost, bool) or not isinstance(cost, (int, float))
                or not math.isfinite(cost) or cost < 0
                or isinstance(recorded_at, bool) or not isinstance(recorded_at, (int, float))
                or not math.isfinite(recorded_at)):
            raise ValueError("Invalid recovered request accounting.")
        with self._lock:
            now = time.time()
            if recorded_at > now + 60:
                raise ValueError("Invalid recovered request accounting.")
            self._reset_daily_limits()
            # Startup reconciliation replays the bounded durable usage window.
            # Known receipts need neither another charge nor an O(n) sweep.
            if delivery_id in self._recovered_requests:
                return False
            self._clean_hourly_requests()
            midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            cutoff = min(now - 24 * 60 * 60, midnight)
            self._recovered_requests = {
                key: timestamp for key, timestamp in self._recovered_requests.items()
                if timestamp >= cutoff
            }
            # Recovery history has the same bound. Refuse excess accounting
            # rather than silently losing deduplication in a running process.
            if len(self._recovered_requests) >= 2048:
                raise ValueError("Recovered request accounting is at capacity.")
            if recorded_at < cutoff:
                return False
            self._recovered_requests[delivery_id] = recorded_at
            if datetime.fromtimestamp(recorded_at).date() == datetime.now().date():
                self.tokens_today += tokens
                self.cost_today += cost
            if recorded_at > now - 3600:
                self.requests_per_hour.append(recorded_at)
                self.requests_per_hour.sort()
            return True

    def get_usage_stats(self) -> dict:
        """Get current usage statistics"""
        with self._lock:
            self._reset_daily_limits()
            self._clean_hourly_requests()

            return {
                "requests_this_hour": len(self.requests_per_hour),
                "requests_remaining_this_hour": Config.MAX_REQUESTS_PER_HOUR - len(self.requests_per_hour),
                "tokens_today": self.tokens_today,
                "tokens_remaining_today": Config.MAX_TOKENS_PER_DAY - self.tokens_today,
                "cost_today": self.cost_today,
                "cost_remaining_today": Config.MAX_COST_PER_DAY - self.cost_today,
                "reset_time": (self.last_reset + timedelta(days=1)).replace(hour=0, minute=0, second=0).isoformat()
            }

    def format_usage_stats(self) -> str:
        """Format usage statistics for display"""
        stats = self.get_usage_stats()
        return (
            f"📊 Usage Stats:\n"
            f"   Requests: {stats['requests_this_hour']}/{Config.MAX_REQUESTS_PER_HOUR} this hour\n"
            f"   Tokens: {stats['tokens_today']:,}/{Config.MAX_TOKENS_PER_DAY:,} today\n"
            f"   Cost: ${stats['cost_today']:.4f}/${Config.MAX_COST_PER_DAY:.2f} today"
        )

