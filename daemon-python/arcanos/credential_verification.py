"""Dependency-light verification for opaque credential values."""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Callable


PURPOSE_BOUND_CREDENTIAL_ENV_NAMES = (
    "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN",
    "ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN",
    "ARCANOS_CORE_ADVISORY_ACCESS_TOKEN",
    "ARCANOS_AI_RUNTIME_ACCESS_TOKEN",
    "ARCANOS_GPT_ACCESS_TOKEN",
    "ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN",
    "ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY",
    "ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY",
    "ARCANOS_GAMING_SOURCE_ACCESS_TOKEN",
    "ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN",
    "ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN",
    "ARCANOS_AUTOMATION_SECRET",
    "ARCANOS_CLI_BRIDGE_TOKEN",
    "ARCANOS_DAEMON_ACCESS_TOKEN",
    "ARCANOS_DEBUG_CMD_TOKEN",
    "ARCANOS_JOB_READ_CAPABILITY_SECRET",
    "ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET",
    "ARCANOS_MEMORY_ACCESS_TOKEN",
    "ARCANOS_WORKER_HELPER_TOKEN",
    "ACTION_PLAN_REQUEST_TOKEN",
    "ACTION_PLAN_OPERATOR_TOKEN",
    "ACTION_PLAN_EXECUTOR_TOKEN",
    "GPT_DAG_BRIDGE_BEARER_TOKEN",
    "METRICS_AUTH_TOKEN",
    "MCP_BEARER_TOKEN",
    "OPENAI_ACTION_SHARED_SECRET",
    "ROOT_OVERRIDE_TOKEN",
    "ARCANOS_ADMIN_TOKEN",
    "DEBUG_WATCHDOG_KEY",
    "DEBUG_SERVER_TOKEN",
)


def timing_safe_equal_opaque_secret(
    provided: object,
    expected: object,
) -> bool:
    """
    Compare two opaque string credentials without parsing or normalization.

    Non-string or empty values are rejected. UTF-32LE digests give
    ``compare_digest`` fixed-length inputs while preserving exact,
    case-sensitive string equality, including lone surrogate code units.
    """
    if not isinstance(provided, str) or not isinstance(expected, str):
        return False
    if not provided or not expected:
        return False

    provided_digest = hashlib.sha256(
        provided.encode("utf-32le", errors="surrogatepass")
    ).digest()
    expected_digest = hashlib.sha256(
        expected.encode("utf-32le", errors="surrogatepass")
    ).digest()
    return hmac.compare_digest(provided_digest, expected_digest)


def has_configured_purpose_bound_credential_collision(
    *,
    credential: str,
    own_environment_name: str,
    read_environment_value: Callable[[str], str | None],
) -> bool:
    """
    Detect whether a boundary credential reuses a configured application peer.

    Boundary-specific parsing remains with each caller. Values are trimmed only
    for the isolation decision so existing loading and requiredness semantics
    remain unchanged.
    """
    if own_environment_name not in PURPOSE_BOUND_CREDENTIAL_ENV_NAMES:
        raise ValueError("Unknown purpose-bound credential environment name")

    normalized_credential = credential.strip()
    if not normalized_credential:
        return False

    for environment_name in PURPOSE_BOUND_CREDENTIAL_ENV_NAMES:
        if environment_name == own_environment_name:
            continue

        candidate = read_environment_value(environment_name)
        if not isinstance(candidate, str):
            continue

        normalized_candidate = candidate.strip()
        if not normalized_candidate:
            continue
        if timing_safe_equal_opaque_secret(
            normalized_credential,
            normalized_candidate,
        ):
            return True

    return False


__all__ = [
    "PURPOSE_BOUND_CREDENTIAL_ENV_NAMES",
    "has_configured_purpose_bound_credential_collision",
    "timing_safe_equal_opaque_secret",
]
