"""
Backend I/O operations for the ARCANOS CLI.
"""

from __future__ import annotations

import base64
import time
from typing import Any, Callable, Mapping, Optional, TYPE_CHECKING

from cli.audit import record as audit_record
from cli.trust_state import TrustState

from ..backend_client import BackendRequestError, BackendResponse
from ..cli_config import (
    DEFAULT_CAMERA_VISION_PROMPT,
    DEFAULT_QUEUED_ACTIONS_COUNT,
    DEFAULT_SCREEN_VISION_PROMPT,
    SINGLE_ACTION_COUNT,
    ZERO_COST_USD,
    ZERO_TOKENS_USED,
)
from ..config import Config
from ..conversation_routing import build_conversation_messages
from ..credential_bootstrap import CredentialBootstrapError, bootstrap_credentials
from ..error_handler import logger as error_logger
from .context import ConversationResult
from . import state

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def report_backend_error(
    cli: "ArcanosCLI",
    action_label: str,
    error: Optional[BackendRequestError],
) -> None:
    """
    Purpose: Print a user-friendly backend error summary.
    Inputs/Outputs: action label and optional BackendRequestError; prints status to console.
    Edge cases: Falls back to generic message when no structured error is available.
    """
    if not error:
        # //audit assumption: error details may be missing; risk: silent failure; invariant: generic message shown; strategy: print fallback.
        cli.console.print(f"[red]Backend {action_label} failed.[/red]")
        return

    details = f" ({error.details})" if error.details else ""
    status_info = f" [{error.status_code}]" if error.status_code else ""
    cli.console.print(f"[red]Backend {action_label} failed{status_info}: {error.message}{details}[/red]")

    # //audit assumption: network and timeout errors are operator-actionable; risk: unresolved connectivity issue; invariant: remediation hint shown; strategy: print endpoint guidance.
    if error.kind == "network" or error.kind == "timeout":
        cli.console.print("[yellow]Check BACKEND_URL and ensure the backend server is running and reachable.[/yellow]")


def refresh_backend_credentials(cli: "ArcanosCLI") -> bool:
    """
    Purpose: Re-authenticate backend credentials after auth failures.
    Inputs/Outputs: CLI instance; returns True when refresh succeeds.
    Edge cases: Prints explicit failure reason and returns False on bootstrap errors.
    """
    try:
        bootstrap_credentials()
        return True
    except CredentialBootstrapError as exc:
        # //audit assumption: credential refresh can fail; risk: backend blocked; invariant: error surfaced; strategy: print explicit auth failure.
        cli.console.print(f"[red]Backend login failed: {exc}[/red]")
        return False


def request_with_auth_retry(
    cli: "ArcanosCLI",
    request_func: Callable[[], BackendResponse[Any]],
    action_label: str,
) -> BackendResponse[Any]:
    """
    Purpose: Execute a backend request with one auth-refresh retry.
    Inputs/Outputs: request function and action label; returns BackendResponse.
    Edge cases: Confirmation responses are returned without retries beyond auth refresh.
    """
    response = request_func()
    if response.ok:
        # //audit assumption: successful response requires no additional handling; risk: none; invariant: return response unchanged; strategy: short-circuit.
        return response

    if response.error and response.error.kind == "auth":
        # //audit assumption: auth errors are recoverable via credential bootstrap; risk: stale token; invariant: one refresh retry attempted; strategy: refresh and retry once.
        if refresh_backend_credentials(cli):
            response = request_func()

    if response.error and response.error.kind == "confirmation":
        # //audit assumption: confirmation path needs caller mediation; risk: auto-execution; invariant: no implicit fallback; strategy: return as-is.
        return response

    if not response.ok:
        # //audit assumption: unresolved backend failure should be surfaced to operator; risk: hidden failure; invariant: user-visible error; strategy: report.
        report_backend_error(cli, action_label, response.error)

    return response


def build_backend_metadata(cli: "ArcanosCLI") -> dict[str, str]:
    """
    Purpose: Build shared metadata for backend requests and update events.
    Inputs/Outputs: CLI instance; returns metadata dictionary.
    Edge cases: None.
    """
    return {
        "source": "daemon",
        "client": cli.client_id,
        "instanceId": cli.instance_id,
    }


