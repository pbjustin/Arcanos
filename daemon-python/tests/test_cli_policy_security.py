from __future__ import annotations

from arcanos.cli.cli_policy import (
    evaluate_command_policy,
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


def test_redaction_and_truncation_use_shared_policy() -> None:
    secret_name = "OPENAI_API" + "_KEY"
    fake_value = "placeholder-redaction-value"
    redacted = redact_output(f"{secret_name}={fake_value}")

    assert fake_value not in redacted
    assert "[REDACTED]" in redacted


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


def test_patch_policy_rejects_binary_traversal_and_symlink(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))

    traversal = "diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n"
    binary = "diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 0\n"
    symlink = "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n"

    assert validate_patch_text(traversal, str(tmp_path)).reason == "patch_path_outside_sandbox"
    assert validate_patch_text(binary, str(tmp_path)).reason == "patch_denied_by_policy"
    assert validate_patch_text(symlink, str(tmp_path)).reason == "patch_denied_by_policy"
    existing = tmp_path / "existing-link"
    try:
        existing.symlink_to(tmp_path / "target")
    except OSError:
        return
    existing_patch = "diff --git a/existing-link b/existing-link\n--- a/existing-link\n+++ b/existing-link\n"
    assert validate_patch_text(existing_patch, str(tmp_path)).reason == "patch_symlink_not_allowed"


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
