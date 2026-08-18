from __future__ import annotations

import pytest

from arcanos.cli.cli_policy import (
    evaluate_command_policy,
    parse_patch_paths,
    redact_output,
    strip_unsafe_output_controls,
    validate_patch_text,
)


def test_command_policy_allows_configured_prefix(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    decision = evaluate_command_policy("git status --short", cwd=str(tmp_path), timeout_ms=999_999)

    assert decision.allowed is True
    assert decision.timeout_ms == 120_000
    assert decision.cwd == str(tmp_path.resolve())


def test_command_policy_rejects_unconfirmed_dangerous_or_malformed(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))

    assert evaluate_command_policy("rm -rf .", cwd=str(tmp_path)).allowed is False
    assert evaluate_command_policy("git status\nnpm run build", cwd=str(tmp_path)).allowed is False
    assert evaluate_command_policy("node -e \"console.log(1)\"", cwd=str(tmp_path)).reason == "command_not_allowlisted"


def test_command_policy_rejects_legacy_probe_that_can_expose_secrets(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))

    decision = evaluate_command_policy("npm run probe", cwd=str(tmp_path))

    assert decision.allowed is False
    assert decision.reason == "command_not_allowlisted"


def test_redaction_and_truncation_use_shared_policy() -> None:
    secret_name = "OPENAI_API" + "_KEY"
    fake_value = "placeholder-redaction-value"
    redacted = redact_output(f"{secret_name}={fake_value}")

    assert fake_value not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_consumes_complete_quoted_named_assignments(monkeypatch) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    quoted_json = '{"backstage-wwe":["page-a"],"private-universe":["private-page-id"]}'
    cases = [
        (
            f"before {secret_name}='{quoted_json}' after",
            f"before {secret_name}='{replacement}' after",
        ),
        (
            f'{secret_name}="{{\\"backstage-wwe\\":[\\"private-page-id\\"]}}"',
            f'{secret_name}="{replacement}"',
        ),
        (
            f"{secret_name}=private-page-id",
            f"{secret_name}={replacement}",
        ),
        (
            rf"{secret_name}='private\'page-id'",
            f"{secret_name}='{replacement}'",
        ),
        (
            rf'{secret_name}="private\"page-id"',
            f'{secret_name}="{replacement}"',
        ),
        (
            f"{secret_name}='first-private-page-id''adjacent private-page-id' after",
            f"{secret_name}='{replacement}' after",
        ),
        (
            f'{secret_name}={{"page":"private-page-id"}}'
            '"adjacent private-page-id" after',
            f"{secret_name}={replacement} after",
        ),
        (
            f"{secret_name}=private-page-id\\ adjacent-private-page-id after",
            f"{secret_name}={replacement} after",
        ),
        (
            f"{secret_name}=private-page-id^ adjacent-private-page-id after",
            f"{secret_name}={replacement} after",
        ),
    ]

    for source, expected in cases:
        redacted = redact_output(source, apply_truncation=False)
        assert redacted == expected
        assert "private-page-id" not in redacted


