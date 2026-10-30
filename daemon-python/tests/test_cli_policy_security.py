from __future__ import annotations

import json

import pytest

from arcanos.cli.cli_policy import (
    evaluate_command_policy,
    parse_patch_paths,
    redact_output,
    strip_unsafe_output_controls,
    validate_patch_text,
)


@pytest.mark.parametrize("attributes", [
    "; HttpOnly; Secure; SameSite=Lax",
    "; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure",
    "; Partitioned; Path=/",
])
def test_set_cookie_credentials_stay_private_with_standard_attributes(attributes) -> None:
    """Cookie attribute flags must not bypass redaction or remove later failures."""
    source = f"Set-Cookie: session=fixture-value{attributes}\nThe task failed."
    assert redact_output(source, apply_truncation=False) == "Set-Cookie: [REDACTED]\nThe task failed."


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


@pytest.mark.parametrize("name", [
    "ARCANOS_DAEMON_ACCESS_TOKEN", "BACKEND_TOKEN", "DEBUG_SERVER_TOKEN",
    "ARCANOS_CLI_BRIDGE_TOKEN", "password", "api_key", "apiKey", "cookie",
])
def test_credential_assignments_preserve_complete_failure_qualifications(name) -> None:
    source = f'{name}="fixture credential with spaces"\nThe requested task failed.'
    expected = f'{name}="[REDACTED]"\nThe requested task failed.'
    assert redact_output(source, apply_truncation=False) == expected


@pytest.mark.parametrize("secret_value", [
    "fixture credential with spaces", 'fixture "quoted" credential',
    {"nested": ["fixture credential"]}, ["fixture credential"], 12345,
])
def test_json_credential_redaction_preserves_structure_and_status(secret_value) -> None:
    source = json.dumps({"status": "failed", "password": secret_value, "retryable": True})
    redacted = redact_output(source, apply_truncation=False)
    assert json.loads(redacted) == {
        "status": "failed", "password": "[REDACTED]", "retryable": True,
    }


def test_json_and_header_credentials_do_not_expose_opaque_values() -> None:
    source = '{"BACKEND_TOKEN":"fixture token", "api_key":"fixture key", "status":"failed"}'
    assert json.loads(redact_output(source, apply_truncation=False)) == {
        "BACKEND_TOKEN": "[REDACTED]", "api_key": "[REDACTED]", "status": "failed",
    }
    assert redact_output("Authorization: Bearer short-fixture\nTask failed.", apply_truncation=False) == (
        "Authorization: [REDACTED]\nTask failed."
    )


@pytest.mark.parametrize(("name", "credential"), [
    ("Password", "sunshine"),
    ("Token", "orchard"),
    ("Secret", "maple"),
    ("api_key", "cedar"),
    ("Authorization", "birch"),
    ("Cookie", "elm"),
    ("Password", "s7"),
    ("Token", "!?"),
    ("Password", "***"),
    ("Secret", "_"),
])
def test_single_token_credentials_keep_failures_and_json_valid(name, credential) -> None:
    """Short credentials stay private without truncation or repeated-redaction drift."""
    failure = '\nThe operation failed.\n\nKeep "It is exact" and the final qualification.'
    source = f"{name}: {credential}{failure}"
    expected = f"{name}: [REDACTED]{failure}"
    redacted = redact_output(source, apply_truncation=False)
    assert redacted == expected
    assert redact_output(redacted, apply_truncation=False) == expected
    assert redact_output(source, apply_truncation=False, preserve_literal_unicode=True) == expected
    payload = {name: credential, "status": "failed", "explanation": "It is exact"}
    safe_json = redact_output(json.dumps(payload), apply_truncation=False)
    assert json.loads(safe_json) == {**payload, name: "[REDACTED]"}


@pytest.mark.parametrize("source", [
    "- **Token:**\n  a short-lived credential.",
    "- __Password:__\n  must be 12 characters.",
    "`Authorization:`\nrequired for every endpoint.",
])
def test_markdown_label_delimiters_are_not_credential_values(source) -> None:
    """An otherwise empty Markdown label must not be mistaken for a short secret."""
    assert redact_output(source, apply_truncation=False) == source


