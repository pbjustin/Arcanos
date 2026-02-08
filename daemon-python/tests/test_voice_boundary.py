"""Regression tests for voice boundary filtering."""

from arcanos.voice_boundary import Persona, Severity, apply_voice_boundary, classify


def test_vbl(monkeypatch):
    """Minimal regression suite for core VBL behaviors."""

    class FakeMemory:
        """In-memory adapter for reassurance-decay test coverage."""

        def __init__(self):
            self.s = {}

        def get_stat(self, key, default=0):
            return self.s.get(key, default)

        def increment_stat(self, key):
            self.s[key] = self.s.get(key, 0) + 1

    # Keep rewrite output deterministic for strict assertions.
    monkeypatch.setattr("arcanos.voice_boundary.random.choice", lambda options: options[0])

    memory_adapter = FakeMemory()

    cases = [
        ("No memory entry was created because...", None, Severity.SEV_3),
        ("Backend unavailable; falling back", "I've got this covered.", Severity.SEV_2),
        ("Here's how I'd approach it", "Here's how I'd approach it", Severity.SEV_0),
    ]

    for raw_text, expected_output, expected_severity in cases:
        assert classify(raw_text) == expected_severity
        output = apply_voice_boundary(
            raw_text,
            persona=Persona.CALM,
            user_text="",
            memory=memory_adapter,
        )
        assert output == expected_output, (raw_text, output)
