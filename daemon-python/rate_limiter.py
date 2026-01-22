"""
Rate Limiter for ARCANOS
Tracks and enforces request, token, and cost limits.
"""

import time
from datetime import datetime, timedelta
from typing import Optional
from config import Config


class RateLimiter:
    """Manages rate limiting for API requests"""

    def __init__(self):
        self.requests_per_hour: list[float] = []
        self.tokens_today: int = 0
        self.cost_today: float = 0.0
        self.last_reset: datetime = datetime.now()

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
        self.requests_per_hour.append(time.time())
        self.tokens_today += tokens
        self.cost_today += cost

    def get_usage_stats(self) -> dict:
        """Get current usage statistics"""
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