def test_non_secret_status_fields_remain_unchanged() -> None:
    source = '{"token_count":12,"token_status":"expired","authorization_status":"failed","status":"pending"}'
    assert redact_output(source, apply_truncation=False) == source


@pytest.mark.parametrize("source", [
    "- **Token:** a short-lived credential",
    "Password: must be 12 characters",
    "Authorization: required for every endpoint",
    "api_key: use your dashboard value",
    "Cookie: stores a browser preference in this example.",
    "Secret: a value you should keep private.",
    "- **Password:** must be 12 characters",
    "Token: **a short-lived credential**",
    "- **Authorization:** **required** for every endpoint",
    "Password: 12-character minimum is enforced.",
    "Token: SHA-256 identifies the hash algorithm.",
    "Authorization: RFC6750 describes bearer token usage.",
    "Cookie: SameSite=Lax prevents some cross-site requests.",
    "Password: must be 12 characters.",
    "Authorization: required for every endpoint.",
    "Token: a short-lived credential.",
    "Cookie: stores a browser preference.",
])
def test_unquoted_glossary_labels_preserve_the_complete_explanation(source) -> None:
    """Ordinary labelled explanations and Markdown emphasis are answer content."""
    assert redact_output(source, apply_truncation=False) == source
    assert redact_output(source, apply_truncation=False, preserve_literal_unicode=True) == source


@pytest.mark.parametrize(("source", "sensitive_value"), [
    ("Password: P@ssw0rd!", "P@ssw0rd!"),
    ("Password: 123456", "123456"),
    ("Token: 123456", "123456"),
    ("Authorization: Bearer fixture-example-credential", "fixture-example-credential"),
    ("Authorization: Bearer short", "short"),
    ("Authorization: Basic Zml4dHVyZTpmaXh0dXJl", "Zml4dHVyZTpmaXh0dXJl"),
    ("Cookie: session=fixture-value", "fixture-value"),
    ("ARCANOS_DAEMON_ACCESS_TOKEN: fixture-value", "fixture-value"),
    ("BACKEND_TOKEN: fixture-value", "fixture-value"),
    ("OPENAI_API_KEY: fixture-value", "fixture-value"),
])
def test_credential_shaped_colon_fields_keep_failures_and_hide_values(source, sensitive_value) -> None:
    """Narrowing prose detection must retain credential and HTTP-header protection."""
    failure = "\nThe requested task failed; nothing was completed."
    redacted = redact_output(source + failure, apply_truncation=False)
    assert sensitive_value not in redacted
    assert "[REDACTED]" in redacted
    assert redacted.endswith(failure)
    assert redact_output(redacted, apply_truncation=False) == redacted


@pytest.mark.parametrize("name", ["Token", "Secret", "api_key", "Password"])
@pytest.mark.parametrize(("span", "tail"), [
    ("[OAuth docs]", "(https://example.com) explains this."),
    ("{placeholder}", " explains this."),
    ("[alpha, beta]", " are documented here."),
    ("[OAuth's docs]", "(https://example.com) explains this."),
    ("{'note':'premature } private-fixture'}", " explains this."),
    ("['premature ] private-fixture']", " explains this."),
    ("{'note':'escaped \\' } private-fixture'}", " explains this."),
    ("[{'note': ['premature ]', {'key': 'private } fixture'}]}]", " explains this."),
])
def test_balanced_non_json_colon_values_redact_only_the_bounded_span(name, span, tail) -> None:
    """Ambiguous bracketed values must not discard later prose or later redaction."""
    source = f"{name}: {span}{tail}\n\nMore content.\nPassword: sunshine\nThe task failed."
    expected = f"{name}: [REDACTED]{tail}\n\nMore content.\nPassword: [REDACTED]\nThe task failed."
    redacted = redact_output(source, apply_truncation=False)

    assert redacted == expected
    assert redact_output(redacted, apply_truncation=False) == expected
    assert redact_output(source, apply_truncation=False, preserve_literal_unicode=True) == expected


