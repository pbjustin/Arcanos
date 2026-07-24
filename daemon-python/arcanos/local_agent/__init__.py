"""Backend-authorized local-agent capability bridge."""

from typing import Any

__all__ = [
    "LOCAL_AGENT_ACTIONS",
    "PatchExecutionAuthorization",
    "build_local_agent_handler_registry",
    "execute_local_agent_action",
    "issue_patch_execution_authorization",
]


def __getattr__(name: str) -> Any:
    """Resolve public helpers lazily so existing repo tools avoid import cycles."""

    if name in {
        "LOCAL_AGENT_ACTIONS",
        "build_local_agent_handler_registry",
        "execute_local_agent_action",
    }:
        from . import handlers

        return getattr(handlers, name)
    if name in {
        "PatchExecutionAuthorization",
        "issue_patch_execution_authorization",
    }:
        from . import patch_handler

        return getattr(patch_handler, name)
    raise AttributeError(name)
