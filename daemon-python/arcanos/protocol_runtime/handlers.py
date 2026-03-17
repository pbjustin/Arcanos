"""Command handlers for the scaffolded Arcanos Protocol runtime."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import time
from typing import Any, Callable

from .audit import RepoToolAuditLogger
from .schema_loader import ProtocolContract
from .state_store import InMemoryProtocolStateStore
from .tool_registry import build_tool_registry, resolve_tool_schemas
from .tools.repository_tools import (
    build_remote_source_descriptor,
    get_repository_diff,
    get_repository_log,
    get_repository_status,
    list_repository_tree,
    search_repository,
    read_repository_file,
    resolve_workspace_root,
)
from .validator import validate_protocol_request, validate_tool_input


class ProtocolRuntimeHandler:
    """Handle protocol requests using shared schemas and an explicit in-memory store."""

    def __init__(
        self,
        contract: ProtocolContract,
        state_store: InMemoryProtocolStateStore,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        """Initialize the handler with a shared contract and in-memory persistence."""

        self._contract = contract
        self._state_store = state_store
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._workspace_root = resolve_workspace_root()
        self._remote_source = build_remote_source_descriptor(self._workspace_root)
        self._audit_logger = RepoToolAuditLogger(self._workspace_root)
        self._tool_registry = build_tool_registry(contract)
        self._tool_registry_by_id = {
            tool_definition["id"]: deepcopy(tool_definition)
            for tool_definition in self._tool_registry
        }

    def handle_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Validate and execute a single protocol request."""

        started_at = time.perf_counter()
        issues = validate_protocol_request(self._contract, request)
        request_id = str(request.get("requestId", "unknown-request"))

        # //audit assumption: shared-schema validation must happen before dispatch. failure risk: malformed requests could mutate runtime state. invariant: only validated requests reach command handlers. handling: return a structured protocol error without side effects.
        if issues:
            return self._error_response(
                request_id=request_id,
                code="invalid_request",
                message="; ".join(issues),
                retryable=False,
                timing_ms=self._timing_ms(started_at),
            )

        command_name = str(request["command"])
        payload = request.get("payload") or {}
        context = request.get("context") or {}

        try:
            response_data = self._dispatch_command(command_name, request_id, payload, context)
            return self._success_response(request_id, response_data, self._timing_ms(started_at))
        except ValueError as error:
            return self._error_response(
                request_id=request_id,
                code="invalid_request",
                message=str(error),
                retryable=False,
                timing_ms=self._timing_ms(started_at),
            )
        except PermissionError as error:
            return self._error_response(
                request_id=request_id,
                code="permission_denied",
                message=str(error),
                retryable=False,
                timing_ms=self._timing_ms(started_at),
            )
        except FileNotFoundError as error:
            return self._error_response(
                request_id=request_id,
                code="not_found",
                message=str(error),
                retryable=False,
                timing_ms=self._timing_ms(started_at),
            )
        except (IsADirectoryError, NotADirectoryError) as error:
            return self._error_response(
                request_id=request_id,
                code="invalid_request",
                message=str(error),
                retryable=False,
                timing_ms=self._timing_ms(started_at),
            )
        except KeyError as error:
            return self._error_response(
                request_id=request_id,
                code="not_found",
                message=str(error),
                retryable=False,
                timing_ms=self._timing_ms(started_at),
            )
        except Exception as error:  # pragma: no cover - defensive scaffold fallback
            return self._error_response(
                request_id=request_id,
                code="runtime_error",
                message=f"Unhandled runtime error: {error}",
                retryable=False,
                timing_ms=self._timing_ms(started_at),
            )

    def _dispatch_command(
        self,
        command_name: str,
        request_id: str,
        payload: dict[str, Any],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        # //audit assumption: dispatch remains explicit to keep planning, execution, and mutation separate. failure risk: implicit routing would hide unsupported behavior. invariant: every handled command is listed in one branch. handling: raise structured unsupported-command errors for unknown routes.
        if command_name == "context.inspect":
            return self._handle_context_inspect(payload, context)
        if command_name == "tool.registry":
            return self._handle_tool_registry(payload)
        if command_name == "tool.describe":
            return self._handle_tool_describe(payload)
        if command_name == "tool.invoke":
            return self._handle_tool_invoke(request_id, payload, context)
        if command_name == "daemon.capabilities":
            return self._handle_daemon_capabilities()
        if command_name == "exec.start":
            return self._handle_exec_start(request_id, payload, context)
        if command_name == "exec.status":
            return self._handle_exec_status(payload)
        if command_name == "state.snapshot":
            return self._handle_state_snapshot(payload)
        if command_name == "artifact.store":
            return self._handle_artifact_store(payload)
        raise KeyError(f'Command "{command_name}" is not implemented in the Python runtime.')

    def _handle_context_inspect(self, payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        environment_type = self._resolve_environment_type(context.get("environment"))
        current_environment = self._build_environment_descriptor(
            environment_type=environment_type,
            cwd=context.get("cwd") or str(self._workspace_root),
            shell=context.get("shell"),
            include_execution=environment_type != "remote",
        )
        response_data: dict[str, Any] = {
            "context": {
                "sessionId": context.get("sessionId"),
                "projectId": context.get("projectId"),
                "environment": environment_type,
                "cwd": context.get("cwd") or str(self._workspace_root),
                "shell": context.get("shell"),
            },
            "environment": current_environment,
        }

        # //audit assumption: project details are optional scaffolding metadata. failure risk: clients may treat placeholders as authoritative repository config. invariant: placeholder project data only appears when requested. handling: gate project output behind the payload flag.
        if bool(payload.get("includeProject")):
            response_data["project"] = {
                "id": context.get("projectId", "workspace-project"),
                "name": "Arcanos Workspace",
                "rootPath": str(self._workspace_root),
                "remoteSource": self._remote_source,
            }

        # //audit assumption: environment enumeration is static at scaffold time. failure risk: callers could infer unimplemented orchestration behavior. invariant: returned environments are explicit and finite. handling: expose the fixed set only when requested.
        if bool(payload.get("includeAvailableEnvironments")):
            response_data["availableEnvironments"] = self._build_available_environments(
                cwd=context.get("cwd") or str(self._workspace_root),
                shell=context.get("shell"),
            )

        return response_data

    def _handle_tool_registry(self, payload: dict[str, Any]) -> dict[str, Any]:
        preferred_environment = payload.get("preferredEnvironmentType")
        scopes = payload.get("scopes") or []
        filtered_tools: list[dict[str, Any]] = []

        for tool_definition in self._tool_registry:
            # //audit assumption: environment filters are restrictive hints. failure risk: callers may see tools that cannot execute in their chosen environment. invariant: filtered output only includes matching preferred environments. handling: skip non-matching tools.
            if preferred_environment and tool_definition["preferredEnvironmentType"] != preferred_environment:
                continue
            # //audit assumption: requested scopes must all be present on the tool. failure risk: partial matches would overstate permissions. invariant: scope filtering is conjunctive. handling: skip tools missing any requested scope.
            if scopes and not all(scope in tool_definition["scopes"] for scope in scopes):
                continue
            filtered_tools.append(deepcopy(tool_definition))

        return {"tools": filtered_tools}

    def _handle_tool_describe(self, payload: dict[str, Any]) -> dict[str, Any]:
        tool_id = str(payload["toolId"])
        if tool_id not in self._tool_registry_by_id:
            raise KeyError(f'Tool "{tool_id}" was not found.')

        input_schema, output_schema = resolve_tool_schemas(self._contract, tool_id)
        return {
            "tool": deepcopy(self._tool_registry_by_id[tool_id]),
            "inputSchema": deepcopy(input_schema),
            "outputSchema": deepcopy(output_schema),
        }

    def _handle_tool_invoke(
        self,
        request_id: str,
        payload: dict[str, Any],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        tool_id = str(payload["toolId"])
        tool_input = payload.get("input") or {}
        if tool_id not in self._tool_registry_by_id:
            raise KeyError(f'Tool "{tool_id}" was not found.')

        input_issues = validate_tool_input(self._contract, tool_id, tool_input)
        if input_issues:
            raise ValueError("; ".join(input_issues))

        caller = self._require_caller_metadata(context)
        self._authorize_tool_call(tool_id, caller, context)

        try:
            result = self._invoke_repo_tool(tool_id, tool_input)
        except Exception as error:
            self._audit_logger.record(
                request_id=request_id,
                tool_id=tool_id,
                caller=caller,
                tool_input=tool_input,
                ok=False,
                error=str(error),
            )
            raise

        self._audit_logger.record(
            request_id=request_id,
            tool_id=tool_id,
            caller=caller,
            tool_input=tool_input,
            ok=True,
        )

        return {
            "toolId": tool_id,
            "invocationId": f"invoke-{request_id}",
            "result": result,
        }

    def _handle_daemon_capabilities(self) -> dict[str, Any]:
        return {
            "protocolVersion": self._contract.protocol,
            "runtimeVersion": "0.1.0",
            "supportedCommands": sorted(self._contract.commands.keys()),
            "supportedEnvironmentTypes": sorted(self._contract.nouns["environment"]["properties"]["type"]["enum"]),
            "schemaRoot": str(self._contract.schema_root),
            "toolCount": len(self._tool_registry),
        }

    def _handle_exec_start(self, request_id: str, payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        task_payload = payload["task"]
        started_at = self._clock().isoformat()
        environment_context = task_payload.get("context") or {}
        environment_type = self._resolve_environment_type(
            context.get("environment") or environment_context.get("environment")
        )
        execution_state = {
            "executionId": f"exec-{request_id}",
            "command": task_payload["command"],
            "status": "queued",
            "environment": self._build_environment_descriptor(
                environment_type=environment_type,
                cwd=context.get("cwd") or environment_context.get("cwd") or str(self._workspace_root),
                shell=context.get("shell") or environment_context.get("shell"),
                include_execution=environment_type != "remote",
            ),
            "artifacts": [],
            "runResult": {
                "status": "queued",
                "exitCode": None,
                "stdout": "",
                "stderr": "",
                "startedAt": started_at,
            },
            "createdAt": started_at,
            "updatedAt": started_at,
        }
        stored_state = self._state_store.store_execution(execution_state)
        return {"state": stored_state}

    def _handle_exec_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        execution_id = str(payload["executionId"])
        execution_state = self._state_store.get_execution(execution_id)
        if execution_state is None:
            raise KeyError(f'Execution "{execution_id}" was not found.')
        return {"state": execution_state}

    def _handle_state_snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        execution_id = str(payload["executionId"])
        execution_state = self._state_store.get_execution(execution_id)
        if execution_state is None:
            raise KeyError(f'Execution "{execution_id}" was not found.')
        snapshot_id = f"snapshot-{execution_id}"
        return self._state_store.store_snapshot(snapshot_id, execution_state)

    def _handle_artifact_store(self, payload: dict[str, Any]) -> dict[str, Any]:
        stored_artifact = self._state_store.store_artifact(payload["artifact"])
        return {"artifact": stored_artifact, "stored": True}

    def _build_available_environments(self, cwd: str | None, shell: str | None) -> list[dict[str, Any]]:
        return [
            self._build_environment_descriptor("workspace", cwd, shell, include_execution=True),
            self._build_environment_descriptor("sandbox", cwd, shell, include_execution=False),
            self._build_environment_descriptor("host", cwd, shell, include_execution=False),
            self._build_environment_descriptor("remote", cwd or str(self._workspace_root), shell, include_execution=False),
        ]

    def _build_environment_descriptor(
        self,
        environment_type: str,
        cwd: str | None,
        shell: str | None,
        include_execution: bool,
    ) -> dict[str, Any]:
        capabilities = ["protocol-validation"]
        if include_execution:
            capabilities.append("in-memory-execution")
        if environment_type == "workspace":
            capabilities.extend(["fs-read", "repo-read"])
            if (self._workspace_root / ".git").exists() or (self._workspace_root / ".git").is_file():
                capabilities.append("git-read")
        if environment_type == "remote":
            capabilities.extend(["workspace-binding", "repository-read"])

        descriptor: dict[str, Any] = {
            "type": environment_type,
            "label": f"{environment_type} environment",
            "cwd": cwd,
            "shell": shell,
            "capabilities": capabilities,
        }

        if environment_type == "remote" and self._remote_source is not None:
            descriptor["remoteSource"] = self._remote_source

        return descriptor

    def _success_response(self, request_id: str, data: dict[str, Any], timing_ms: int) -> dict[str, Any]:
        return {
            "protocol": self._contract.protocol,
            "requestId": request_id,
            "ok": True,
            "data": self._prune_none_values(data),
            "meta": {
                "version": "0.1.0",
                "executedBy": "python-daemon",
                "timingMs": timing_ms,
            },
        }

    def _error_response(
        self,
        request_id: str,
        code: str,
        message: str,
        retryable: bool,
        timing_ms: int,
    ) -> dict[str, Any]:
        return {
            "protocol": self._contract.protocol,
            "requestId": request_id,
            "ok": False,
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable,
            },
            "meta": {
                "version": "0.1.0",
                "executedBy": "python-daemon",
                "timingMs": timing_ms,
            },
        }

    def _resolve_environment_type(self, environment_name: Any) -> str:
        valid_environment_types = set(self._contract.nouns["environment"]["properties"]["type"]["enum"])
        return str(environment_name) if environment_name in valid_environment_types else "workspace"

    def _invoke_repo_tool(self, tool_id: str, tool_input: dict[str, Any]) -> dict[str, Any]:
        if tool_id in {"repo.listTree", "repo.list"}:
            return list_repository_tree(tool_input)
        if tool_id in {"repo.readFile", "repo.read_file"}:
            return read_repository_file(tool_input)
        if tool_id == "repo.search":
            return search_repository(tool_input)
        if tool_id == "repo.getStatus":
            return get_repository_status(tool_input)
        if tool_id == "repo.getLog":
            return get_repository_log(tool_input)
        if tool_id == "repo.getDiff":
            return get_repository_diff(tool_input)
        raise KeyError(f'Tool "{tool_id}" is not invokable through tool.invoke.')

    def _require_caller_metadata(self, context: dict[str, Any]) -> dict[str, Any]:
        caller = context.get("caller")
        if not isinstance(caller, dict):
            raise PermissionError("Repo tools require caller metadata in context.caller.")

        caller_id = str(caller.get("id", "")).strip()
        caller_type = str(caller.get("type", "")).strip()
        if not caller_id or not caller_type:
            raise PermissionError("Repo tools require non-empty context.caller.id and context.caller.type values.")

        scopes = caller.get("scopes")
        normalized_scopes = [
            str(scope).strip()
            for scope in scopes
            if isinstance(scope, str) and str(scope).strip()
        ] if isinstance(scopes, list) else []

        normalized_caller = {
            "id": caller_id,
            "type": caller_type,
            "scopes": normalized_scopes,
        }
        if isinstance(caller.get("metadata"), dict):
            normalized_caller["metadata"] = deepcopy(caller["metadata"])
        return normalized_caller

    def _authorize_tool_call(
        self,
        tool_id: str,
        caller: dict[str, Any],
        context: dict[str, Any],
    ) -> None:
        tool_definition = self._tool_registry_by_id[tool_id]
        environment_type = self._resolve_environment_type(context.get("environment"))
        if environment_type != tool_definition["preferredEnvironmentType"]:
            raise PermissionError(
                f'Tool "{tool_id}" requires the "{tool_definition["preferredEnvironmentType"]}" environment.'
            )

        caller_type = str(caller["type"])
        if caller_type not in tool_definition["allowedClients"]:
            raise PermissionError(f'Caller type "{caller_type}" is not allowed to invoke "{tool_id}".')

        caller_scopes = set(caller.get("scopes") or [])
        missing_scopes = [scope for scope in tool_definition["scopes"] if scope not in caller_scopes]
        if missing_scopes:
            raise PermissionError(
                f'Tool "{tool_id}" requires scopes: {", ".join(missing_scopes)}.'
            )

        environment_descriptor = self._build_environment_descriptor(
            environment_type=environment_type,
            cwd=context.get("cwd") or str(self._workspace_root),
            shell=context.get("shell"),
            include_execution=True,
        )
        environment_capabilities = set(environment_descriptor["capabilities"])
        missing_capabilities = [
            capability
            for capability in tool_definition["requiredCapabilities"]
            if capability not in environment_capabilities
        ]
        if missing_capabilities:
            raise PermissionError(
                f'Tool "{tool_id}" requires environment capabilities: {", ".join(missing_capabilities)}.'
            )

    def _timing_ms(self, started_at: float) -> int:
        return int((time.perf_counter() - started_at) * 1000)

    def _prune_none_values(self, value: Any) -> Any:
        if isinstance(value, list):
            return [self._prune_none_values(item) for item in value]
        if isinstance(value, dict):
            return {
                key: self._prune_none_values(item)
                for key, item in value.items()
                if item is not None
            }
        return value