@pytest.mark.parametrize(("assignment", "expected"), [
    ("Token: [unterminated", "Token: [REDACTED]"),
    ("Token: {'note':'unclosed }", "Token: [REDACTED]"),
    ("Token: ['escaped \\' ]", "Token: [REDACTED]"),
    ("Token=[OAuth docs]", "Token=[REDACTED]"),
    ('"Token": [OAuth docs]', '"Token": "[REDACTED]"'),
    ("BACKEND_TOKEN: [OAuth docs]", "BACKEND_TOKEN: [REDACTED]"),
])
def test_unterminated_or_explicit_non_json_assignments_keep_fail_closed_tail_handling(
    assignment, expected
) -> None:
    """Only balanced ambiguous colon fields gain a bounded non-JSON interpretation."""
    source = f"{assignment} trailing-private-fixture\n\nMore content."
    redacted = redact_output(source, apply_truncation=False)

    assert redacted == expected
    assert redact_output(redacted, apply_truncation=False) == expected


def test_balanced_json_credential_fields_keep_following_status_and_explanation() -> None:
    """Strict JSON values retain their established bounded redaction contract."""
    source = '{"Token": {"fixture": ["private-value"]}, "status": "failed"}\n\nMore content.'
    expected = '{"Token": "[REDACTED]", "status": "failed"}\n\nMore content.'
    redacted = redact_output(source, apply_truncation=False)

    assert redacted == expected
    assert redact_output(redacted, apply_truncation=False) == expected


@pytest.mark.parametrize("scheme", ["Token", "ApiKey", "Negotiate", "OAuth", "AWS4-HMAC-SHA256"])
def test_additional_authorization_schemes_keep_credentials_private_and_failure_complete(scheme) -> None:
    """Credential-bearing header schemes do not become public explanatory prose."""
    failure = "\n\nBackend unavailable; the requested task was not completed."
    source = f"Authorization: {scheme} fixture12345{failure}"
    expected = f"Authorization: [REDACTED]{failure}"
    redacted = redact_output(source, apply_truncation=False)

    assert redacted == expected
    assert redact_output(redacted, apply_truncation=False) == expected
    assert redact_output(source, apply_truncation=False, preserve_literal_unicode=True) == expected


@pytest.mark.parametrize(("scheme", "credential"), [
    ("Token", "sunshine"),
    ("ApiKey", "orchid"),
    ("OAuth", "maple"),
    ("Negotiate", "example"),
    ("Custom.Auth", "a"),
    ("X+", "sunshine"),
    ("X!", "orchid"),
    ("X-Custom_v1", "elm"),
    ("Bearer", "pine"),
    ("Basic", "oak"),
    ("Digest", "ash"),
    ("Custom-Params", "fixture12345, Signature=fixture-value"),
])
def test_authorization_single_token_credentials_have_no_length_or_digit_requirement(
    scheme, credential
) -> None:
    failure = "\nThe operation failed.\n\nNo requested task was completed."
    source = f"Authorization: {scheme} {credential}{failure}"
    expected = f"Authorization: [REDACTED]{failure}"

    assert redact_output(source, apply_truncation=False) == expected
    assert redact_output(expected, apply_truncation=False) == expected
    assert redact_output(source, apply_truncation=False, preserve_literal_unicode=True) == expected


def test_two_word_authorization_explanations_choose_privacy_conservatively() -> None:
    """A scheme-like two-word explanation cannot reliably be distinguished from a header."""
    assert redact_output("Authorization: requires authentication", apply_truncation=False) == (
        "Authorization: [REDACTED]"
    )


def test_authorization_quoted_json_values_keep_valid_json_and_failure_context() -> None:
    source = '{"Authorization":"Token sunshine","status":"failed","warning":"No task completed."}'
    redacted = redact_output(source, apply_truncation=False)
    assert json.loads(redacted) == {
        "Authorization": "[REDACTED]", "status": "failed", "warning": "No task completed."
    }
    assert redact_output(redacted, apply_truncation=False) == redacted


