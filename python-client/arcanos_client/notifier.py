"""Utilities for notifying the maintenance assistant."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional


@dataclass
class MaintenanceNotifier:
    """Sends failure alerts to the maintenance assistant.

    The notifier uses the ``ARCANOS_MAINTENANCE_WEBHOOK`` environment variable.
    When the variable is not defined, alerts are simply logged to STDOUT so the
    calling process can still proceed without raising a secondary error.
    """

    webhook_url: Optional[str] = None

    def __post_init__(self) -> None:
        if self.webhook_url is None:
            self.webhook_url = os.getenv("ARCANOS_MAINTENANCE_WEBHOOK")

    def notify(self, message: str, *, incident: Optional[str] = None) -> None:
        payload = {"message": message}
        if incident:
            payload["incident"] = incident

        body = json.dumps(payload).encode("utf-8")

        if not self.webhook_url:
            print(f"[arcanos-python] maintenance alert: {payload}")
            return

        request = urllib.request.Request(
            self.webhook_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
                response.read()
        except urllib.error.URLError as exc:  # pragma: no cover - network failure
            print(
                "[arcanos-python] failed to notify maintenance assistant:",
                exc,
            )
