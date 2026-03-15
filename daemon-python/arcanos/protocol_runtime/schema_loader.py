"""Load shared Arcanos Protocol schemas from the TypeScript protocol package."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class CommandSchemaPair:
    """Describe the shared request and response schemas for a single command."""

    request: dict[str, Any]
    response: dict[str, Any]


@dataclass(frozen=True)
class ProtocolContract:
    """Represent the shared contract bundle loaded from the TypeScript package."""

    protocol: str
    schema_root: Path
    envelope: dict[str, Any]
    nouns: dict[str, dict[str, Any]]
    commands: dict[str, CommandSchemaPair]


def resolve_repository_root() -> Path:
    """Resolve the repository root from the Python runtime package location."""

    return Path(__file__).resolve().parents[3]


def load_protocol_contract() -> ProtocolContract:
    """Load the versioned Arcanos Protocol v1 contract from the shared schema package."""

    schema_root = resolve_repository_root() / "packages" / "protocol" / "schemas" / "v1"
    envelope = _load_json_file(schema_root / "envelope.schema.json")
    noun_directory = schema_root / "nouns"
    command_directory = schema_root / "commands"
    noun_schemas = {
        schema_path.stem.replace(".schema", ""): _load_json_file(schema_path)
        for schema_path in sorted(noun_directory.glob("*.schema.json"))
    }
    command_schemas = _load_command_schemas(command_directory)

    return ProtocolContract(
        protocol=envelope["$defs"]["protocol"]["const"],
        schema_root=schema_root,
        envelope=envelope,
        nouns=noun_schemas,
        commands=command_schemas,
    )


def _load_command_schemas(command_directory: Path) -> dict[str, CommandSchemaPair]:
    command_pairs: dict[str, dict[str, dict[str, Any]]] = {}

    for schema_path in sorted(command_directory.glob("*.schema.json")):
        schema_name = schema_path.name.removesuffix(".schema.json")
        command_name, direction = schema_name.rsplit(".", 1)
        command_pairs.setdefault(command_name, {})[direction] = _load_json_file(schema_path)

    return {
        command_name: CommandSchemaPair(
            request=payload["request"],
            response=payload["response"],
        )
        for command_name, payload in command_pairs.items()
        if "request" in payload and "response" in payload
    }


def _load_json_file(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file_pointer:
        return json.load(file_pointer)