@pytest.mark.parametrize("header_value", [
    'Custom realm="example", credential="sunshine"',
    'Signature keyId="example", signature="orchid"',
    'X+ realm="example", credential="sunshine"',
    "X-Custom_v1 realm=example, credential=maple",
    'Custom realm = "example", credential = "elm"',
    'Custom realm="example, quoted", credential="birch"',
    'Custom realm="escaped \\" quote", credential="cedar"',
])
def test_parameterized_custom_authorization_headers_redact_alphabetic_credentials(
    header_value,
) -> None:
    """Valid auth-param lists stay private without relying on credential digits."""
    failure = '\nThe operation failed.\n\nKeep "It is exact" and the final qualification.'
    source = f"Authorization: {header_value}{failure}"
    expected = f"Authorization: [REDACTED]{failure}"

    assert redact_output(source, apply_truncation=False) == expected
    assert redact_output(expected, apply_truncation=False) == expected
    assert redact_output(source, apply_truncation=False, preserve_literal_unicode=True) == expected


@pytest.mark.parametrize(("source", "escaped_key", "expected"), [
    (
        r'{ "\u0070assword" : "sunshine", "status" : "failed" }',
        r'"\u0070assword"',
        {"password": "[REDACTED]", "status": "failed"},
    ),
    (
        r'{"items":[{"\u0074oken":["sunshine",{"value":"orchid"}]}],"status":"failed"}',
        r'"\u0074oken"',
        {"items": [{"token": "[REDACTED]"}], "status": "failed"},
    ),
    (
        r'{"outer":{"nested":[{"api\u005fkey":{"value":"sunshine"}}]},"status":"failed"}',
        r'"api\u005fkey"',
        {"outer": {"nested": [{"api_key": "[REDACTED]"}]}, "status": "failed"},
    ),
    (
        r'{"\u004fPENAI_API_KEY":"sunshine","status":"failed"}',
        r'"\u004fPENAI_API_KEY"',
        {"OPENAI_API_KEY": "[REDACTED]", "status": "failed"},
    ),
    (
        r'[{"\u0070assword":"sunshine"},{"status":"failed"}]',
        r'"\u0070assword"',
        [{"password": "[REDACTED]"}, {"status": "failed"}],
    ),
    (
        r'{"\u0041uthorization":"Custom realm=\"example\", credential=\"sunshine\"","status":"failed"}',
        r'"\u0041uthorization"',
        {"Authorization": "[REDACTED]", "status": "failed"},
    ),
])
def test_escaped_json_credential_keys_redact_values_in_nested_containers(
    source, escaped_key, expected,
) -> None:
    """JSON escapes cannot disguise sensitive field names or break safe fields."""
    redacted = redact_output(source, apply_truncation=False)

    assert json.loads(redacted) == expected
    assert escaped_key in redacted
    assert redact_output(redacted, apply_truncation=False) == redacted
    assert redact_output(source, apply_truncation=False, preserve_literal_unicode=True) == redacted


def test_escaped_json_configured_field_names_use_the_shared_policy(monkeypatch) -> None:
    monkeypatch.setattr("arcanos.cli.cli_policy.load_cli_policy", lambda: {
        "redactionPolicy": {"replacement": "[REDACTED]", "envNames": ["CUSTOM_HEADER"]},
    })
    source = r'{"nested":[{"\u0043USTOM_HEADER":"sunshine"}],"status":"failed"}'
    redacted = redact_output(source, apply_truncation=False)

    assert json.loads(redacted) == {
        "nested": [{"CUSTOM_HEADER": "[REDACTED]"}], "status": "failed",
    }
    assert redact_output(redacted, apply_truncation=False) == redacted


@pytest.mark.parametrize("source", [
    '{\n  "message": "🛡️ 👩‍💻",\n  "status": "failed",\n  "count": 1e+02\n}\n',
    r'{ "note" : "\\u0070assword is a literal escape", "status" : "failed" }',
    r'{"note":"\\u0061udit_trace and \\u001b are literal text","path":"C:\\fixture\\file"}',
    r'{"example":"{\"\\u0061udit_trace\": \"a quoted field example\"}","status":"failed"}',
])
def test_safe_json_bytes_and_literal_value_escapes_are_preserved(source) -> None:
    """Decoded field inspection must not rewrite safe JSON or reinterpret its values."""
    assert json.loads(source)
    assert redact_output(source, apply_truncation=False, preserve_literal_unicode=True) == source


