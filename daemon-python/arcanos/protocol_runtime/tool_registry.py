"""Declarative tool registry for the scaffolded Python runtime."""

from __future__ import annotations

from typing import Any

from .schema_loader import ProtocolContract


def build_tool_registry(contract: ProtocolContract) -> list[dict[str, Any]]:
    """Build the typed, inspectable tool registry from shared command schemas."""

    command_schemas = contract.commands
    return [
        _tool_definition(
            "context.inspect",
            "Inspect the current protocol context and environment binding.",
            command_schemas,
            False,
            ["context:read"],
            ["protocol-validation"],
            "workspace",
        ),
        _tool_definition(
            "tool.registry",
            "List declarative tool contracts exposed by the daemon runtime.",
            command_schemas,
            False,
            ["tools:read"],
            ["protocol-validation"],
            "workspace",
        ),
        _tool_definition(
            "daemon.capabilities",
            "Report runtime capabilities, supported commands, and environment types.",
            command_schemas,
            False,
            ["runtime:read"],
            ["protocol-validation"],
            "host",
        ),
        _tool_definition(
            "exec.start",
            "Create a queued execution state for an explicit task and environment.",
            command_schemas,
            True,
            ["exec:start"],
            ["protocol-validation", "in-memory-execution"],
            "workspace",
        ),
        _tool_definition(
            "exec.status",
            "Read the current execution state for a queued or running execution.",
            command_schemas,
            False,
            ["exec:read"],
            ["protocol-validation", "in-memory-execution"],
            "workspace",
        ),
        _tool_definition(
            "state.snapshot",
            "Capture an auditable snapshot of an execution state.",
            command_schemas,
            False,
            ["state:write"],
            ["protocol-validation", "in-memory-execution"],
            "workspace",
        ),
        _tool_definition(
            "artifact.store",
            "Store an artifact descriptor for resumable executions.",
            command_schemas,
            False,
            ["artifact:write"],
            ["protocol-validation", "in-memory-execution"],
            "workspace",
        ),
    ]


def _tool_definition(
    command_id: str,
    description: str,
    command_schemas: dict[str, Any],
    approval_required: bool,
    scopes: list[str],
    required_capabilities: list[str],
    preferred_environment_type: str,
) -> dict[str, Any]:
    schema_pair = command_schemas[command_id]
    return {
        "id": command_id,
        "description": description,
        "inputSchemaId": schema_pair.request["$id"],
        "outputSchemaId": schema_pair.response["$id"],
        "approvalRequired": approval_required,
        "allowedClients": ["cli", "ide", "automation"],
        "scopes": scopes,
        "requiredCapabilities": required_capabilities,
        "preferredEnvironmentType": preferred_environment_type,
    }