def test_redaction_consumes_complete_unquoted_structured_named_assignments(
    monkeypatch,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    nested_json = (
        r'{"private-universe": [{"page": "private-\"page-id", '
        r'"nested": {"pages": ["second-private-page-id"]}}]}'
    )
    multiline_json = "\n".join(
        [
            "{",
            '  "private-universe": [',
            '    "multiline-private-page-id"',
            "  ]",
            "}",
        ]
    )
    cases = [
        (
            f'{secret_name}={{"private-universe": ["spaced-private-page-id"]}} after',
            f"{secret_name}={replacement} after",
        ),
        (
            f"before {secret_name}={nested_json} after",
            f"before {secret_name}={replacement} after",
        ),
        (
            f"{secret_name}={multiline_json}\nNEXT_PUBLIC_VALUE=visible",
            f"{secret_name}={replacement}\nNEXT_PUBLIC_VALUE=visible",
        ),
        (
            f'{secret_name}=[{{"page": "array-private-page-id"}}]; OTHER=value trailing',
            f"{secret_name}={replacement} OTHER=value trailing",
        ),
        (
            f'{secret_name}={{"page":"private-page-id"}}adjacent-private-tail after',
            f"{secret_name}={replacement} after",
        ),
        (
            f'{secret_name}={{"page": "first-private-page-id"}} text '
            f'{secret_name}=["second-private-page-id"] done',
            f"{secret_name}={replacement} text {secret_name}={replacement} done",
        ),
    ]

    for source, expected in cases:
        redacted = redact_output(source, apply_truncation=False)
        assert redacted == expected
        assert "private-page-id" not in redacted


@pytest.mark.parametrize(
    "structured_value",
    [
        '{"private-universe": ["unclosed-private-page-id"]',
        '{"private-universe": ["mismatched-private-page-id"}} trailing-visible',
        '{"private-universe": ["unterminated-private-page-id] } trailing-visible',
        "{'note':'premature } private-page-id'} trailing-visible",
        '{"private-universe": NaN} private-page-id trailing-visible',
        "[" * 65 + '"private-page-id"' + "]" * 65 + " trailing-visible",
    ],
)
def test_redaction_fails_closed_for_malformed_unquoted_structured_assignments(
    monkeypatch,
    structured_value: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )

    redacted = redact_output(
        f"before {secret_name}={structured_value}",
        apply_truncation=False,
    )

    assert redacted == f"before {secret_name}={replacement}"
    assert "private-page-id" not in redacted


@pytest.mark.parametrize(
    "separator",
    ["\u000b", "\u000c", "\ufeff", "\u0085", "\u001c", "\u00a0"],
)
def test_redaction_uses_shared_fail_closed_unicode_assignment_boundaries(
    monkeypatch,
    separator: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    structured = '{"page":"private-page-id"}'

    padded = redact_output(
        f"{secret_name}{separator}={separator}{structured} tail",
        apply_truncation=False,
    )
    adjacent = redact_output(
        f"{secret_name}={structured}{separator}adjacent-private-tail SAFE_FLAG=true",
        apply_truncation=False,
    )

    visible_separator = (
        ""
        if separator in ("\u000b", "\u000c", "\u0085", "\u001c", "\ufeff")
        else separator
    )
    assert padded == (
        f"{secret_name}{visible_separator}={visible_separator}{replacement} tail"
    )
    assert adjacent == f"{secret_name}={replacement} SAFE_FLAG=true"
    assert "private-page-id" not in padded
    assert "private-page-id" not in adjacent


@pytest.mark.parametrize("prefix", ["é", "界", "K"])
def test_redaction_uses_ascii_env_name_boundary_after_unicode_prefix(
    monkeypatch,
    prefix: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )

    redacted = redact_output(
        f'{prefix}{secret_name}={{"page":"private-page-id"}} tail',
        apply_truncation=False,
    )

    assert redacted == f"{prefix}{secret_name}={replacement} tail"


def test_redaction_rejects_ascii_prefixes_and_unicode_case_fold_spoofs(
    monkeypatch,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    value = '{"page":"private-page-id"}'
    spoofed_name = secret_name.replace("I", "ı", 1)

    ascii_prefixed = redact_output(
        f"X{secret_name}={value}",
        apply_truncation=False,
    )
    spoofed = redact_output(
        f"{spoofed_name}={value}",
        apply_truncation=False,
    )

    assert ascii_prefixed == f"X{secret_name}={value}"
    assert spoofed == f"{spoofed_name}={value}"


def test_redaction_normalizes_ansi_and_unsafe_controls_before_named_redaction(
    monkeypatch,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    colored_name = secret_name.replace("NOTION", "NOT\x1b[31mION\x1b[0m")
    source = (
        f"\x1b[36m{colored_name}\x1b[0m\u202e=\x1b[32m"
        '{ "page": [ "private-page-id" ] }\x1b[0m tail'
    )
    dcs_name = secret_name.replace("NOTION", "NOT\x1bPqhidden\x1b\\ION")
    apc_name = secret_name.replace("NOTION", "NOT\x9fhidden\x9cION")
    decsc_name = secret_name.replace("NOTION", "NOT\x1b7ION")

    redacted = redact_output(source, apply_truncation=False)
    dcs_redacted = redact_output(
        f'{dcs_name}={{"page":"private-page-id"}} tail',
        apply_truncation=False,
    )
    apc_redacted = redact_output(
        f'{apc_name}={{"page":"private-page-id"}} tail',
        apply_truncation=False,
    )
    decsc_redacted = redact_output(
        f'\x1b7{decsc_name}={{"page":"private-page-id"}} tail',
        apply_truncation=False,
    )
    unterminated_osc = redact_output(
        f"{secret_name}=\x1b]unterminated-private-page-id",
        apply_truncation=False,
    )

    assert redacted == f"{secret_name}={replacement} tail"
    assert dcs_redacted == f"{secret_name}={replacement} tail"
    assert apc_redacted == f"{secret_name}={replacement} tail"
    assert decsc_redacted == f"{secret_name}={replacement} tail"
    assert unterminated_osc == f"{secret_name}="


@pytest.mark.parametrize(
    ("name", "terminal_sequence"),
    [
        ("CSI with a default ignorable", "\x1b[3\u200b1m"),
        ("CSI with NUL", "\x1b[3\x001m"),
        ("CSI with BEL", "\x1b[3\x071m"),
        ("CSI with C1 ST", "\x1b[3\x9c1m"),
        ("CSI with nested C1 CSI", "\x1b[3\x9b1m"),
        ("C1 CSI with NUL", "\x9b3\x001m"),
        ("C1 CSI with BEL", "\x9b3\x071m"),
        ("C1 CSI with C1 ST", "\x9b3\x9c1m"),
        ("generic ESC with NUL", "\x1b\x007"),
        ("generic ESC with BEL", "\x1b\x077"),
        ("generic ESC with C1 ST", "\x1b\x9c7"),
        ("generic ESC with nested ESC", "\x1b\x1b7"),
        ("C1 CSI before an ESC CSI", "\x9b\x1b[31m"),
        ("ESC before a C1 CSI", "\x1b\x9b31m"),
        ("C1 CSI before a generic ESC", "\x9b\x1b7"),
        ("ESC before a C1 OSC", "\x1b\x9d0;hidden\x07"),
        ("CSI introducer split by NUL", "\x1b\x00[31m"),
        ("CSI introducer split by BEL", "\x1b\x07[31m"),
        ("CSI introducer split by C1 ST", "\x1b\x9c[31m"),
        ("DCS with a default ignorable", "\x1bPqhid\u200bden\x1b\\"),
        ("DCS with NUL", "\x1bPqhid\x00den\x1b\\"),
        ("OSC with a default ignorable", "\x1b]0;hid\u200bden\x07"),
        ("OSC with NUL", "\x1b]0;hid\x00den\x07"),
        ("OSC with earlier equals noise", "\x1b]0;foo=bar\x07"),
    ],
)
def test_redaction_fail_closed_for_controls_embedded_in_terminal_grammar(
    monkeypatch,
    name: str,
    terminal_sequence: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    obfuscated_name = secret_name.replace(
        "NOTION",
        f"NOT{terminal_sequence}ION",
    )

    redacted = redact_output(
        f'{obfuscated_name}={{"page":"private-page-id"}} tail',
        apply_truncation=False,
    )

    assert redacted == f"{secret_name}={replacement} tail", name
    assert "private-page-id" not in redacted


@pytest.mark.parametrize(
    ("name", "terminal_sequence", "visible_infix"),
    [
        ("CSI ending at a nested ESC", "\x1b[3\x1b1m", "m"),
        ("C1 CSI consuming the next letter", "\x1b\x9b7", ""),
        ("DCS ending at an early C1 ST", "\x1bPqhid\x9cden\x1b\\", "den"),
        ("C1 DCS ending at an early ST", "\x90qhid\x9cden\x9c", "den"),
        ("OSC ending at an early BEL", "\x1b]0;hid\x07den\x07", "den"),
        ("OSC ending at an early C1 ST", "\x1b]0;hid\x9cden\x07", "den"),
        ("C1 OSC ending at an early BEL", "\x9d0;hid\x07den\x9c", "den"),
    ],
)
def test_redaction_preserves_genuine_visible_terminal_mutations(
    monkeypatch,
    name: str,
    terminal_sequence: str,
    visible_infix: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": "[REDACTED]",
                "envNames": [secret_name],
            }
        },
    )
    source_name = secret_name.replace(
        "NOTION",
        f"NOT{terminal_sequence}ION",
    )
    visible_name = secret_name.replace("NOTION", f"NOT{visible_infix}ION")
    if name == "C1 CSI consuming the next letter":
        visible_name = secret_name.replace("NOTION", "NOTON")

    assert redact_output(
        f"{source_name}=PUBLIC_SENTINEL tail",
        apply_truncation=False,
    ) == f"{visible_name}=PUBLIC_SENTINEL tail"


def test_redaction_does_not_collapse_visible_env_name_supersequences(
    monkeypatch,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    dotted_name = ".".join(secret_name)
    sources_and_expected = [
        (
            f"{secret_name}_SUFFIX=PUBLIC_SENTINEL",
            f"{secret_name}_SUFFIX=PUBLIC_SENTINEL",
        ),
        (
            f"{secret_name}-other=PUBLIC_SENTINEL",
            f"{secret_name}-other=PUBLIC_SENTINEL",
        ),
        (
            f"{secret_name} text=PUBLIC_SENTINEL",
            f"{secret_name} text=PUBLIC_SENTINEL",
        ),
        (
            f"{secret_name}\u200b_SUFFIX=PUBLIC_SENTINEL",
            f"{secret_name}_SUFFIX=PUBLIC_SENTINEL",
        ),
        (
            f"{secret_name}\x1b[31m_SUFFIX=PUBLIC_SENTINEL",
            f"{secret_name}_SUFFIX=PUBLIC_SENTINEL",
        ),
        (
            f"{secret_name}\u200b ordinary label=PUBLIC_SENTINEL",
            f"{secret_name} ordinary label=PUBLIC_SENTINEL",
        ),
        (
            f"{dotted_name}\u200b=PUBLIC_SENTINEL",
            f"{dotted_name}=PUBLIC_SENTINEL",
        ),
        (
            f"A\u200b=PUBLIC_{secret_name[1:]}=SECOND",
            f"A=PUBLIC_{secret_name[1:]}=SECOND",
        ),
    ]
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": "[REDACTED]",
                "envNames": [secret_name],
            }
        },
    )

    for source, expected in sources_and_expected:
        redacted = redact_output(source, apply_truncation=False)

        assert redacted == expected
        assert "[REDACTED]" not in redacted


def test_terminal_scanner_preserves_record_separators_only_outside_sequences(
) -> None:
    source = "A\x00B\x1fC\x1b[3\x001mD\x1b\x1f7E"

    assert strip_unsafe_output_controls(source) == "ABCDE"
    assert strip_unsafe_output_controls(
        source,
        preserve_record_separators=True,
    ) == "A\x00B\x1fC\x001mD\x1f7E"


@pytest.mark.parametrize(
    ("boundary", "visible_boundary"),
    [
        ("\t", "\t"),
        ("\n", "\n"),
        ("\r", "\r"),
        ("\x85", ""),
        ("\u2028", "\u2028"),
        ("\u2029", "\u2029"),
    ],
)
def test_terminal_scanner_stops_at_output_record_boundaries(
    boundary: str,
    visible_boundary: str,
) -> None:
    source = f"A\x1b[31{boundary}mB"

    assert strip_unsafe_output_controls(source) == f"A{visible_boundary}mB"


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("A\x1b\n7B", "A\n7B"),
        ("A\x9b31\nmB", "A\nmB"),
        ("A\x1bPpayload\ntail\x1b\\B", "A\ntailB"),
        ("A\x1b]payload\ntail\x07B", "A\ntailB"),
    ],
)
def test_every_terminal_scanner_state_stops_at_record_boundaries(
    source: str,
    expected: str,
) -> None:
    assert strip_unsafe_output_controls(source) == expected