@pytest.mark.parametrize("prefix", ['He said "hello. ', 'He said "hello.\n'])
def test_escaped_json_credentials_after_unmatched_prose_quotes_stay_private(prefix):
    source = prefix + r'{"pass\u0077ord":"sunshine","status":"failed"}' + "\nFinal qualification."
    assert redact_output(source, apply_truncation=False) == source.replace("sunshine", "[REDACTED]")


@pytest.mark.parametrize("raw_value", [
    "123SYNTHETICFIXTURE", "trueSYNTHETICFIXTURE",
    "{}SYNTHETICFIXTURE", "[]SYNTHETICFIXTURE",
])
def test_escaped_json_credentials_do_not_accept_value_prefixes(raw_value):
    source = r'{"pass\u0077ord":' + raw_value + "}"
    redacted = redact_output(source, apply_truncation=False)
    assert "SYNTHETICFIXTURE" not in redacted
    assert "[REDACTED]" in redacted
    assert redact_output(redacted, apply_truncation=False) == redacted


def test_duplicate_and_overlapping_escaped_json_credentials_stay_private():
    source = r'{"pass\u0077ord":"sunshine","pass\u0077ord":{"nested":{"\u0074oken":"orchard"}},"status":"failed"}'
    expected = r'{"pass\u0077ord":"[REDACTED]","pass\u0077ord":"[REDACTED]","status":"failed"}'
    assert redact_output(source, apply_truncation=False) == expected


def test_literal_javascript_credential_fields_retain_following_code_and_qualification():
    source = 'const cfg = {"token": process.env.TOKEN, "safe": true};\nKeep this qualification.'
    expected = source.replace("process.env.TOKEN", '"[REDACTED]"')
    assert redact_output(source, apply_truncation=False) == expected


@pytest.mark.parametrize("source", [
    'password="test fixture value with spaces"',
    'BACKEND_TOKEN="fixture value with spaces"',
    '{"password":"fixture value with spaces","status":"failed"}',
    '{"token":"fixture-value","retryable":true}',
])
def test_explicit_credential_assignments_still_redact_after_prose_repair(source) -> None:
    """Explicit assignments and quoted JSON keys retain their established safeguards."""
    redacted = redact_output(source, apply_truncation=False)
    assert "fixture" not in redacted
    assert "[REDACTED]" in redacted
    if source.startswith("{"):
        before = json.loads(source)
        after = json.loads(redacted)
        for key in ("status", "retryable"):
            if key in before:
                assert after[key] == before[key]


@pytest.mark.parametrize("source", [
    "OPENAI_API_KEY=fixture-value\nImportant qualification.",
    "BACKEND_TOKEN=fixture-value\nImportant qualification.",
    '{"api_key":"fixture-value","status":"failed"}',
])
def test_credential_redaction_is_idempotent_without_losing_the_answer(source) -> None:
    redacted = redact_output(source, apply_truncation=False)
    assert redact_output(redacted, apply_truncation=False) == redacted
    assert "fixture-value" not in redacted
    assert "Important qualification." in redacted or '"status":"failed"' in redacted


def test_answer_literal_unicode_preservation_cannot_bypass_redaction() -> None:
    code = '```python\nvalue = "🛡️ 👩‍💻"\n```'
    assert redact_output(code, apply_truncation=False, preserve_literal_unicode=True) == code
    sources = [
        "BACKEND_\u200bTOKEN=fixture-value\nTask failed.",
        "ARCANOS_DAEMON_ACCESS_TO\ufe0fKEN=fixture-value\nTask failed.",
        "\x1b[31mBACKEND_TOKEN=fixture-value\x1b[0m\nTask failed.",
        "sk-\u200b" + "fixture" * 5 + "\nTask failed.",
        '{"pass\u200bword":"fixture-value","status":"failed"}',
    ]
    for source in sources:
        redacted = redact_output(source, apply_truncation=False, preserve_literal_unicode=True)
        assert "fixture-value" not in redacted
        assert "fixturefixture" not in redacted
        assert "[REDACTED]" in redacted
        assert "Task failed." in redacted or '"status":"failed"' in redacted


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

    if separator in ("\u000b", "\u000c", "\u0085", "\u001c"):
        assert padded == replacement
        assert adjacent == replacement
    else:
        visible_separator = "" if separator == "\ufeff" else separator
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
    assert decsc_redacted == replacement
    assert unterminated_osc == replacement