def request_backend_system_state_payload(cli: "ArcanosCLI") -> Optional[dict[str, Any]]:
    """
    Purpose: Fetch backend-owned system state via /ask mode=system_state.
    Inputs/Outputs: CLI instance; returns parsed state payload or None.
    Edge cases: Returns None when backend is not configured or request fails.
    """
    if not cli.backend_client:
        # //audit assumption: backend client may be missing; risk: attempted state call without backend; invariant: no request attempted; strategy: return None.
        return None

    metadata = build_backend_metadata(cli)
    response = request_with_auth_retry(
        cli,
        lambda: cli.backend_client.request_system_state(metadata=metadata),
        "system state",
    )

    if not response.ok or not response.value:
        # //audit assumption: failed state calls should not hydrate local session; risk: stale/partial state; invariant: None on failure; strategy: return None.
        return None

    return response.value


def refresh_registry_cache(cli: "ArcanosCLI") -> None:
    """
    Purpose: Fetch backend registry and refresh local cache state.
    Inputs/Outputs: CLI instance; mutates registry cache and timestamp on success.
    Edge cases: Leaves existing cache unchanged on backend failures.
    """
    if not cli.backend_client:
        # //audit assumption: backend client required for registry fetch; risk: null dereference; invariant: no request without client; strategy: return early.
        return

    response = cli.backend_client.request_registry()
    if response.ok and response.value:
        # //audit assumption: registry payload valid on ok response; risk: stale model registry; invariant: cache refreshed with timestamp; strategy: update state cache.
        state.apply_registry_cache(cli, response.value)
        return

    if not cli._registry_cache and not cli._registry_cache_warning_logged:
        # //audit assumption: first registry failure should be visible; risk: silent downgrade to fallback prompt; invariant: warn once; strategy: one-time console warning.
        cli.console.print("[yellow]Backend registry unavailable; using built-in backend prompt.[/yellow]")
        cli._registry_cache_warning_logged = True


def refresh_registry_cache_if_stale(cli: "ArcanosCLI") -> None:
    """
    Purpose: Refresh registry cache when stale and rebuild prompt if cache becomes valid.
    Inputs/Outputs: CLI instance; may mutate prompt and trust state.
    Edge cases: No-op when backend is not configured or cache remains stale after refresh.
    """
    if not cli.backend_client:
        # //audit assumption: backend client required; risk: unnecessary branch work; invariant: no refresh without backend; strategy: return.
        return
    if state.registry_cache_is_valid(cli):
        # //audit assumption: fresh cache needs no refetch; risk: excess network load; invariant: no redundant fetch; strategy: return.
        return

    refresh_registry_cache(cli)
    state.recompute_trust_state(cli)
    if state.registry_cache_is_valid(cli):
        # //audit assumption: refreshed cache should update prompt context; risk: stale prompt using old registry; invariant: prompt rebuilt after successful refresh; strategy: rebuild prompt.
        cli.system_prompt = state.build_system_prompt(cli)


def confirm_pending_actions(cli: "ArcanosCLI", confirmation_token: str) -> Optional[ConversationResult]:
    """
    Purpose: Confirm pending daemon actions with the backend.
    Inputs/Outputs: confirmation token string; returns ConversationResult or None.
    Edge cases: Returns None when backend rejects token or is unavailable.
    """
    if not cli.backend_client:
        # //audit assumption: backend required for confirmation exchange; risk: false positive confirmation; invariant: return None offline; strategy: reject.
        return None

    response = request_with_auth_retry(
        cli,
        lambda: cli.backend_client.request_confirm_daemon_actions(confirmation_token, cli.instance_id),
        "confirm actions",
    )
    if not response.ok or not response.value:
        # //audit assumption: confirmation failure should not queue actions; risk: accidental execution; invariant: stop on failure; strategy: return None.
        return None

    queued_value = response.value.get("queued")
    queued_count = DEFAULT_QUEUED_ACTIONS_COUNT
    if isinstance(queued_value, int):
        # //audit assumption: queued count may be provided as int; risk: malformed types; invariant: int count used when valid; strategy: type-guard.
        queued_count = queued_value

    if queued_count == SINGLE_ACTION_COUNT:
        plural = "action"
    else:
        plural = "actions"

    response_text = f"Queued {queued_count} {plural}."
    return ConversationResult(
        response_text=response_text,
        tokens_used=ZERO_TOKENS_USED,
        cost_usd=ZERO_COST_USD,
        model=Config.BACKEND_CHAT_MODEL or "backend",
        source="backend",
    )


