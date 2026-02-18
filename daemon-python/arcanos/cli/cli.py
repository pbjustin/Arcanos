"""
ARCANOS CLI orchestration shell.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
import uuid
from typing import Any, Callable, Mapping, Optional

if sys.platform == "win32":
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
    except Exception:
        pass
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

from rich.markdown import Markdown
from rich.table import Table
from rich.console import Console

from .audit import record as audit_record
from .idempotency import IdempotencyGuard
from .trust_state import TrustState

from ..backend_client import BackendApiClient, BackendRequestError, BackendResponse
from ..cli_config import (
    DOMAIN_KEYWORDS,
    ZERO_COST_USD,
    ZERO_TOKENS_USED,
)
from ..cli_types import DaemonCommand
from ..cli_intents import detect_domain_intent, truncate_for_tts
from ..cli_runner import run_debug_mode, run_interactive_mode
from ..config import Config, validate_required_config
from ..credential_bootstrap import CredentialBootstrapError, bootstrap_credentials
from ..error_handler import handle_errors, logger as error_logger
from ..gpt_client import GPTClient
from ..rate_limiter import RateLimiter
from ..schema import Memory
from ..terminal import TerminalController
from ..vision import VisionSystem
from ..audio import AudioSystem
from ..voice_boundary import Persona, apply_voice_boundary
from ..conversation_routing import ConversationRouteDecision, determine_conversation_route
from ..cli_session import SessionContext
from ..cli_ui import build_stats_table
from . import (
    backend_ops,
    bootstrap,
    confirmation,
    daemon_ops,
    local_ops,
    memory_ops,
    run_ops,
    state,
    ui_ops,
)
from .context import ConversationResult, _UNSET_FILTER, get_or_create_instance_id, resolve_persona
from ..cli_midlayer import translate

try:
    from ..push_to_talk import AdvancedPushToTalkManager

    PTT_AVAILABLE = True
except ImportError:
    PTT_AVAILABLE = False


_ConversationResult = ConversationResult


class ArcanosCLI:
    """Main ARCANOS CLI application orchestration shell."""

    def __init__(self):
        """
        Purpose: Initialize CLI services, backend clients, state managers, and background runtime threads.
        Inputs/Outputs: None; mutates runtime object fields and may exit on fatal configuration issues.
        Edge cases: Exits process for invalid startup sequence or missing credentials.
        """
        self.console = Console()
        self.start_time = time.time()
        self._last_error: Optional[str] = None
        self._activity_lock = threading.Lock()

        bootstrap.ensure_startup_sequence(self)

        self.memory = Memory()
        self.rate_limiter = RateLimiter()

        self.instance_id = get_or_create_instance_id(self)
        self.client_id = "arcanos-cli"

        self._heartbeat_thread: Optional[threading.Thread] = None
        self._command_poll_thread: Optional[threading.Thread] = None
        self._daemon_running = False
        self._heartbeat_interval = Config.DAEMON_HEARTBEAT_INTERVAL_SECONDS
        self._command_poll_interval = Config.DAEMON_COMMAND_POLL_INTERVAL_SECONDS

        try:
            self.gpt_client = GPTClient()
        except ValueError as exc:
            self.console.print(f"[red]⚠️  Error: {exc}[/red]")
            self.console.print(f"\n[yellow]💡 Add your API key to {Config.ENV_PATH}[/yellow]")
            sys.exit(1)

        self.vision = VisionSystem(self.gpt_client)
        self.audio = AudioSystem(self.gpt_client)
        self.terminal = TerminalController()
        self._last_response: Optional[str] = None
        self._voice_persona = Persona.CALM

        self.backend_client: Optional[BackendApiClient] = None
        if Config.BACKEND_URL:
            try:
                self.backend_client = BackendApiClient(
                    base_url=Config.BACKEND_URL,
                    token_provider=lambda: Config.BACKEND_TOKEN,
                    timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT,
                )
            except Exception:
                raise

        state.initialize_runtime_state(self)

        if self.backend_client:
            backend_ops.refresh_registry_cache(self)

        if Config.BACKEND_URL and self.backend_client:
            self._start_daemon_threads()
            if self._daemon_running:
                self.console.print("[green]?[/green] Backend connection active (heartbeat + command polling)")
            else:
                self.console.print(
                    "[yellow]?[/yellow] Backend configured but daemon threads skipped (check BACKEND_TOKEN)"
                )

        self._ptt_available = PTT_AVAILABLE
        self.ptt_manager = None
        if self._ptt_available:
            self.ptt_manager = AdvancedPushToTalkManager(self.audio, self.handle_ptt_speech)

        self.session = SessionContext(session_id=self.instance_id)

        self._idempotency_guard = IdempotencyGuard()
        self._recompute_trust_state()

        if self.backend_client:
            state_payload = backend_ops.request_backend_system_state_payload(self)
            if state_payload:
                state.hydrate_session_from_backend_state(self, state_payload)

        self.system_prompt = state.build_system_prompt(self)

        bootstrap.start_update_checker(self)
        bootstrap.start_debug_server_if_enabled(self)

    def _append_activity(self, kind: str, detail: str):
        return state.append_activity(self, kind, detail)

    def _set_trust_state(self, new_state: TrustState) -> None:
        return state.set_trust_state(self, new_state)

    def _recompute_trust_state(self) -> None:
        return state.recompute_trust_state(self)

    def speak_to_user(
        self,
        raw_text: str,
        *,
        persona: Persona,
        user_text: str,
        memory: Any,
        debug_voice: bool = False,
        filtered_text: Any = _UNSET_FILTER,
    ) -> Optional[str]:
        return ui_ops.speak_to_user(
            self,
            raw_text,
            persona=persona,
            user_text=user_text,
            memory=memory,
            debug_voice=debug_voice,
            filtered_text=filtered_text,
        )

    def _get_or_create_instance_id(self) -> str:
        return get_or_create_instance_id(self)

    def _resolve_persona(self) -> Persona:
        return resolve_persona(self)

    def _update_short_term_summary(self) -> None:
        return memory_ops.update_short_term_summary(self)

    def show_welcome(self) -> None:
        return bootstrap.show_welcome(self)

    def first_run_setup(self) -> None:
        return bootstrap.first_run_setup(self)

    def _report_backend_error(self, action_label: str, error: Optional[BackendRequestError]) -> None:
        return backend_ops.report_backend_error(self, action_label, error)

    def _refresh_backend_credentials(self) -> bool:
        return backend_ops.refresh_backend_credentials(self)

    def _request_with_auth_retry(
        self,
        request_func: Callable[[], BackendResponse[Any]],
        action_label: str,
    ) -> BackendResponse[Any]:
        return backend_ops.request_with_auth_retry(self, request_func, action_label)

    def _request_backend_system_state_payload(self) -> Optional[dict[str, Any]]:
        return backend_ops.request_backend_system_state_payload(self)

    def _hydrate_session_from_backend_state(self, state_payload: Mapping[str, Any]) -> None:
        return state.hydrate_session_from_backend_state(self, state_payload)

    def _render_system_state_table(self, state_payload: Mapping[str, Any]) -> None:
        return ui_ops.render_system_state_table(self, state_payload)

    def _is_working_context_query(self, message: str) -> bool:
        return state.is_working_context_query(message)

    def handle_status(self) -> bool:
        """
        Purpose: Show backend-owned governed status using /ask mode=system_state.
        Inputs/Outputs: None; renders status table and returns success flag.
        Edge cases: Returns False when backend is not configured or state fetch fails.
        """
        if not self.backend_client:
            # //audit assumption: status requires backend source-of-truth; risk: stale local-only status; invariant: fail when backend missing; strategy: print error and return False.
            self.console.print("[red]Backend is not configured.[/red]")
            return False

        state_payload = backend_ops.request_backend_system_state_payload(self)
        if not state_payload:
            # //audit assumption: failed state fetch cannot be substituted locally; risk: fabricated status; invariant: no synthetic state output; strategy: fail closed.
            self.console.print("[red]Failed to fetch backend system state.[/red]")
            return False

        state.hydrate_session_from_backend_state(self, state_payload)
        ui_ops.render_system_state_table(self, state_payload)
        return True

    def _registry_cache_is_valid(self) -> bool:
        return state.registry_cache_is_valid(self)

    def _refresh_registry_cache(self) -> None:
        return backend_ops.refresh_registry_cache(self)

    def _refresh_registry_cache_if_stale(self) -> None:
        return backend_ops.refresh_registry_cache_if_stale(self)

    def _get_backend_connection_status(self) -> str:
        return state.get_backend_connection_status(self)

    def _get_backend_block(self) -> str:
        return state.get_backend_block(self)

    def _build_system_prompt(self) -> str:
        return state.build_system_prompt(self)

    def _confirm_pending_actions(self, confirmation_token: str) -> Optional[_ConversationResult]:
        return backend_ops.confirm_pending_actions(self, confirmation_token)

    def _handle_confirmation_required(
        self,
        error: BackendRequestError,
        from_debug: bool = False,
    ) -> Optional[_ConversationResult]:
        return confirmation.handle_confirmation_required(self, error, from_debug=from_debug)

    def _start_daemon_threads(self) -> None:
        return daemon_ops.start_daemon_threads(self)

    def _heartbeat_loop(self) -> None:
        return daemon_ops.heartbeat_loop(self)

    def _command_poll_loop(self) -> None:
        return daemon_ops.command_poll_loop(self)

    def _handle_daemon_command(self, command: DaemonCommand):
        return daemon_ops.handle_daemon_command(self, command)

    def _stop_daemon_service(self) -> None:
        return daemon_ops.stop_daemon_service(self)

    def _perform_local_conversation(self, message: str) -> Optional[_ConversationResult]:
        return local_ops.perform_local_conversation(self, message)

    def _perform_local_conversation_streaming(self, message: str) -> Optional[_ConversationResult]:
        return local_ops.perform_local_conversation_streaming(self, message)

    def _perform_backend_conversation(
        self,
        message: str,
        domain: Optional[str] = None,
        from_debug: bool = False,
    ) -> Optional[_ConversationResult]:
        return backend_ops.perform_backend_conversation(self, message, domain=domain, from_debug=from_debug)

    def _encode_audio_base64(self, audio_data: bytes | bytearray) -> Optional[str]:
        return backend_ops.encode_audio_base64(self, audio_data)

    def _perform_backend_transcription(self, audio_data: bytes | bytearray) -> Optional[str]:
        return backend_ops.perform_backend_transcription(self, audio_data)

    def _perform_backend_vision(self, use_camera: bool) -> Optional[_ConversationResult]:
        return backend_ops.perform_backend_vision(self, use_camera)

    def _build_backend_metadata(self) -> dict[str, str]:
        return backend_ops.build_backend_metadata(self)

    def _confirm_action(self, message: str) -> bool:
        """
        Purpose: Prompt the operator for a yes/no confirmation.
        Inputs/Outputs: message text; returns True when confirmed, False otherwise.
        Edge cases: Non-interactive stdin rejects by default.
        """
        # //audit: ensure confirmations require a TTY to avoid accidental approvals; fail closed when non-interactive
        if not sys.stdin.isatty():
            self.console.print("[red]Action rejected.[/red]")
            return False

        response = self.console.input(f"{message} [y/N]: ").strip().lower()
        return response in ("y", "yes")

    def _send_backend_update(self, update_type: str, data: Mapping[str, Any]) -> None:
        return backend_ops.send_backend_update(self, update_type, data)

    @handle_errors("processing user input")
    def handle_ask(
        self,
        message: str,
        route_override: Optional[str] = None,
        speak_response: bool = False,
        return_result: bool = False,
        from_debug: bool = False,
    ) -> Optional[_ConversationResult]:
        """
        Purpose: Route and handle a conversation request locally or via backend.
        Inputs/Outputs: message text + routing flags; prints response and updates state.
        Edge cases: Falls back to local model when backend is unavailable and fallback is enabled.
        """
        self._append_activity("ask", message)
        self._recompute_trust_state()
        audit_record("execute_attempt", command="ask", trust=self._trust_state.name)

        can_request, deny_reason = self.rate_limiter.can_make_request()
        if not can_request:
            self.console.print(f"[red]Rate limit: {deny_reason}[/red]")
            return None if return_result else None

        self.session.turn_count += 1

        if self.backend_client:
            state_payload = backend_ops.request_backend_system_state_payload(self)
        else:
            state_payload = None

        if state_payload and state.is_working_context_query(message):
            state.hydrate_session_from_backend_state(self, state_payload)
            intent_payload = state_payload.get("intent") if isinstance(state_payload.get("intent"), Mapping) else {}
            label = intent_payload.get("label")
            status_value = intent_payload.get("status")
            answer_label = label if isinstance(label, str) and label.strip() else "No active intent"
            answer_status = status_value if isinstance(status_value, str) and status_value.strip() else "null"
            answer_text = f"{answer_label} (status: {answer_status})"

            if return_result:
                return ConversationResult(
                    response_text=answer_text,
                    tokens_used=ZERO_TOKENS_USED,
                    cost_usd=ZERO_COST_USD,
                    model=Config.BACKEND_CHAT_MODEL or "backend",
                    source="backend",
                )

            table = Table(title="Current Work Context")
            table.add_column("Field", style="cyan")
            table.add_column("Value", style="green")
            table.add_row("intent", answer_label)
            table.add_row("status", answer_status)
            self.console.print(table)
            return None

        if state_payload:
            state.hydrate_session_from_backend_state(self, state_payload)

        self.system_prompt = state.build_system_prompt(self)

        route_decision = determine_conversation_route(
            user_message=message,
            routing_mode=Config.BACKEND_ROUTING_MODE,
            deep_prefixes=Config.BACKEND_DEEP_PREFIXES,
        )
        if route_override in {"local", "backend"}:
            route_decision = ConversationRouteDecision(
                route=route_override,
                normalized_message=message.strip() or message,
                used_prefix=None,
            )
        elif self.backend_client and self._backend_routing_preferred == "backend":
            route_decision = ConversationRouteDecision(
                route="backend",
                normalized_message=message.strip() or message,
                used_prefix=None,
            )

        domain = detect_domain_intent(message, DOMAIN_KEYWORDS) if route_decision.route == "backend" else None

        result: Optional[ConversationResult] = None
        use_streaming = Config.STREAM_RESPONSES and route_decision.route == "local" and not return_result

        if use_streaming:
            result = local_ops.perform_local_conversation_streaming(self, route_decision.normalized_message)
        else:
            with self.console.status("[dim]Thinking...[/dim]", spinner="dots"):
                if route_decision.route == "backend":
                    result = backend_ops.perform_backend_conversation(
                        self,
                        route_decision.normalized_message,
                        domain=domain,
                        from_debug=from_debug,
                    )
                    if result is None and Config.BACKEND_FALLBACK_TO_LOCAL and not self._last_confirmation_handled:
                        try:
                            import json as _json

                            _debug_log_path = Config.DEBUG_LOG_PATH
                            _debug_log_path.parent.mkdir(parents=True, exist_ok=True)
                            with _debug_log_path.open("a", encoding="utf-8") as _lf:
                                _lf.write(
                                    _json.dumps(
                                        {
                                            "kind": "suspicious",
                                            "location": "cli.py:handle_ask:fallback",
                                            "message": "Backend unavailable; falling back to local",
                                            "data": {"message_length": len(route_decision.normalized_message)},
                                            "timestamp": int(time.time() * 1000),
                                            "sessionId": "debug-session",
                                            "hypothesisId": "FALLBACK",
                                        }
                                    )
                                    + "\n"
                                )
                        except (OSError, IOError) as write_error:
                            error_logger.debug("Debug log write failed: %s", write_error)
                        self._set_trust_state(TrustState.DEGRADED)
                        self.console.print("[yellow]Backend unavailable; falling back to local model.[/yellow]")
                        result = local_ops.perform_local_conversation(self, route_decision.normalized_message)
                else:
                    result = local_ops.perform_local_conversation(self, route_decision.normalized_message)

        if not result:
            if not return_result:
                self.console.print("[red]No response generated.[/red]")
            return None

        response_for_user: Optional[str] = None
        if not return_result:
            translated, show = translate(
                message,
                result.response_text,
                source=result.source,
                debug=from_debug,
            )
            if show and translated:
                persona = resolve_persona(self)
                sanitized = translated
                if result.source == "backend":
                    sanitized = apply_voice_boundary(
                        translated,
                        persona=persona,
                        user_text=message,
                        memory=self.memory,
                        debug_voice=from_debug,
                    )
                response_for_user = sanitized
                if not use_streaming:
                    self.console.print()
                    self.console.print(Markdown(sanitized))
                    self.console.print()

        update_payload = {
            "eventId": str(uuid.uuid4()),
            "source": result.source,
            "tokens": result.tokens_used,
            "cost": result.cost_usd,
            "model": result.model,
            "messageLength": len(route_decision.normalized_message),
        }

        conversation_response = result.response_text if return_result else (response_for_user or "")
        memory_ops.record_conversation_turn(
            self,
            route_decision.normalized_message,
            conversation_response,
            result.tokens_used,
            result.cost_usd,
        )
        if not return_result:
            memory_ops.remember_last_response(self, response_for_user)

        backend_ops.send_backend_update(self, "conversation_usage", update_payload)
        audit_record("execute_success", command="ask", trust=self._trust_state.name, source=result.source)

        if result.source == "backend" and self.backend_client:
            refreshed_state = backend_ops.request_backend_system_state_payload(self)
            if refreshed_state:
                state.hydrate_session_from_backend_state(self, refreshed_state)

        memory_ops.update_short_term_summary(self)

        if return_result:
            return result

        should_speak = speak_response or Config.SPEAK_RESPONSES
        if should_speak:
            truncated = truncate_for_tts(response_for_user or "")
            if truncated:
                self.audio.speak(truncated, wait=True)

        if Config.SHOW_STATS:
            stats = self.memory.get_statistics()
            rate_stats = self.rate_limiter.get_usage_stats()
            table = build_stats_table(
                stats=stats,
                rate_stats=rate_stats,
                max_requests_per_hour=Config.MAX_REQUESTS_PER_HOUR,
                max_tokens_per_day=Config.MAX_TOKENS_PER_DAY,
                max_cost_per_day=Config.MAX_COST_PER_DAY,
            )
            self.console.print(table)

        return None

    @handle_errors("vision analysis")
    def handle_see(self, args: list[str], return_result: bool = False) -> Optional[dict]:
        return local_ops.handle_see(self, args, return_result=return_result)

    @handle_errors("voice input")
    def handle_voice(self, args: list[str]) -> None:
        return local_ops.handle_voice(self, args)

    @handle_errors("starting push-to-talk")
    def handle_ptt(self) -> None:
        return local_ops.handle_ptt(self)

    def handle_ptt_speech(self, text: str, has_screenshot: bool) -> None:
        return local_ops.handle_ptt_speech(self, text, has_screenshot)

    @handle_errors("executing terminal command")
    def handle_run(self, command: str, return_result: bool = False) -> Optional[dict]:
        return run_ops.handle_run(self, command, return_result=return_result)

    @handle_errors("speaking response")
    def handle_speak(self) -> None:
        return ui_ops.handle_speak(self)

    def handle_stats(self) -> None:
        return ui_ops.handle_stats(self)

    def handle_help(self) -> None:
        return ui_ops.handle_help(self)

    def handle_clear(self) -> None:
        return ui_ops.handle_clear(self)

    def handle_reset(self) -> None:
        return ui_ops.handle_reset(self)

    def handle_update(self) -> None:
        return bootstrap.handle_update(self)

    def run(self, debug_mode: bool = False) -> None:
        """
        Purpose: Run CLI loop in debug or interactive mode.
        Inputs/Outputs: debug_mode flag; blocks until exit.
        Edge cases: None.
        """
        if debug_mode:
            run_debug_mode(self)
        else:
            run_interactive_mode(self)


def main() -> None:
    """
    Purpose: Console entry point for ARCANOS CLI runtime.
    Inputs/Outputs: Parses args, bootstraps credentials, and runs CLI.
    Edge cases: Exits with status 1 when credential bootstrap fails.
    """
    parser = argparse.ArgumentParser(
        prog="arcanos",
        description="ARCANOS CLI - Human-like AI assistant with rich terminal UI.",
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=["status"],
        help="Run a one-shot command such as `status` and exit.",
    )
    parser.add_argument(
        "--debug-mode",
        action="store_true",
        help="Run in non-interactive debug mode with file-based command input.",
    )

    try:
        import argcomplete

        argcomplete.autocomplete(parser)
    except ImportError:
        pass

    args = parser.parse_args()

    try:
        bootstrap_credentials()
    except CredentialBootstrapError as exc:
        print(f"Credential setup failed: {exc}")
        print(f"Crash reports are saved to: {Config.CRASH_REPORTS_DIR}")
        sys.exit(1)

    validate_required_config(exit_on_error=True)

    cli = ArcanosCLI()

    if args.command == "status":
        succeeded = cli.handle_status()
        sys.exit(0 if succeeded else 1)

    cli.run(debug_mode=args.debug_mode)


if __name__ == "__main__":
    main()