@pytest.mark.parametrize(
    ("name", "terminal_sequence", "unsafe"),
    [
        ("CSI with a default ignorable", "\x1b[3\u200b1m", False),
        ("CSI with NUL", "\x1b[3\x001m", False),
        ("CSI with BEL", "\x1b[3\x071m", False),
        ("CSI with C1 ST", "\x1b[3\x9c1m", True),
        ("CSI with nested C1 CSI", "\x1b[3\x9b1m", True),
        ("C1 CSI with NUL", "\x9b3\x001m", False),
        ("C1 CSI with BEL", "\x9b3\x071m", False),
        ("C1 CSI with C1 ST", "\x9b3\x9c1m", True),
        ("generic ESC with NUL", "\x1b\x007", True),
        ("generic ESC with BEL", "\x1b\x077", True),
        ("generic ESC with C1 ST", "\x1b\x9c7", True),
        ("generic ESC with nested ESC", "\x1b\x1b7", True),
        ("C1 CSI before an ESC CSI", "\x9b\x1b[31m", True),
        ("ESC before a C1 CSI", "\x1b\x9b31m", True),
        ("C1 CSI before a generic ESC", "\x9b\x1b7", True),
        ("ESC before a C1 OSC", "\x1b\x9d0;hidden\x07", True),
        ("CSI introducer split by NUL", "\x1b\x00[31m", True),
        ("CSI introducer split by BEL", "\x1b\x07[31m", True),
        ("CSI introducer split by C1 ST", "\x1b\x9c[31m", True),
        ("DCS with a default ignorable", "\x1bPqhid\u200bden\x1b\\", False),
        ("DCS with NUL", "\x1bPqhid\x00den\x1b\\", False),
        ("OSC with a default ignorable", "\x1b]0;hid\u200bden\x07", False),
        ("OSC with NUL", "\x1b]0;hid\x00den\x07", False),
        ("OSC with earlier equals noise", "\x1b]0;foo=bar\x07", False),
    ],
)
def test_redaction_fail_closed_for_controls_embedded_in_terminal_grammar(
    monkeypatch,
    name: str,
    terminal_sequence: str,
    unsafe: bool,
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

    expected = replacement if unsafe else f"{secret_name}={replacement} tail"
    assert redacted == expected, name
    assert "private-page-id" not in redacted


@pytest.mark.parametrize(
    ("name", "terminal_sequence", "visible_infix", "unsafe"),
    [
        ("CSI ending at a nested ESC", "\x1b[3\x1b1m", "m", True),
        ("C1 CSI consuming the next letter", "\x1b\x9b7", "", True),
        ("DCS ending at an early C1 ST", "\x1bPqhid\x9cden\x1b\\", "den", True),
        ("C1 DCS ending at an early ST", "\x90qhid\x9cden\x9c", "den", True),
        ("OSC ending at an early BEL", "\x1b]0;hid\x07den\x07", "den", False),
        ("OSC ending at an early C1 ST", "\x1b]0;hid\x9cden\x07", "den", False),
        ("C1 OSC ending at an early BEL", "\x9d0;hid\x07den\x9c", "den", True),
    ],
)
def test_redaction_preserves_genuine_visible_terminal_mutations(
    monkeypatch,
    name: str,
    terminal_sequence: str,
    visible_infix: str,
    unsafe: bool,
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

    redacted = redact_output(
        f"{source_name}=PUBLIC_SENTINEL tail",
        apply_truncation=False,
    )
    expected = "[REDACTED]" if unsafe else f"{visible_name}=PUBLIC_SENTINEL tail"
    assert redacted == expected


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


def test_terminal_scanner_preserves_safe_controls_and_line_shape() -> None:
    source = (
        "A\tB\nC\r\nD\u2028E\u2029F"
        "\x00\x07\x7f"
        "\x1b[mG\x1b[38;2:255:0:1mH\x1b[0mI\x9b31mJ"
        "\x1b[3\x7f1mK"
    )

    assert strip_unsafe_output_controls(source) == (
        "A\tB\nC\r\nD\u2028E\u2029FGHIJK"
    )


@pytest.mark.parametrize(
    "control_string",
    [
        "\x1b]0;title\x07",
        "\x1b]8;;https://example.test\x1b\\",
        "\x1bPpayload\x1b\\",
        "\x1bXpayload\x9c",
        "\x1b^payload\x1b\\",
        "\x1b_payload\x9c",
        "\x90payload\x9c",
        "\x98payload\x9c",
        "\x9d0;title\x07",
        "\x9epayload\x9c",
        "\x9fpayload\x9c",
        "\x1bPpayload\x00\x07\x7f\x1b\\",
    ],
)
def test_terminal_scanner_drops_only_complete_control_strings(
    control_string: str,
) -> None:
    assert strip_unsafe_output_controls(f"A{control_string}B") == "AB"


@pytest.mark.parametrize(
    "unsafe_control",
    [
        "\x08",
        "\r",
        "\x0b",
        "\x0c",
        "\x0e",
        "\x0f",
        "\x18",
        "\x1a",
        "\x1f",
        "\x85",
        "\x9c",
        "\x1b7",
        "\x1b[1D",
        "\x9b1D",
        "\x1b[4G",
        "\x1b[1;4H",
        "\x1b[4f",
        "\x1b[s",
        "\x1b[u",
        "\x1b[1P",
        "\x1b[1@",
        "\x1b[1b",
        "\x1b[4h",
        "\x1b[4l",
        "\x1b[31",
        "\x1b[?31m",
        "\x1b[1$m",
        "\x1b]unterminated",
    ],
)
def test_display_mutating_or_ambiguous_controls_fail_closed(
    monkeypatch,
    unsafe_control: str,
) -> None:
    replacement = "[CONTROL_REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [],
            }
        },
    )
    source = f"public-prefix{unsafe_control}private-suffix"

    assert strip_unsafe_output_controls(source) == ""
    assert redact_output(source, apply_truncation=False) == replacement