@pytest.mark.parametrize(
    ("boundary", "visible_boundary"),
    [
        ("\t", "\t"),
        ("\n", "\n"),
        ("\r", "\r"),
        ("\x85", ""),
        ("\u2028", "\u2028"),
        ("\u2029", "\u2029"),
    ],
)
def test_record_boundaries_prevent_sensitive_name_reconstruction(
    monkeypatch,
    boundary: str,
    visible_boundary: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": "[REDACTED]",
                "envNames": [secret_name],
            }
        },
    )
    source_name = secret_name.replace(
        "NOTION",
        f"NOT\x1b[31{boundary}mION",
    )
    visible_name = secret_name.replace(
        "NOTION",
        f"NOT{visible_boundary}mION",
    )

    redacted = redact_output(
        f"{source_name}=PUBLIC_SENTINEL tail",
        apply_truncation=False,
    )

    assert redacted == f"{visible_name}=PUBLIC_SENTINEL tail"
    assert "[REDACTED]" not in redacted


@pytest.mark.parametrize("boundary", ["\x00", "\x1f"])
def test_preserved_record_separators_prevent_sensitive_name_reconstruction(
    monkeypatch,
    boundary: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": "[REDACTED]",
                "envNames": [secret_name],
            }
        },
    )
    source_name = secret_name.replace(
        "NOTION",
        f"NOT\x1b[31{boundary}mION",
    )
    source = f"{source_name}=PUBLIC_SENTINEL tail"
    visible_name = secret_name.replace(
        "NOTION",
        f"NOT{boundary}mION",
    )

    assert redact_output(source, apply_truncation=False) == (
        f"{secret_name}=[REDACTED] tail"
    )
    assert redact_output(
        source,
        apply_truncation=False,
        preserve_record_separators=True,
    ) == f"{visible_name}=PUBLIC_SENTINEL tail"


