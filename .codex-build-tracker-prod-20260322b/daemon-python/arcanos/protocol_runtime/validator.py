"""Schema-driven validation for scaffolded protocol requests and tool inputs."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from .schema_loader import ProtocolContract, load_protocol_contract


@dataclass(frozen=True)
class ContractValidators:
    """Cache compiled validators for one loaded protocol contract."""

    envelope_request: Draft202012Validator
    command_requests: dict[str, Draft202012Validator]
    tool_inputs: dict[str, Draft202012Validator]


def validate_protocol_request(contract: ProtocolContract, request: Any) -> list[str]:
    """Validate a protocol request against the shared schema bundle."""

    if not isinstance(request, dict):
        return ["Request must be a JSON object."]

    validators = _get_contract_validators(str(contract.schema_root))
    issues = _normalize_errors(validators.envelope_request.iter_errors(request))
    command_name = request.get("command")

    if not isinstance(command_name, str) or not command_name.strip():
        return issues
    if command_name not in contract.commands:
        issues.append(f'Command "{command_name}" is not supported by the Python runtime.')
        return issues

    payload = request.get("payload", {})
    issues.extend(_normalize_errors(validators.command_requests[command_name].iter_errors(payload)))
    return issues


def validate_tool_input(contract: ProtocolContract, tool_id: str, tool_input: Any) -> list[str]:
    """Validate a tool invocation input against the shared tool schema bundle."""

    validators = _get_contract_validators(str(contract.schema_root))
    if tool_id not in validators.tool_inputs:
        return [f'Tool "{tool_id}" does not expose an invokable input schema.']
    return _normalize_errors(validators.tool_inputs[tool_id].iter_errors(tool_input or {}))


@lru_cache(maxsize=4)
def _get_contract_validators(schema_root: str) -> ContractValidators:
    contract = load_protocol_contract()
    if str(contract.schema_root) != schema_root:
        raise ValueError(f'Schema root mismatch while loading validators for "{schema_root}".')

    registry = Registry()
    for schema_document in _collect_schema_documents(contract):
        registry = registry.with_resource(
            schema_document["$id"],
            Resource.from_contents(schema_document),
        )

    envelope_request_schema = {
        "$id": "https://schemas.arcanos.dev/protocol/v1/runtime/envelope-request.schema.json",
        "allOf": [
            {
                "$ref": f'{contract.envelope["$id"]}#/$defs/request',
            }
        ],
    }

    return ContractValidators(
        envelope_request=Draft202012Validator(envelope_request_schema, registry=registry),
        command_requests={
            command_name: Draft202012Validator(schema_pair.request, registry=registry)
            for command_name, schema_pair in contract.commands.items()
        },
        tool_inputs={
            tool_name: Draft202012Validator(schema_pair.input, registry=registry)
            for tool_name, schema_pair in contract.tools.items()
        },
    )


def _collect_schema_documents(contract: ProtocolContract) -> list[dict[str, Any]]:
    return [
        contract.envelope,
        *contract.nouns.values(),
        *[
            schema_document
            for schema_pair in contract.commands.values()
            for schema_document in (schema_pair.request, schema_pair.response)
        ],
        *[
            schema_document
            for schema_pair in contract.tools.values()
            for schema_document in (schema_pair.input, schema_pair.output)
        ],
    ]


def _normalize_errors(errors: Any) -> list[str]:
    normalized_issues: list[str] = []

    for error in sorted(errors, key=lambda candidate: list(candidate.absolute_path)):
        instance_path = "/" + "/".join(str(segment) for segment in error.absolute_path)
        normalized_issues.append(f'{instance_path or "/"}: {error.message}')

    return normalized_issues