@pytest.mark.parametrize(
    "boundary",
    ["\t", "\n", "\r", "\r\n", "\u2028", "\u2029"],
)
def test_terminal_sequences_cannot_cross_safe_output_boundaries(
    monkeypatch,
    boundary: str,
) -> None:
    replacement = "[CONTROL_REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [],
            }
        },
    )

    for source in (
        f"A\x1b[31{boundary}mB",
        f"A\x9b31{boundary}mB",
        f"A\x1b]payload{boundary}tail\x07B",
        f"A\x1bPpayload{boundary}tail\x1b\\B",
    ):
        assert strip_unsafe_output_controls(source) == ""
        assert redact_output(source, apply_truncation=False) == replacement


@pytest.mark.parametrize(
    "obfuscated_infix",
    [
        "NOTX\x08ION",
        "NOTX\x1b[1DION",
        "NOTX\x9b1DION",
        "NOT\x1b7X\x1b8ION",
        "NOT\x1b[sX\x1b[uION",
    ],
)
def test_display_overwrite_cannot_bypass_sensitive_assignment_redaction(
    monkeypatch,
    obfuscated_infix: str,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_" + "JSON"
    replacement = "[CONTROL_REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    source_name = secret_name.replace("NOTION", obfuscated_infix)
    source = f'{source_name}={{"page":"private-page-id"}} tail'

    redacted = redact_output(source, apply_truncation=False)

    assert redacted == replacement
    assert "private-page-id" not in redacted


def test_terminal_reconstruction_corpus_fails_closed(monkeypatch) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_ACCESS_" + "TOKEN"
    secret_value = "private-secret-value"
    replacement = "[CONTROL_REDACTED]"
    bad = f"X{secret_name[1:]}={secret_value}"
    repeated_name = secret_name.replace("ACCESS", "AC\x1b[1bES\x1b[1b")
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    cases = [
        ("bare carriage-return overwrite", f"{bad}\rA"),
        ("cursor-horizontal-absolute overwrite", f"{bad}\x1b[1GA"),
        ("horizontal-position-absolute overwrite", f"{bad}\x1b[1`A"),
        ("cursor-position overwrite", f"{bad}\x1b[1;1HA"),
        ("horizontal-vertical-position overwrite", f"{bad}\x1b[1;1fA"),
        ("DEC cursor save and restore", f"\x1b7{bad}\x1b8A"),
        ("CSI cursor save and restore", f"\x1b[s{bad}\x1b[uA"),
        (
            "delete-character overwrite",
            f"AX{secret_name[1:]}={secret_value}\x1b[2G\x1b[1P",
        ),
        (
            "insert-character overwrite",
            f"{secret_name[1:]}={secret_value}\x1b[1G\x1b[1@A",
        ),
        (
            "repeat-preceding-character synthesis",
            f"{repeated_name}={secret_value}",
        ),
        (
            "insert-mode overwrite",
            f"{secret_name[1:]}={secret_value}\x1b[1G\x1b[4hA\x1b[4l",
        ),
        ("cross-row cursor overwrite", f"{bad}\n\x1b[1A\x1b[1GA"),
    ]

    for name, source in cases:
        redacted = redact_output(source, apply_truncation=False)

        assert redacted == replacement, name
        assert secret_value not in redacted, name


def test_preserve_mode_fails_closed_per_nul_or_unit_separator_frame(
    monkeypatch,
) -> None:
    replacement = "[CONTROL_REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [],
            }
        },
    )
    source = "safe\x00bad\x08private\x1ftail\x00\x1b[31mgreen\x1b[0m"

    assert strip_unsafe_output_controls(source) == ""
    assert strip_unsafe_output_controls(
        source,
        preserve_record_separators=True,
    ) == "safe\x00\x1ftail\x00green"
    assert redact_output(source, apply_truncation=False) == replacement
    assert redact_output(
        source,
        apply_truncation=False,
        preserve_record_separators=True,
    ) == f"safe\x00{replacement}\x1ftail\x00green"


