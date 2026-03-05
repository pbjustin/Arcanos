"""Tests for bootstrap behavior in non-interactive sessions."""

from __future__ import annotations

from types import SimpleNamespace

from arcanos.cli import bootstrap


class _MemoryStub:
    """Minimal memory stub for first-run setup tests."""

    def __init__(self) -> None:
        self._settings = {
            "telemetry_consent": None,
            "first_run": True,
        }

    def get_setting(self, key: str, default=None):
        return self._settings.get(key, default)

    def set_setting(self, key: str, value):
        self._settings[key] = value


def test_first_run_setup_defaults_telemetry_when_non_interactive(monkeypatch) -> None:
    """Non-interactive first-run setup should not call input and should disable telemetry."""

    cli_stub = SimpleNamespace(
        memory=_MemoryStub(),
        console=SimpleNamespace(print=lambda *args, **kwargs: None),
    )

    class _NonTtyStdin:
        @staticmethod
        def isatty() -> bool:
            return False

    monkeypatch.setattr(bootstrap.sys, "stdin", _NonTtyStdin())
    monkeypatch.setattr(
        "builtins.input",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("input() should not be called")),
    )

    bootstrap.first_run_setup(cli_stub)

    assert cli_stub.memory.get_setting("telemetry_consent") is False
    assert cli_stub.memory.get_setting("first_run") is False
