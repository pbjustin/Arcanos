from __future__ import annotations

import logging

import pytest

from arcanos.credential_verification import timing_safe_equal_opaque_secret
from tests.credential_observation import assert_no_credential_material


@pytest.mark.parametrize(
    ("provided", "expected", "matches"),
    [
        ("opaque-value", "opaque-value", True),
        ("opaque-value", "opaque-valuf", False),
        ("short", "longer-value", False),
        ("", "", False),
        ("opaque-value", "", False),
        ("", "opaque-value", False),
        ("café-雪", "café-雪", True),
        ("café-雪", "cafe-雪", False),
        ("café", "cafe\u0301", False),
        ("\ud800", "\ud800", True),
        ("\ud800", "\ud801", False),
        ("\U00010000", "\ud800\udc00", False),
        ("CaseSensitive", "casesensitive", False),
        (" padded ", "padded", False),
        ("   ", "   ", True),
        (None, "opaque-value", False),
        (b"opaque-value", "opaque-value", False),
    ],
    ids=(
        "equal-ascii",
        "unequal-same-length",
        "unequal-different-length",
        "both-empty",
        "expected-empty",
        "provided-empty",
        "equal-unicode",
        "unequal-unicode",
        "unicode-normalization-is-not-implicit",
        "equal-lone-surrogate-code-unit",
        "distinct-lone-surrogate-code-units",
        "scalar-and-surrogate-pair-remain-distinct",
        "case-sensitive",
        "whitespace-significant",
        "whitespace-only-is-opaque",
        "missing-value",
        "runtime-non-string",
    ),
)
def test_timing_safe_equal_opaque_secret_contract(
    provided: object,
    expected: object,
    matches: bool,
) -> None:
    assert timing_safe_equal_opaque_secret(provided, expected) is matches


def test_timing_safe_equal_opaque_secret_has_no_shared_length_cap() -> None:
    credential = "λ" * 5_000
    wrong_credential = credential[:-1] + "μ"

    assert timing_safe_equal_opaque_secret(credential, credential) is True
    assert timing_safe_equal_opaque_secret(wrong_credential, credential) is False


def test_timing_safe_equal_opaque_secret_has_no_observable_output(
    capsys, caplog
) -> None:
    credential = "".join(("opaque", "-python-", "credential-marker"))

    with caplog.at_level(logging.DEBUG):
        assert timing_safe_equal_opaque_secret(credential, credential) is True
        assert (
            timing_safe_equal_opaque_secret(credential + "-wrong", credential) is False
        )

    captured = capsys.readouterr()
    observable_output = "\n".join((captured.out, captured.err, caplog.text))
    assert_no_credential_material(credential, observable_output)
