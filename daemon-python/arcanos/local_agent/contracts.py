"""Validation against the TypeScript-generated local-agent capability catalog."""

from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
from typing import Any, Mapping

from jsonschema import (  # type: ignore[import-untyped]
    Draft202012Validator,
    ValidationError,
    validators,
)

from ..protocol_runtime.schema_loader import resolve_repository_root

CATALOG_SCHEMA_VERSION = "local-agent-capability-catalog-v1"
CATALOG_MODULE = "ARCANOS:LOCAL_AGENT"


def _validate_max_utf8_bytes(
    _validator: Any,
    limit: Any,
    instance: Any,
    _schema: Any,
) -> Any:
    if (
        isinstance(limit, int)
        and isinstance(instance, str)
        and len(instance.encode("utf-8")) > limit
    ):
        yield ValidationError("string exceeds maxUtf8Bytes")


LocalAgentSchemaValidator = validators.extend(
    Draft202012Validator,
    {"maxUtf8Bytes": _validate_max_utf8_bytes},
)


@lru_cache(maxsize=1)
def load_local_agent_capability_catalog() -> dict[str, dict[str, Any]]:
    """Load and structurally verify the generated TypeScript contract catalog."""

    packaged_catalog_path = Path(__file__).with_name(
        "capability-catalog.generated.json"
    )
    try:
        repository_catalog_path = (
            resolve_repository_root()
            / "packages"
            / "protocol"
            / "schemas"
            / "v1"
            / "local-agent"
            / "capability-catalog.generated.json"
        )
    except FileNotFoundError:
        repository_catalog_path = None
    if repository_catalog_path is not None and not repository_catalog_path.is_file():
        repository_catalog_path = None

    try:
        packaged_catalog = json.loads(packaged_catalog_path.read_text(encoding="utf-8"))
        if repository_catalog_path is None:
            raw_catalog = packaged_catalog
        else:
            repository_catalog = json.loads(
                repository_catalog_path.read_text(encoding="utf-8")
            )
            if repository_catalog != packaged_catalog:
                raise RuntimeError(
                    "Packaged and repository local-agent catalogs have drifted."
                )
            raw_catalog = repository_catalog
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "The generated local-agent capability catalog is unavailable."
        ) from error

    if (
        not isinstance(raw_catalog, Mapping)
        or raw_catalog.get("schemaVersion") != CATALOG_SCHEMA_VERSION
        or raw_catalog.get("module") != CATALOG_MODULE
        or not isinstance(raw_catalog.get("actions"), list)
    ):
        raise RuntimeError("The generated local-agent capability catalog is invalid.")

    actions: dict[str, dict[str, Any]] = {}
    for action in raw_catalog["actions"]:
        if (
            not isinstance(action, Mapping)
            or not isinstance(action.get("id"), str)
            or action.get("executionTarget") != "python-daemon"
            or not isinstance(action.get("inputSchema"), Mapping)
            or not isinstance(action.get("outputSchema"), Mapping)
        ):
            raise RuntimeError(
                "The generated local-agent capability catalog is invalid."
            )
        action_id = str(action["id"])
        if action_id in actions:
            raise RuntimeError(
                "The generated local-agent capability catalog has duplicate actions."
            )
        actions[action_id] = dict(action)
    return actions


def validate_local_agent_input(action: str, payload: Mapping[str, Any]) -> None:
    """Validate handler input without echoing potentially sensitive values."""

    _validate(action, payload, schema_name="inputSchema", direction="input")


def validate_local_agent_output(action: str, output: Mapping[str, Any]) -> None:
    """Validate handler output without echoing potentially sensitive values."""

    _validate(action, output, schema_name="outputSchema", direction="output")


def _validate(
    action: str,
    value: Mapping[str, Any],
    *,
    schema_name: str,
    direction: str,
) -> None:
    catalog = load_local_agent_capability_catalog()
    capability = catalog.get(action)
    if capability is None:
        raise PermissionError(f'Local-agent action "{action}" is not registered.')
    schema = capability[schema_name]
    validator = LocalAgentSchemaValidator(schema)
    first_error = next(iter(validator.iter_errors(dict(value))), None)
    if first_error is None:
        return
    path = "$" + "".join(
        f"[{part}]" if isinstance(part, int) else f".{part}"
        for part in first_error.absolute_path
    )
    raise ValueError(
        f'Local-agent {direction} for "{action}" failed generated schema '
        f"validation at {path} ({first_error.validator})."
    )


__all__ = [
    "load_local_agent_capability_catalog",
    "validate_local_agent_input",
    "validate_local_agent_output",
]
