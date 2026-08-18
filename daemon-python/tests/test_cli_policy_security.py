from __future__ import annotations

import pytest

from arcanos.cli.cli_policy import (
    evaluate_command_policy,
    parse_patch_paths,
    redact_output,
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

    visible_separator = "" if separator in ("\u000b", "\u000c", "\u0085", "\u001c") else separator
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
