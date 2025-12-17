"""Arcanos Python companion module.

This package exposes a thin client that enforces the fine-tuned GPT-5.2 model
and reports any inference failure to the maintenance assistant webhook.
"""

from .client import ArcanosPythonClient, ConfigurationError
from .notifier import MaintenanceNotifier

__all__ = [
    "ArcanosPythonClient",
    "ConfigurationError",
    "MaintenanceNotifier",
]
