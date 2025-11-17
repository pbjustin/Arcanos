"""Python helper for invoking the fine-tuned GPT-5 model."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Iterable, List, Mapping, MutableMapping, Optional

from .notifier import MaintenanceNotifier

try:  # pragma: no cover - import is validated at runtime
    from openai import OpenAI
except ImportError:  # pragma: no cover - optional dependency
    OpenAI = None  # type: ignore[assignment]


class ConfigurationError(RuntimeError):
    """Raised when a required configuration value is missing."""


@dataclass
class ArcanosPythonClient:
    """Runs GPT-5.1 reasoning with enforced configuration.

    Parameters
    ----------
    api_key_env:
        Environment variable that stores the OpenAI API key. Defaults to
        ``OPENAI_API_KEY`` for parity with the Node.js backend.
    model_env:
        Environment variable containing the fine-tuned GPT-5 model ID. Defaults
        to ``ARCANOS_FINE_TUNED_MODEL``.
    notifier:
        Optional :class:`MaintenanceNotifier` instance. When omitted a default
        notifier is created.
    """

    api_key_env: str = "OPENAI_API_KEY"
    model_env: str = "ARCANOS_FINE_TUNED_MODEL"
    notifier: MaintenanceNotifier = field(default_factory=MaintenanceNotifier)

    def _get_env(self, name: str) -> str:
        value = os.getenv(name)
        if not value:
            raise ConfigurationError(f"Missing required environment variable: {name}")
        return value

    def _build_client(self):
        if OpenAI is None:  # pragma: no cover - optional dependency
            raise ConfigurationError(
                "The 'openai' package is required. Install the python-client"
                " extras described in ARCANOS_PYTHON_README.md."
            )
        return OpenAI(api_key=self._get_env(self.api_key_env))

    def run_reasoning(
        self,
        messages: Iterable[Mapping[str, str]],
        *,
        temperature: float = 0.2,
        metadata: Optional[MutableMapping[str, str]] = None,
    ) -> Mapping[str, str]:
        """Execute a reasoning request using the fine-tuned model.

        The method enforces the configured model ID, raises exceptions on
        failure, and notifies the maintenance assistant before surfacing the
        original error.
        """

        client = self._build_client()
        model = self._get_env(self.model_env)

        try:
            completion = client.chat.completions.create(  # type: ignore[call-arg]
                model=model,
                messages=list(messages),
                temperature=temperature,
                metadata=metadata,
            )
        except Exception as exc:  # pragma: no cover - network failure path
            self.notifier.notify(
                f"GPT-5.1 reasoning failure while calling model '{model}'",
                incident=type(exc).__name__,
            )
            raise

        if not completion.choices:
            raise RuntimeError("OpenAI response did not contain any choices")

        return completion.choices[0].message

    def run_simple_prompt(self, prompt: str) -> str:
        """Shortcut for single-turn prompts."""

        message = {"role": "user", "content": prompt}
        response = self.run_reasoning([message])
        return response.get("content", "") or ""