@pytest.mark.parametrize(
    ("name", "invisible", "placement"),
    [
        ("zero-width space", "\u200b", "inside_name"),
        ("word joiner", "\u2060", "before_equals"),
        ("byte-order mark", "\ufeff", "inside_name"),
        ("soft hyphen", "\u00ad", "inside_name"),
        ("combining grapheme joiner", "\u034f", "inside_name"),
        ("Hangul choseong filler", "\u115f", "inside_name"),
        ("Khmer inherent vowel", "\u17b4", "inside_name"),
        ("Mongolian variation selector", "\u180b", "inside_name"),
        ("variation selector-16", "\ufe0f", "inside_name"),
        ("Hangul filler", "\u3164", "inside_name"),
        ("halfwidth Hangul filler", "\uffa0", "inside_name"),
        ("reserved default ignorable", "\ufff8", "inside_name"),
        ("shorthand format letter overlap", "\U0001bca0", "inside_name"),
        ("musical symbol begin beam", "\U0001d173", "inside_name"),
        ("language tag", "\U000e0001", "inside_name"),
        ("variation selector supplement", "\U000e0100", "inside_name"),
    ],
)
def test_redaction_normalizes_default_ignorables_before_named_redaction(
    monkeypatch,
    name: str,
    invisible: str,
    placement: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    obfuscated_name = (
        f"{secret_name}{invisible}"
        if placement == "before_equals"
        else secret_name.replace("NOTION", f"NOT{invisible}ION")
    )

    redacted = redact_output(
        f'{obfuscated_name}={{"page":"private-page-id"}} tail',
        apply_truncation=False,
    )

    assert redacted == f"{secret_name}={replacement} tail", name
    assert "private-page-id" not in redacted


def test_redaction_preserves_non_ignorable_unicode_inside_other_names(
    monkeypatch,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    ordinary_name = secret_name.replace("NOTION", "NOT\u00e9ION")
    source = f'{ordinary_name}={{"page":"visible-page-id"}} tail'

    assert redact_output(source, apply_truncation=False) == source


def test_redaction_validates_large_json_numbers_without_weakening_redaction(
    monkeypatch,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    large_number = "9" * 5000

    redacted = redact_output(
        f'{secret_name}={{"number":{large_number}}} SAFE_FLAG=true',
        apply_truncation=False,
    )

    assert redacted == f"{secret_name}={replacement} SAFE_FLAG=true"


@pytest.mark.parametrize("quote", ["'", '"'])
def test_redaction_fails_closed_for_unmatched_quoted_named_assignments(
    monkeypatch,
    quote: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )

    redacted = redact_output(
        f"before {secret_name}={quote}private page id and sensitive suffix",
        apply_truncation=False,
    )

    assert redacted == f"before {secret_name}={quote}{replacement}{quote}"
    assert "private page id" not in redacted
    assert "sensitive suffix" not in redacted


@pytest.mark.parametrize(
    "assignment_value",
    [
        "`private-page-id` SAFE_FLAG=true",
        "private-page-id`adjacent-private-tail SAFE_FLAG=true",
    ],
)
def test_redaction_fails_closed_for_backticks_in_named_assignments(
    monkeypatch,
    assignment_value: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )

    redacted = redact_output(
        f"{secret_name}={assignment_value}",
        apply_truncation=False,
    )

    assert redacted == f"{secret_name}={replacement}"
    assert "private-page-id" not in redacted


def test_shared_policy_redacts_backstage_notion_credentials() -> None:
    access_token_name = "ARCANOS_BACKSTAGE_NOTION_ACCESS_" + "TOKEN"
    universe_pages_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    fake_token = "placeholder-notion-access-token"
    fake_page_id = "placeholder-private-page-id"
    output = "\n".join(
        [
            f"{access_token_name}={fake_token}",
            f'{universe_pages_name}=\'{{"private-universe":["{fake_page_id}"]}}\'',
        ]
    )

    redacted = redact_output(output, apply_truncation=False)

    assert redacted == "\n".join(
        [
            f"{access_token_name}=[REDACTED]",
            f"{universe_pages_name}='[REDACTED]'",
        ]
    )
    assert fake_token not in redacted
    assert fake_page_id not in redacted


def test_patch_policy_rejects_secret_paths_and_sensitive_content(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))

    env_patch = "\n".join([
        "diff --git a/.env b/.env",
        "--- a/.env",
        "+++ b/.env",
        "@@ -1 +1 @@",
        "-OLD=1",
        "+OPENAI_API" + "_KEY=placeholder-redaction-value",
    ])
    key_patch = "\n".join([
        "diff --git a/key.txt b/key.txt",
        "--- a/key.txt",
        "+++ b/key.txt",
        "@@ -0,0 +1,3 @@",
        "+-----BEGIN OPENSSH PRIVATE KEY-----",
        "+secret",
        "+-----END OPENSSH PRIVATE KEY-----",
    ])

    assert validate_patch_text(env_patch, str(tmp_path)).reason == "patch_targets_secret_file"
    assert validate_patch_text(key_patch, str(tmp_path)).reason == "patch_denied_by_policy"


def test_patch_policy_decodes_git_quoted_octal_secret_paths(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    patch = "\n".join(
        [
            r'diff --git "a/\056env" "b/\056env"',
            r'--- "a/\056env"',
            r'+++ "b/\056env"',
            "@@ -1 +1 @@",
            "-old",
            "+new",
        ]
    )

    decision = validate_patch_text(patch, str(tmp_path))

    assert decision.reason == "patch_targets_secret_file"
    assert decision.files == [".env"]


def test_patch_policy_rejects_malformed_git_path_escapes(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))

    for encoded_path in (r"\05env", r"\qenv", r"\400env"):
        patch = "\n".join(
            [
                f'diff --git "a/{encoded_path}" "b/{encoded_path}"',
                f'--- "a/{encoded_path}"',
                f'+++ "b/{encoded_path}"',
            ]
        )
        assert (
            validate_patch_text(patch, str(tmp_path)).reason == "patch_path_malformed"
        )
    unterminated = 'diff --git "a/safe.txt b/safe.txt'
    assert (
        validate_patch_text(unterminated, str(tmp_path)).reason
        == "patch_path_malformed"
    )


def test_patch_policy_preserves_git_quoted_unicode_and_spaces(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    patch = "\n".join(
        [
            r'diff --git "a/caf\303\251 notes.txt" "b/caf\303\251 notes.txt"',
            r'--- "a/caf\303\251 notes.txt"',
            r'+++ "b/caf\303\251 notes.txt"',
            "@@ -1 +1 @@",
            "-old",
            "+new",
        ]
    )

    decision = validate_patch_text(patch, str(tmp_path))

    assert decision.allowed is True
    assert parse_patch_paths(patch) == ["café notes.txt"]


def test_git_paths_preserve_legitimate_default_ignorables_while_output_strips_them(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    unicode_path = "emoji\u200d\ufe0f.txt"
    patch = "\n".join(
        [
            f'diff --git "a/{unicode_path}" "b/{unicode_path}"',
            f'--- "a/{unicode_path}"',
            f'+++ "b/{unicode_path}"',
            "@@ -1 +1 @@",
            "-old",
            "+new",
        ]
    )

    decision = validate_patch_text(patch, str(tmp_path))

    assert decision.allowed is True
    assert parse_patch_paths(patch) == [unicode_path]
    assert strip_unsafe_output_controls(f"A\u200d\ufe0fB") == "AB"


def test_patch_policy_rejects_binary_traversal_and_symlink(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))

    traversal = "diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n"
    binary = "diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 0\n"
    symlink = "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n"
    converted_symlink = (
        "diff --git a/link b/link\n"
        "old mode 100644\n"
        "new mode 120000\n"
        "--- a/link\n"
        "+++ b/link\n"
    )

    assert validate_patch_text(traversal, str(tmp_path)).reason == "patch_path_outside_sandbox"
    assert validate_patch_text(binary, str(tmp_path)).reason == "patch_denied_by_policy"
    assert validate_patch_text(symlink, str(tmp_path)).reason == "patch_denied_by_policy"
    assert validate_patch_text(converted_symlink, str(tmp_path)).reason == "patch_denied_by_policy"
    existing = tmp_path / "existing-link"
    try:
        existing.symlink_to(tmp_path / "target")
    except OSError:
        return
    existing_patch = "diff --git a/existing-link b/existing-link\n--- a/existing-link\n+++ b/existing-link\n"
    assert validate_patch_text(existing_patch, str(tmp_path)).reason == "patch_symlink_not_allowed"


@pytest.mark.parametrize(
    "unsafe_path",
    [
        "normal.txt:stream",
        ".env:stream",
        "normal.txt::$DATA",
        "nested/file.txt:stream",
    ],
)
def test_patch_policy_rejects_windows_alternate_data_stream_paths(
    monkeypatch,
    tmp_path,
    unsafe_path: str,
) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    patch = "\n".join(
        [
            f"diff --git a/{unsafe_path} b/{unsafe_path}",
            "new file mode 100644",
            "--- /dev/null",
            f"+++ b/{unsafe_path}",
            "@@ -0,0 +1 @@",
            "+hidden",
            "",
        ]
    )

    decision = validate_patch_text(patch, str(tmp_path))

    assert decision.allowed is False
    assert decision.reason == "patch_path_outside_sandbox"


def test_safe_patch_preview_redacts_added_lines(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    patch = "\n".join([
        "diff --git a/sample.txt b/sample.txt",
        "--- a/sample.txt",
        "+++ b/sample.txt",
        "@@ -1 +1 @@",
        "-old",
        "+to" + "ken=placeholder-redaction-value",
    ])

    decision = validate_patch_text(patch, str(tmp_path))

    assert decision.allowed is True
    assert decision.patch_hash
    assert "placeholder-redaction-value" not in decision.redacted_preview
    assert "+[redacted added line]" in decision.redacted_preview