def perform_backend_conversation(
    cli: "ArcanosCLI",
    message: str,
    domain: Optional[str] = None,
    from_debug: bool = False,
) -> Optional[ConversationResult]:
    """
    Purpose: Execute backend conversation with optional domain routing.
    Inputs/Outputs: message text, optional domain hint, debug flag; returns ConversationResult or None.
    Edge cases: Handles confirmation-required responses through governance gates.
    """
    if not cli.backend_client:
        # //audit assumption: backend client optional; risk: missing backend path; invariant: explicit warning; strategy: print and return None.
        cli.console.print("[yellow]Backend is not configured.[/yellow]")
        return None

    cli._last_confirmation_handled = False
    refresh_registry_cache_if_stale(cli)

    # //audit assumption: history limit must not be negative; risk: invalid slice behavior; invariant: non-negative history count; strategy: clamp to zero.
    history_limit = max(0, Config.BACKEND_HISTORY_LIMIT)
    history = cli.memory.get_recent_conversations(limit=history_limit) if history_limit else []
    messages = build_conversation_messages(
        system_prompt=cli.system_prompt,
        conversation_history=history,
        user_message=message,
        max_history=history_limit,
    )

    metadata = build_backend_metadata(cli)

    if domain:
        response = request_with_auth_retry(
            cli,
            lambda: cli.backend_client.request_ask_with_domain(
                message=message,
                domain=domain,
                metadata=metadata,
            ),
            "chat",
        )
    else:
        response = request_with_auth_retry(
            cli,
            lambda: cli.backend_client.request_chat_completion(
                messages=messages,
                temperature=Config.TEMPERATURE,
                model=Config.BACKEND_CHAT_MODEL or None,
                metadata=metadata,
            ),
            "chat",
        )

    if response.ok and response.value:
        # //audit assumption: ok response includes typed value; risk: partial payload; invariant: mapped ConversationResult on success; strategy: project payload fields.
        return ConversationResult(
            response_text=response.value.response_text,
            tokens_used=response.value.tokens_used,
            cost_usd=response.value.cost_usd,
            model=response.value.model,
            source="backend",
        )

    if response.error and response.error.kind == "confirmation":
        # //audit assumption: backend confirmed reachability when confirmation is returned; risk: stale trust state; invariant: trust recomputed before gating; strategy: recompute.
        state.recompute_trust_state(cli)

        # Governance invariant: confirmation-required actions require FULL trust.
        if cli._trust_state != TrustState.FULL:
            state.set_trust_state(cli, TrustState.UNSAFE)
            audit_record(
                "governance_denial",
                command="backend_confirm",
                reason="confirmation requires FULL trust; registry stale",
                trust=cli._trust_state.name,
            )
            cli.console.print("[red]Action requires FULL trust for confirmation; registry stale.[/red]")
            return None

        cli._last_confirmation_handled = True
        from .confirmation import handle_confirmation_required

        return handle_confirmation_required(cli, response.error, from_debug=from_debug)

    # //audit assumption: backend failed without confirmation path; risk: no response; invariant: caller handles None; strategy: return None.
    return None


def encode_audio_base64(cli: "ArcanosCLI", audio_data: bytes | bytearray) -> Optional[str]:
    """
    Purpose: Extract and base64-encode audio bytes for backend transcription.
    Inputs/Outputs: raw audio bytes; returns base64 string or None.
    Edge cases: Returns None and prints an error when extraction fails.
    """
    try:
        audio_bytes = cli.audio.extract_audio_bytes(audio_data)
    except RuntimeError as exc:
        # //audit assumption: extraction may fail for malformed buffers; risk: invalid upload payload; invariant: explicit failure shown; strategy: print error and abort.
        cli.console.print(f"[red]Audio encoding failed: {exc}[/red]")
        return None

    return base64.b64encode(audio_bytes).decode("ascii")


def perform_backend_transcription(
    cli: "ArcanosCLI",
    audio_data: bytes | bytearray,
) -> Optional[str]:
    """
    Purpose: Request backend transcription for captured audio.
    Inputs/Outputs: audio bytes; returns transcription text or None.
    Edge cases: Returns None on backend unavailability or API failure.
    """
    if not cli.backend_client:
        cli.console.print("[yellow]Backend is not configured.[/yellow]")
        return None

    audio_base64 = encode_audio_base64(cli, audio_data)
    if not audio_base64:
        return None

    metadata = build_backend_metadata(cli)
    response = request_with_auth_retry(
        cli,
        lambda: cli.backend_client.request_transcription(
            audio_base64=audio_base64,
            filename="speech.wav",
            model=Config.BACKEND_TRANSCRIBE_MODEL or None,
            metadata=metadata,
        ),
        "transcription",
    )

    if not response.ok or not response.value:
        return None

    return response.value.text


