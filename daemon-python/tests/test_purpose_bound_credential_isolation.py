"""Canonical purpose-bound credential isolation for Python-owned boundaries."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import pytest

from arcanos import cli_runner
from arcanos.cli.local_bridge import LocalBridge
from arcanos.config import (
    get_action_plan_executor_token,
    get_automation_auth,
    get_daemon_access_token,
    get_debug_server_token,
    get_local_agent_executor_token,
)
from arcanos.credential_verification import PURPOSE_BOUND_CREDENTIAL_ENV_NAMES


CredentialLoader = Callable[[], str | None]
PYTHON_OWNED_LOADERS: tuple[tuple[str, str, CredentialLoader], ...] = (
    (
        "daemon",
        "ARCANOS_DAEMON_ACCESS_TOKEN",
        get_daemon_access_token,
    ),
    (
        "action_plan_executor",
        "ACTION_PLAN_EXECUTOR_TOKEN",
        get_action_plan_executor_token,
    ),
    (
        "local_agent_executor",
        "ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN",
        get_local_agent_executor_token,
    ),
    (
        "automation",
        "ARCANOS_AUTOMATION_SECRET",
        lambda: get_automation_auth()[1] or None,
    ),
    (
        "cli_bridge",
        "ARCANOS_CLI_BRIDGE_TOKEN",
        lambda: LocalBridge(port=0).bridge_token or None,
    ),
    (
        "debug_command",
        "ARCANOS_DEBUG_CMD_TOKEN",
        lambda: cli_runner._resolve_debug_token(allow_generated=False)[0],
    ),
    (
        "debug_server",
        "DEBUG_SERVER_TOKEN",
        get_debug_server_token,
    ),
)
COLLISION_CASES = tuple(
    (role, own_environment_name, loader, peer_environment_name)
    for role, own_environment_name, loader in PYTHON_OWNED_LOADERS
    for peer_environment_name in PURPOSE_BOUND_CREDENTIAL_ENV_NAMES
    if peer_environment_name != own_environment_name
)


@pytest.fixture(autouse=True)
def isolate_application_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    for environment_name in PURPOSE_BOUND_CREDENTIAL_ENV_NAMES:
        monkeypatch.delenv(environment_name, raising=False)
    monkeypatch.delenv("ARCANOS_CLI_BRIDGE_ENABLED", raising=False)


def test_python_registry_matches_typescript_canonical_registry() -> None:
    repository_root = Path(__file__).resolve().parents[2]
    source = (
        repository_root
        / "src"
        / "shared"
        / "security"
        / "purposeBoundCredential.ts"
    ).read_text(encoding="utf-8")
    match = re.search(
        r"PURPOSE_BOUND_CREDENTIAL_ENV_NAMES\s*=\s*Object\.freeze"
        r"\(\[(.*?)\]\s*as const\)",
        source,
        re.DOTALL,
    )
    assert match is not None
    typescript_environment_names = tuple(
        re.findall(r"""["']([A-Z][A-Z0-9_]+)["']""", match.group(1))
    )

    assert PURPOSE_BOUND_CREDENTIAL_ENV_NAMES == typescript_environment_names


@pytest.mark.parametrize(
    (
        "role",
        "own_environment_name",
        "loader",
        "peer_environment_name",
    ),
    COLLISION_CASES,
    ids=[
        f"{role}-rejects-{peer_environment_name}"
        for (
            role,
            _own_environment_name,
            _loader,
            peer_environment_name,
        ) in COLLISION_CASES
    ],
)
def test_each_python_owned_role_rejects_every_canonical_peer(
    monkeypatch: pytest.MonkeyPatch,
    role: str,
    own_environment_name: str,
    loader: CredentialLoader,
    peer_environment_name: str,
) -> None:
    del role
    credential = "python-purpose-bound-collision-credential-123456"
    monkeypatch.setenv(own_environment_name, credential)
    monkeypatch.setenv(peer_environment_name, credential)

    assert loader() is None


@pytest.mark.parametrize(
    ("role", "own_environment_name", "loader"),
    PYTHON_OWNED_LOADERS,
    ids=[
        role
        for role, _own_environment_name, _loader in PYTHON_OWNED_LOADERS
    ],
)
def test_each_python_owned_role_accepts_a_distinct_valid_credential(
    monkeypatch: pytest.MonkeyPatch,
    role: str,
    own_environment_name: str,
    loader: CredentialLoader,
) -> None:
    del role
    credential = "python-distinct-purpose-bound-credential-123456"
    monkeypatch.setenv(own_environment_name, credential)
    for peer_environment_name in PURPOSE_BOUND_CREDENTIAL_ENV_NAMES:
        if peer_environment_name != own_environment_name:
            monkeypatch.setenv(
                peer_environment_name,
                "python-distinct-peer-purpose-bound-credential-654321",
            )

    assert loader() == credential


def test_enabled_bridge_treats_a_colliding_token_as_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credential = "python-required-bridge-collision-credential-123456"
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_ENABLED", "true")
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_TOKEN", credential)
    monkeypatch.setenv(
        "ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN",
        credential,
    )

    with pytest.raises(ValueError, match="ARCANOS_CLI_BRIDGE_TOKEN"):
        LocalBridge(port=0)


def test_debug_server_loader_preserves_raw_distinct_value_semantics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credential = " python-debug-server-raw-credential-123456 "
    monkeypatch.setenv("DEBUG_SERVER_TOKEN", credential)

    assert get_debug_server_token() == credential


def test_automation_loader_preserves_header_and_trimmed_secret_semantics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ARCANOS_AUTOMATION_HEADER", "X-Custom-Automation")
    monkeypatch.setenv(
        "ARCANOS_AUTOMATION_SECRET",
        " python-distinct-automation-credential-123456 ",
    )

    assert get_automation_auth() == (
        "x-custom-automation",
        "python-distinct-automation-credential-123456",
    )


def test_automation_loader_preserves_default_optional_semantics() -> None:
    assert get_automation_auth() == ("x-arcanos-automation", "")


@pytest.mark.parametrize(
    ("environment_name", "loader"),
    (
        ("ACTION_PLAN_EXECUTOR_TOKEN", get_action_plan_executor_token),
        (
            "ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN",
            get_local_agent_executor_token,
        ),
    ),
)
def test_executor_loaders_preserve_raw_optional_semantics(
    monkeypatch: pytest.MonkeyPatch,
    environment_name: str,
    loader: CredentialLoader,
) -> None:
    assert loader() is None

    credential = " python-raw-executor-credential-123456 "
    monkeypatch.setenv(environment_name, credential)

    assert loader() == credential
