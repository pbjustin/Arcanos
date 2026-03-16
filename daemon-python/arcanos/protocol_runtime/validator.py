"""Conservative request validation for the scaffolded protocol runtime."""

from __future__ import annotations

from typing import Any

from .schema_loader import ProtocolContract


def validate_protocol_request(contract: ProtocolContract, request: Any) -> list[str]:
    """Validate a protocol request against the shared schema bundle at scaffold depth."""

    issues: list[str] = []

    if not isinstance(request, dict):
        return ["Request must be a JSON object."]

    if request.get("protocol") != contract.protocol:
        issues.append(f'Expected protocol "{contract.protocol}".')

    if not _is_non_empty_string(request.get("requestId")):
        issues.append("requestId must be a non-empty string.")

    if not _is_non_empty_string(request.get("command")):
        issues.append("command must be a non-empty string.")
        return issues

    command_name = str(request["command"])
    if command_name not in contract.commands:
        issues.append(f'Command "{command_name}" is not supported by the Python runtime.')
        return issues

    auth_payload = request.get("auth")
    if auth_payload is not None:
        if not isinstance(auth_payload, dict):
            issues.append("auth must be an object when provided.")
        else:
            if not _is_non_empty_string(auth_payload.get("strategy")):
                issues.append("auth.strategy must be a non-empty string.")
            if not _is_non_empty_string(auth_payload.get("token")):
                issues.append("auth.token must be a non-empty string.")

    context_payload = request.get("context")
    if context_payload is not None:
        if not isinstance(context_payload, dict):
            issues.append("context must be an object when provided.")
        else:
            issues.extend(_validate_context(contract, context_payload, "context"))

    payload = request.get("payload", {})
    issues.extend(_validate_command_payload(contract, command_name, payload))
    return issues


def _validate_command_payload(contract: ProtocolContract, command_name: str, payload: Any) -> list[str]:
    if payload is None:
        payload = {}

    if not isinstance(payload, dict):
        return ["payload must be an object."]

    environment_types = _environment_types(contract)
    issues: list[str] = []

    if command_name == "context.inspect":
        issues.extend(_validate_optional_boolean(payload, "includeProject"))
        issues.extend(_validate_optional_boolean(payload, "includeAvailableEnvironments"))
        return issues

    if command_name == "tool.registry":
        preferred_environment = payload.get("preferredEnvironmentType")
        if preferred_environment is not None and preferred_environment not in environment_types:
            issues.append("payload.preferredEnvironmentType must be a supported environment type.")
        issues.extend(_validate_optional_string_list(payload, "scopes"))
        return issues

    if command_name == "daemon.capabilities":
        return issues

    if command_name == "exec.start":
        task_payload = payload.get("task")
        if not isinstance(task_payload, dict):
            issues.append("payload.task must be an object.")
            return issues
        if not _is_non_empty_string(task_payload.get("id")):
            issues.append("payload.task.id must be a non-empty string.")
        if not _is_non_empty_string(task_payload.get("command")):
            issues.append("payload.task.command must be a non-empty string.")
        task_context = task_payload.get("context")
        if task_context is not None:
            if not isinstance(task_context, dict):
                issues.append("payload.task.context must be an object when provided.")
            else:
                issues.extend(_validate_context(contract, task_context, "payload.task.context"))
        approval_payload = payload.get("approval")
        if approval_payload is not None:
            issues.extend(_validate_approval(approval_payload))
        return issues

    if command_name in {"exec.status", "state.snapshot"}:
        if not _is_non_empty_string(payload.get("executionId")):
            issues.append("payload.executionId must be a non-empty string.")
        return issues

    if command_name == "artifact.store":
        artifact_payload = payload.get("artifact")
        if not isinstance(artifact_payload, dict):
            issues.append("payload.artifact must be an object.")
            return issues
        issues.extend(_validate_artifact(artifact_payload))
        return issues

    return [f'No validator is registered for "{command_name}".']


def _validate_context(contract: ProtocolContract, context_payload: dict[str, Any], scope: str) -> list[str]:
    issues: list[str] = []
    environment_types = _environment_types(contract)

    for key in ("sessionId", "projectId", "cwd", "shell"):
        if key in context_payload and context_payload[key] is not None and not isinstance(context_payload[key], str):
            issues.append(f"{scope}.{key} must be a string when provided.")

    if "environment" in context_payload and context_payload["environment"] is not None:
        if context_payload["environment"] not in environment_types:
            issues.append(f"{scope}.environment must be one of {sorted(environment_types)}.")

    return issues


def _validate_approval(approval_payload: Any) -> list[str]:
    if not isinstance(approval_payload, dict):
        return ["payload.approval must be an object when provided."]

    issues: list[str] = []
    if not _is_non_empty_string(approval_payload.get("id")):
        issues.append("payload.approval.id must be a non-empty string.")
    if approval_payload.get("status") not in {"pending", "approved", "rejected"}:
        issues.append('payload.approval.status must be "pending", "approved", or "rejected".')
    issues.extend(_validate_optional_string_list(approval_payload, "scopes", "payload.approval"))
    return issues


def _validate_artifact(artifact_payload: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    for key in ("id", "kind", "createdAt"):
        if not _is_non_empty_string(artifact_payload.get(key)):
            issues.append(f"payload.artifact.{key} must be a non-empty string.")

    if "bytes" in artifact_payload and artifact_payload["bytes"] is not None:
        if not isinstance(artifact_payload["bytes"], int) or artifact_payload["bytes"] < 0:
            issues.append("payload.artifact.bytes must be a non-negative integer when provided.")

    for optional_string_key in ("path", "contentType", "checksum"):
        if optional_string_key in artifact_payload and artifact_payload[optional_string_key] is not None:
            if not isinstance(artifact_payload[optional_string_key], str):
                issues.append(f"payload.artifact.{optional_string_key} must be a string when provided.")

    return issues


def _validate_optional_boolean(payload: dict[str, Any], key: str) -> list[str]:
    if key not in payload or payload[key] is None:
        return []
    return [] if isinstance(payload[key], bool) else [f"payload.{key} must be a boolean when provided."]


def _validate_optional_string_list(payload: dict[str, Any], key: str, scope: str = "payload") -> list[str]:
    if key not in payload or payload[key] is None:
        return []
    value = payload[key]
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        return [f"{scope}.{key} must be an array of strings when provided."]
    return []


def _environment_types(contract: ProtocolContract) -> set[str]:
    return set(contract.nouns["environment"]["properties"]["type"]["enum"])


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and len(value.strip()) > 0