def perform_backend_vision(cli: "ArcanosCLI", use_camera: bool) -> Optional[ConversationResult]:
    """
    Purpose: Send camera/screen vision requests to backend analysis endpoint.
    Inputs/Outputs: use_camera flag; returns ConversationResult or None.
    Edge cases: Returns None when capture fails or backend call fails.
    """
    if not cli.backend_client:
        cli.console.print("[yellow]Backend is not configured.[/yellow]")
        return None

    if use_camera:
        image_base64 = cli.vision.capture_camera(camera_index=0, save=True)
        default_prompt = DEFAULT_CAMERA_VISION_PROMPT
        mode_label = "camera"
    else:
        image_base64 = cli.vision.capture_screenshot(save=True)
        default_prompt = DEFAULT_SCREEN_VISION_PROMPT
        mode_label = "screen"

    if not image_base64:
        return None

    metadata = build_backend_metadata(cli)
    response = request_with_auth_retry(
        cli,
        lambda: cli.backend_client.request_vision_analysis(
            image_base64=image_base64,
            prompt=default_prompt,
            temperature=Config.TEMPERATURE,
            model=Config.BACKEND_VISION_MODEL or None,
            metadata=metadata,
            max_tokens=Config.MAX_TOKENS,
        ),
        f"vision ({mode_label})",
    )

    if not response.ok or not response.value:
        return None

    return ConversationResult(
        response_text=response.value.response_text,
        tokens_used=response.value.tokens_used,
        cost_usd=response.value.cost_usd,
        model=response.value.model,
        source="backend",
    )


def send_backend_update(
    cli: "ArcanosCLI",
    update_type: str,
    data: Mapping[str, Any],
) -> None:
    """
    Purpose: Send usage/update telemetry events to backend when enabled.
    Inputs/Outputs: update type and payload data; returns None.
    Edge cases: No-op when backend updates are disabled or backend client is absent.
    """
    if not Config.BACKEND_SEND_UPDATES:
        # //audit assumption: operator may disable backend updates; risk: missing telemetry; invariant: no update when disabled; strategy: return.
        return
    if not cli.backend_client:
        # //audit assumption: backend client optional; risk: send attempt without client; invariant: safe no-op; strategy: return.
        return

    metadata = build_backend_metadata(cli)
    response = request_with_auth_retry(
        cli,
        lambda: cli.backend_client.submit_update_event(
            update_type=update_type,
            data=data,
            metadata=metadata,
        ),
        "update",
    )
    if response.ok:
        return


def request_daemon_heartbeat(cli: "ArcanosCLI", uptime: float):
    """
    Purpose: Send daemon heartbeat payload to backend.
    Inputs/Outputs: uptime seconds; returns raw HTTP response object.
    Edge cases: Raises backend client exceptions exactly as underlying client does.
    """
    if not cli.backend_client:
        raise RuntimeError("Backend client is not configured")

    return cli.backend_client.make_raw_request(
        "POST",
        "/api/daemon/heartbeat",
        json={
            "clientId": cli.client_id,
            "instanceId": cli.instance_id,
            "version": Config.VERSION,
            "uptime": uptime,
            "routingMode": "http",
            "stats": {},
        },
    )


def request_daemon_commands(cli: "ArcanosCLI"):
    """
    Purpose: Poll backend daemon command queue.
    Inputs/Outputs: CLI instance; returns raw HTTP response.
    Edge cases: Raises backend client exceptions exactly as underlying client does.
    """
    if not cli.backend_client:
        raise RuntimeError("Backend client is not configured")

    return cli.backend_client.make_raw_request(
        "GET",
        f"/api/daemon/commands?instance_id={cli.instance_id}",
    )


def acknowledge_daemon_commands(cli: "ArcanosCLI", command_ids: list[str]):
    """
    Purpose: Acknowledge processed daemon commands to backend.
    Inputs/Outputs: list of command IDs; returns raw HTTP response.
    Edge cases: Raises backend client exceptions exactly as underlying client does.
    """
    if not cli.backend_client:
        raise RuntimeError("Backend client is not configured")

    return cli.backend_client.make_raw_request(
        "POST",
        "/api/daemon/commands/ack",
        json={
            "commandIds": command_ids,
            "instanceId": cli.instance_id,
        },
    )


__all__ = [
    "acknowledge_daemon_commands",
    "build_backend_metadata",
    "confirm_pending_actions",
    "encode_audio_base64",
    "perform_backend_conversation",
    "perform_backend_transcription",
    "perform_backend_vision",
    "refresh_backend_credentials",
    "refresh_registry_cache",
    "refresh_registry_cache_if_stale",
    "report_backend_error",
    "request_backend_system_state_payload",
    "request_daemon_commands",
    "request_daemon_heartbeat",
    "request_with_auth_retry",
    "send_backend_update",
]
