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
            "tool.describe",
            "Describe a registered tool contract and its shared schemas.",
            command_schemas,
            False,
            ["tools:read"],
            ["protocol-validation"],
            "workspace",
        ),
        _tool_definition(
            "tool.invoke",
            "Invoke a daemon tool inside an explicit remote workspace binding.",
            command_schemas,
            False,
            ["tools:invoke"],
            ["protocol-validation", "workspace-binding", "repository-read"],
            "remote",
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
        _tool_definition_from_schema_ids(
            "repo.list",
            "List files and directories from the bound remote workspace root.",
            contract.tools["repo.list"].input["$id"],
            contract.tools["repo.list"].output["$id"],
            False,
            ["repo:read"],
            ["protocol-validation", "workspace-binding", "repository-read"],
            "remote",
        ),
        _tool_definition_from_schema_ids(
            "repo.read_file",
            "Read UTF-8 file content from the bound remote workspace root.",
            contract.tools["repo.read_file"].input["$id"],
            contract.tools["repo.read_file"].output["$id"],
            False,
            ["repo:read"],
            ["protocol-validation", "workspace-binding", "repository-read"],
            "remote",
        ),
    ]


def resolve_tool_schemas(contract: ProtocolContract, tool_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve shared input and output schemas for a protocol-visible tool id."""

    if tool_id in contract.commands:
        schema_pair = contract.commands[tool_id]
        return schema_pair.request, schema_pair.response
    if tool_id in contract.tools:
        schema_pair = contract.tools[tool_id]
        return schema_pair.input, schema_pair.output
    raise KeyError(f'Tool "{tool_id}" is not registered.')


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
    return _tool_definition_from_schema_ids(
        command_id,
        description,
        schema_pair.request["$id"],
        schema_pair.response["$id"],
        approval_required,
        scopes,
        required_capabilities,
        preferred_environment_type,
    )


def _tool_definition_from_schema_ids(
    tool_id: str,
    description: str,
    input_schema_id: str,
    output_schema_id: str,
    approval_required: bool,
    scopes: list[str],
    required_capabilities: list[str],
    preferred_environment_type: str,
) -> dict[str, Any]:
    return {
        "id": tool_id,
        "description": description,
        "inputSchemaId": input_schema_id,
        "outputSchemaId": output_schema_id,
        "approvalRequired": approval_required,
        "allowedClients": ["cli", "ide", "automation"],
        "scopes": scopes,
        "requiredCapabilities": required_capabilities,
        "preferredEnvironmentType": preferred_environment_type,
    }