def test_fail_closed_replacement_bypasses_later_secret_redaction(
    monkeypatch,
) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_ACCESS_" + "TOKEN"
    replacement = "token=masked-marker"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )

    assert redact_output("public\x08private") == replacement

    source = "safe\x00public\x08private\x1ftail"
    assert redact_output(
        source,
        apply_truncation=False,
        preserve_record_separators=True,
    ) == f"safe\x00{replacement}\x1ftail"


def test_preserve_mode_still_redacts_safe_frames(monkeypatch) -> None:
    secret_name = "ARCANOS_BACKSTAGE_NOTION_ACCESS_" + "TOKEN"
    replacement = "<masked>"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [secret_name],
            }
        },
    )
    source = (
        f"{secret_name}=private-value"
        "\x00public\x08private"
        "\x1fBearer abcdefghijkl"
    )

    assert redact_output(
        source,
        apply_truncation=False,
        preserve_record_separators=True,
    ) == (
        f"{secret_name}={replacement}"
        f"\x00{replacement}"
        f"\x1fBearer {replacement}"
    )


@pytest.mark.parametrize("boundary", ["\x00", "\x1f"])
def test_preserve_mode_does_not_bridge_terminal_sequences_across_frames(
    monkeypatch,
    boundary: str,
) -> None:
    replacement = "[CONTROL_REDACTED]"
    monkeypatch.setattr(
        "arcanos.cli.cli_policy.load_cli_policy",
        lambda: {
            "redactionPolicy": {
                "replacement": replacement,
                "envNames": [],
            }
        },
    )
    cases = [
        (f"A\x1b[31{boundary}mB", "mB", False),
        (f"A\x1b]hidden{boundary}tail\x07B", "tailB", False),
        (f"A\x1bPqhidden{boundary}tail\x1b\\B", "", True),
    ]

    for source, visible_suffix, suffix_is_unsafe in cases:
        public_suffix = "" if suffix_is_unsafe else visible_suffix
        redacted_suffix = replacement if suffix_is_unsafe else visible_suffix
        assert strip_unsafe_output_controls(
            source,
            preserve_record_separators=True,
        ) == f"{boundary}{public_suffix}"
        assert redact_output(
            source,
            apply_truncation=False,
            preserve_record_separators=True,
        ) == f"{replacement}{boundary}{redacted_suffix}"


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
