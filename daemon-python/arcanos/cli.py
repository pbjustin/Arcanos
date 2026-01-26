"""
ARCANOS CLI - Main Command Line Interface
Human-like AI assistant with rich terminal UI.
"""

import os
import re
import sys
import tempfile
import threading
import base64
import time
import urllib.request
import uuid
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Callable, Optional, Any, Mapping, Tuple

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.markdown import Markdown
from rich import print as rprint

from .config import Config
from .backend_client import BackendApiClient, BackendResponse, BackendRequestError
from .daemon_system_definition import (
    build_daemon_system_prompt,
    DEFAULT_BACKEND_BLOCK,
    format_registry_for_prompt,
)
from .conversation_routing import (
    compute_backend_confidence,
    determine_conversation_route,
    build_conversation_messages,
    ConversationRouteDecision,
)
from .media_routing import parse_vision_route_args, parse_voice_route_args
from .credential_bootstrap import CredentialBootstrapError, bootstrap_credentials
from .schema import Memory
from .gpt_client import GPTClient
from .vision import VisionSystem
from .audio import AudioSystem
from .terminal import TerminalController
from .rate_limiter import RateLimiter
from .error_handler import handle_errors, ErrorHandler, logger as error_logger
from .windows_integration import WindowsIntegration
from .update_checker import check_for_updates

try:
    from .push_to_talk import AdvancedPushToTalkManager
    PTT_AVAILABLE = True
except ImportError:
    PTT_AVAILABLE = False


@dataclass(frozen=True)
class _ConversationResult:
    """
    Purpose: Capture conversation result details for consistent processing.
    Inputs/Outputs: response text, tokens, cost, model, and source label.
    Edge cases: tokens and cost may be zero for backend responses without usage.
    """

    response_text: str
    tokens_used: int
    cost_usd: float
    model: str
    source: str


@dataclass(frozen=True)
class DaemonCommand:
    """Represents a daemon command received from the backend."""

    id: str
    name: str
    payload: Mapping[str, Any]
    issuedAt: str


class ArcanosCLI:
    """Main ARCANOS CLI application"""

    def __init__(self):
        # Initialize console
        self.console = Console()
        self.start_time = time.time()

        # Initialize components
        self.memory = Memory()
        self.rate_limiter = RateLimiter()

        # Generate or retrieve persistent instance ID
        self.instance_id = self._get_or_create_instance_id()
        self.client_id = "arcanos-daemon"  # Static client identifier

        try:
            self.gpt_client = GPTClient()
        except ValueError as e:
            self.console.print(f"[red]❌ {e}[/red]")
            self.console.print(f"\n[yellow]💡 Add your API key to {Config.ENV_PATH}[/yellow]")
            sys.exit(1)

        self.vision = VisionSystem(self.gpt_client)
        self.audio = AudioSystem(self.gpt_client)
        self.terminal = TerminalController()
        self.windows_integration = WindowsIntegration()
        self._last_response: Optional[str] = None

        self._heartbeat_thread: Optional[threading.Thread] = None
        self._command_poll_thread: Optional[threading.Thread] = None
        self._daemon_running = False
        self._heartbeat_interval = int(os.getenv("DAEMON_HEARTBEAT_INTERVAL_SECONDS", "30"))
        self._command_poll_interval = 10

        self.backend_client: Optional[BackendApiClient] = None
        if Config.BACKEND_URL:
            # //audit assumption: backend URL configured; risk: misconfigured URL; invariant: client initialized; strategy: build client.
            self.backend_client = BackendApiClient(
                base_url=Config.BACKEND_URL,
                token_provider=lambda: Config.BACKEND_TOKEN,
                timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT
            )

        self._registry_cache: Optional[dict[str, Any]] = None
        self._registry_cache_updated_at: Optional[float] = None
        self._registry_cache_warning_logged = False
        self._registry_cache_ttl_seconds = max(1, Config.REGISTRY_CACHE_TTL_MINUTES) * 60
        self._last_confirmation_handled = False

        if self.backend_client:
            # //audit assumption: backend registry fetch is best-effort; risk: startup delay; invariant: fallback prompt; strategy: attempt fetch.
            self._refresh_registry_cache()
            # Start daemon service threads for HTTP heartbeat/command polling
            self._start_daemon_threads()

        # PTT Manager
        self.ptt_manager = None
        if PTT_AVAILABLE:
            self.ptt_manager = AdvancedPushToTalkManager(
                self.audio,
                self.handle_ptt_speech
            )

        # System prompt for AI personality and daemon capabilities
        self.system_prompt = self._build_system_prompt()

        # Update checker (background); set GITHUB_RELEASES_REPO to enable
        self._update_info: Optional[dict] = None
        if Config.GITHUB_RELEASES_REPO:
            def _check() -> None:
                try:
                    info = check_for_updates(Config.VERSION, Config.GITHUB_RELEASES_REPO or "")
                    if info:
                        self._update_info = info
                        self.console.print(f"[yellow]Update available: {info['tag']}. Run 'update' to download and install.[/yellow]")
                except Exception as e:
                    error_logger.debug("Update check failed: %s", e)
            threading.Thread(target=_check, daemon=True).start()

    def _get_or_create_instance_id(self) -> str:
        """Get or create persistent instance ID for this daemon installation"""
        instance_id = self.memory.get_setting("instance_id")
        if not instance_id:
            # Generate new UUID
            instance_id = str(uuid.uuid4())
            self.memory.set_setting("instance_id", instance_id)
            self.console.print(f"[green]✓[/green] Generated daemon instance ID: {instance_id[:8]}...")
        return instance_id

    def show_welcome(self) -> None:
        """Display welcome message"""
        if not Config.SHOW_WELCOME:
            return

        welcome_text = f"""
# 🌌 Welcome to ARCANOS v{Config.VERSION}

**Your AI-powered terminal companion**

I can chat, see your screen, hear your voice, and help with commands!

Type **help** for available commands or just start chatting naturally.
        """

        self.console.print(Panel(
            Markdown(welcome_text),
            title="🌟 ARCANOS",
            border_style="cyan"
        ))

        # First-run setup
        if self.memory.get_setting("first_run", True):
            self.first_run_setup()

    def first_run_setup(self) -> None:
        """First-run configuration"""
        self.console.print("\n[cyan]👋 First time setup[/cyan]")

        # Telemetry consent
        if self.memory.get_setting("telemetry_consent") is None:
            self.console.print("\n[yellow]📊 Telemetry & Crash Reporting[/yellow]")
            self.console.print("ARCANOS can send anonymous crash reports to help improve the software.")
            self.console.print("No personal data, conversations, or API keys are collected.")

            consent = input("\nEnable telemetry? (y/n): ").lower().strip()
            self.memory.set_setting("telemetry_consent", consent == 'y')

            if consent == 'y':
                Config.TELEMETRY_ENABLED = True
                ErrorHandler.initialize()
                self.console.print("[green]✅ Telemetry enabled[/green]")
            else:
                self.console.print("[green]✅ Telemetry disabled[/green]")

        # Windows integration
        if not self.memory.get_setting("windows_integration_installed", False):
            self.console.print("\n[yellow]🪟 Windows Integration[/yellow]")
            self.console.print("Install Windows Terminal profile and desktop shortcuts?")

            install = input("\nInstall now? (y/n): ").lower().strip()
            if install == 'y':
                success = self.windows_integration.install_all()
                self.memory.set_setting("windows_integration_installed", success)

        self.memory.set_setting("first_run", False)

    def _report_backend_error(self, action_label: str, error: Optional[BackendRequestError]) -> None:
        if not error:
            # //audit assumption: error details may be missing; risk: silent failure; invariant: generic message; strategy: print fallback.
            self.console.print(f"[red]Backend {action_label} failed.[/red]")
            return

        details = f" ({error.details})" if error.details else ""
        status_info = f" [{error.status_code}]" if error.status_code else ""
        self.console.print(f"[red]Backend {action_label} failed{status_info}: {error.message}{details}[/red]")

    def _refresh_backend_credentials(self) -> bool:
        try:
            bootstrap_credentials()
            return True
        except CredentialBootstrapError as exc:
            # //audit assumption: credential refresh can fail; risk: backend blocked; invariant: error surfaced; strategy: print error.
            self.console.print(f"[red]Backend login failed: {exc}[/red]")
            return False

    def _request_with_auth_retry(
        self,
        request_func: Callable[[], BackendResponse[Any]],
        action_label: str
    ) -> BackendResponse[Any]:
        response = request_func()
        if response.ok:
            # //audit assumption: response ok; risk: none; invariant: return response; strategy: short-circuit.
            return response

        if response.error and response.error.kind == "auth":
            # //audit assumption: auth errors are recoverable; risk: stale token; invariant: refresh attempted; strategy: refresh and retry.
            if self._refresh_backend_credentials():
                response = request_func()

        if response.error and response.error.kind == "confirmation":
            # //audit assumption: confirmation requires user input; risk: auto-fallback; invariant: caller handles; strategy: return early.
            return response

        if not response.ok:
            # //audit assumption: response still failed; risk: backend unavailable; invariant: error reported; strategy: report.
            self._report_backend_error(action_label, response.error)

        return response

    def _registry_cache_is_valid(self) -> bool:
        """
        Purpose: Determine whether the backend registry cache is present and fresh.
        Inputs/Outputs: None; returns True when cache exists and TTL not expired.
        Edge cases: Returns False when cache is missing or timestamp is unset.
        """
        if not self._registry_cache:
            # //audit assumption: cache may be empty; risk: stale prompt; invariant: treat as invalid; strategy: return False.
            return False
        if self._registry_cache_updated_at is None:
            # //audit assumption: timestamp required for cache validity; risk: stale cache; invariant: invalid; strategy: return False.
            return False
        age_seconds = time.time() - self._registry_cache_updated_at
        # //audit assumption: age calculation is accurate; risk: clock drift; invariant: age >= 0; strategy: compare to TTL.
        return age_seconds <= self._registry_cache_ttl_seconds

    def _refresh_registry_cache(self) -> None:
        """
        Purpose: Fetch backend registry and update cache state.
        Inputs/Outputs: None; updates cache and timestamp on success.
        Edge cases: Leaves cache unchanged on backend errors.
        """
        if not self.backend_client:
            # //audit assumption: backend client required; risk: no registry; invariant: skip fetch; strategy: return.
            return

        response = self.backend_client.request_registry()
        if response.ok and response.value:
            # //audit assumption: registry payload valid; risk: stale data; invariant: cache refreshed; strategy: store and timestamp.
            self._registry_cache = response.value
            self._registry_cache_updated_at = time.time()
            return

        if not self._registry_cache and not self._registry_cache_warning_logged:
            # //audit assumption: registry fetch can fail; risk: missing backend info; invariant: fallback prompt; strategy: warn once.
            self.console.print("[yellow]Backend registry unavailable; using built-in backend prompt.[/yellow]")
            self._registry_cache_warning_logged = True

    def _refresh_registry_cache_if_stale(self) -> None:
        """
        Purpose: Refresh the registry cache when stale and rebuild the system prompt.
        Inputs/Outputs: None; updates system_prompt on successful refresh.
        Edge cases: No-op when backend is not configured or cache remains invalid.
        """
        if not self.backend_client:
            # //audit assumption: backend client required; risk: no registry; invariant: skip; strategy: return.
            return
        if self._registry_cache_is_valid():
            # //audit assumption: cache still fresh; risk: unnecessary fetch; invariant: no refresh; strategy: return.
            return

        self._refresh_registry_cache()
        if self._registry_cache_is_valid():
            # //audit assumption: refreshed cache should update prompt; risk: stale prompt; invariant: prompt rebuilt; strategy: rebuild.
            self.system_prompt = self._build_system_prompt()

    def _get_backend_block(self) -> str:
        """
        Purpose: Resolve the backend block for the system prompt.
        Inputs/Outputs: None; returns backend block string.
        Edge cases: Falls back to default block when registry is unavailable or invalid.
        """
        if self.backend_client and self._registry_cache_is_valid():
            # //audit assumption: registry cache valid; risk: formatting errors; invariant: block built; strategy: format registry.
            try:
                registry_block = format_registry_for_prompt(self._registry_cache or {})
            except Exception as exc:
                # //audit assumption: format failures should not crash; risk: prompt missing; invariant: fallback used; strategy: log and fallback.
                self.console.print(f"[red]Failed to format backend registry: {exc}[/red]")
                return DEFAULT_BACKEND_BLOCK
            if registry_block.strip():
                # //audit assumption: registry block is non-empty; risk: empty prompt section; invariant: use registry block; strategy: return block.
                return registry_block

        # //audit assumption: fallback block needed; risk: stale registry; invariant: default block returned; strategy: return fallback.
        return DEFAULT_BACKEND_BLOCK

    def _build_system_prompt(self) -> str:
        """
        Purpose: Build the daemon system prompt with a registry-aware backend block.
        Inputs/Outputs: None; returns system prompt string.
        Edge cases: Falls back to default backend block when registry is missing.
        """
        backend_block = self._get_backend_block()
        return build_daemon_system_prompt(backend_block)

    def _confirm_pending_actions(self, confirmation_token: str) -> Optional[_ConversationResult]:
        """
        Purpose: Confirm pending daemon actions with the backend and return a summary result.
        Inputs/Outputs: confirmation_token string; returns ConversationResult or None.
        Edge cases: Returns None when backend rejects the token or is unavailable.
        """
        if not self.backend_client:
            # //audit assumption: backend client required; risk: cannot confirm; invariant: return None; strategy: return.
            return None

        response = self._request_with_auth_retry(
            lambda: self.backend_client.request_confirm_daemon_actions(confirmation_token, self.instance_id),
            "confirm actions"
        )
        if not response.ok or not response.value:
            # //audit assumption: backend confirm failed; risk: actions not queued; invariant: return None; strategy: stop.
            return None

        queued_value = response.value.get("queued")
        queued_count = 0
        if isinstance(queued_value, int):
            # //audit assumption: queued count numeric; risk: wrong type; invariant: int count; strategy: accept int value.
            queued_count = queued_value
        else:
            # //audit assumption: queued count missing; risk: misreporting; invariant: default to zero; strategy: set default.
            queued_count = 0

        if queued_count == 1:
            # //audit assumption: singular count; risk: grammar mismatch; invariant: singular noun; strategy: use "action".
            plural = "action"
        else:
            # //audit assumption: non-singular count; risk: grammar mismatch; invariant: plural noun; strategy: use "actions".
            plural = "actions"
        response_text = f"Queued {queued_count} {plural}."

        return _ConversationResult(
            response_text=response_text,
            tokens_used=0,
            cost_usd=0.0,
            model=Config.BACKEND_CHAT_MODEL or "backend",
            source="backend"
        )

    def _handle_confirmation_required(
        self,
        error: BackendRequestError
    ) -> Optional[_ConversationResult]:
        """
        Purpose: Prompt the user (or auto-confirm) for sensitive backend actions.
        Inputs/Outputs: BackendRequestError with confirmation payload; returns ConversationResult or None.
        Edge cases: Non-TTY input or missing confirmation fields rejects the action.
        """
        confirmation_id = error.confirmation_challenge_id
        pending_actions = error.pending_actions

        if not confirmation_id or not isinstance(pending_actions, list):
            # //audit assumption: confirmation fields required; risk: invalid state; invariant: return None; strategy: abort.
            return None

        if Config.CONFIRM_SENSITIVE_ACTIONS:
            # //audit assumption: confirmation enabled; risk: blocking in non-tty; invariant: prompt user; strategy: check TTY.
            if not sys.stdin.isatty():
                # //audit assumption: no TTY prevents prompt; risk: unintended execution; invariant: reject; strategy: return None.
                self.console.print("[red]Action rejected.[/red]")
                return None

            self.console.print("[yellow]ARCANOS: The following action needs your confirmation:[/yellow]")
            for action in pending_actions:
                summary = None
                if isinstance(action, Mapping):
                    # //audit assumption: pending action is mapping; risk: missing summary; invariant: attempt summary; strategy: read field.
                    summary = action.get("summary")
                if not isinstance(summary, str) or not summary:
                    # //audit assumption: summary missing; risk: unclear prompt; invariant: fallback to raw; strategy: stringify.
                    summary = str(action)
                self.console.print(f"  [dim]{summary}[/dim]")

            response = self.console.input("Confirm? [y/N]: ").strip().lower()
            if response not in ("y", "yes"):
                # //audit assumption: non-yes is rejection; risk: missed confirmation; invariant: reject; strategy: return None.
                self.console.print("[red]Action rejected.[/red]")
                return None
        else:
            # //audit assumption: confirmation disabled; risk: auto-execution; invariant: auto-confirm; strategy: proceed.
            pass

        return self._confirm_pending_actions(confirmation_id)

    def _start_daemon_threads(self) -> None:
        """Start background heartbeat and command polling threads when backend is configured."""
        if self._daemon_running or not self.backend_client:
            # //audit assumption: backend client required; risk: duplicate threads; invariant: start once; strategy: guard on running flag and client.
            return

        self._daemon_running = True
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            daemon=True,
            name="daemon-heartbeat"
        )
        self._heartbeat_thread.start()

        self._command_poll_thread = threading.Thread(
            target=self._command_poll_loop,
            daemon=True,
            name="daemon-command-poll"
        )
        self._command_poll_thread.start()
        self.console.print(f"[green]✓[/green] Daemon service started (HTTP mode)")

    def _heartbeat_loop(self) -> None:
        """Background thread that sends periodic heartbeats."""
        while self._daemon_running and self.backend_client:
            try:
                uptime = time.time() - self.start_time
                payload = {
                    "clientId": self.client_id,
                    "instanceId": self.instance_id,
                    "version": Config.VERSION,
                    "uptime": uptime,
                    "routingMode": "http",
                    "stats": {}
                }
                response = self.backend_client._make_request(
                    "POST",
                    "/api/daemon/heartbeat",
                    json=payload
                )

                if response.status_code != 200:
                    # //audit assumption: heartbeat should succeed; risk: backend issues; invariant: continue loop; strategy: log debug and continue.
                    error_logger.debug("Daemon heartbeat failed: %s", response.status_code)

            except BackendRequestError as exc:
                # //audit assumption: network errors are recoverable; risk: noisy logs; invariant: loop continues; strategy: log debug and sleep.
                error_logger.debug("Daemon heartbeat request error: %s", exc)
            except Exception as exc:
                # //audit assumption: unexpected error should not crash thread; risk: silent failure; invariant: loop continues; strategy: log debug and continue.
                error_logger.debug("Daemon heartbeat error: %s", exc)

            time.sleep(self._heartbeat_interval)

    def _command_poll_loop(self) -> None:
        """Background thread that polls the backend for daemon commands."""
        while self._daemon_running and self.backend_client:
            try:
                response = self.backend_client._make_request(
                    "GET",
                    f"/api/daemon/commands?instance_id={self.instance_id}"
                )

                if response.status_code == 200:
                    data = response.json()
                    commands = data.get("commands", []) if isinstance(data, Mapping) else []

                    if commands:
                        command_ids = []
                        for cmd_data in commands:
                            try:
                                command = DaemonCommand(
                                    id=cmd_data["id"],
                                    name=cmd_data["name"],
                                    payload=cmd_data["payload"],
                                    issuedAt=cmd_data["issuedAt"],
                                )
                                self._handle_daemon_command(command)
                                command_ids.append(command.id)
                            except Exception as exc:
                                # //audit assumption: bad command payload should not stop polling; risk: lost command; invariant: continue; strategy: log debug.
                                error_logger.debug("Daemon command handling error: %s", exc)

                        if command_ids:
                            try:
                                ack_response = self.backend_client._make_request(
                                    "POST",
                                    "/api/daemon/commands/ack",
                                    json={
                                        "commandIds": command_ids,
                                        "instanceId": self.instance_id,
                                    },
                                )
                                if ack_response.status_code != 200:
                                    # //audit assumption: ack should succeed; risk: command re-delivery; invariant: continue; strategy: log debug.
                                    error_logger.debug("Daemon command ack failed: %s", ack_response.status_code)
                            except Exception as exc:
                                error_logger.debug("Daemon command ack error: %s", exc)

                elif response.status_code == 401:
                    # //audit assumption: auth failure means stop polling; risk: stale token; invariant: exit loop; strategy: stop daemon threads.
                    error_logger.debug("Daemon command poll auth failed; stopping command poll loop.")
                    self._daemon_running = False
                    break
                else:
                    # //audit assumption: other HTTP errors are transient; risk: missed commands; invariant: continue polling; strategy: log debug.
                    error_logger.debug("Daemon command poll failed: %s", response.status_code)

            except BackendRequestError as exc:
                error_logger.debug("Daemon command poll request error: %s", exc)
            except Exception as exc:
                error_logger.debug("Daemon command poll error: %s", exc)

            time.sleep(self._command_poll_interval)

    def _handle_daemon_command(self, command: DaemonCommand) -> None:
        """
        Handle daemon command from HTTP polling.
        Processes commands from the backend (ping, get_status, get_stats, notify).
        Note: DaemonService handles acknowledgment automatically.
        """
        command_name = command.name
        command_payload = command.payload or {}

        if command_name == "ping":
            # //audit assumption: ping should always succeed; risk: none; invariant: ok response; strategy: return pong payload.
            # Ping commands are handled silently (no response needed)
            pass

        elif command_name == "get_status":
            # //audit assumption: status can be shared; risk: information leakage; invariant: summary only; strategy: return minimal status.
            # Status is included in heartbeat, no action needed here
            pass

        elif command_name == "get_stats":
            # //audit assumption: stats can be shared; risk: sensitive data leakage; invariant: summary only; strategy: return stats.
            # Stats are included in heartbeat, no action needed here
            pass

        elif command_name == "run":
            # //audit assumption: run commands require explicit payload; risk: unsafe execution; invariant: command string required; strategy: validate and run.
            command_text = command_payload.get("command") if isinstance(command_payload, dict) else None
            if isinstance(command_text, str) and command_text.strip():
                self.handle_run(command_text.strip())
            else:
                # //audit assumption: missing command is invalid; risk: no-op; invariant: warning shown; strategy: notify.
                self.console.print("[yellow]Run command missing 'command' payload[/yellow]")

        elif command_name == "see":
            # //audit assumption: see payload optional; risk: invalid payload; invariant: default to screen; strategy: parse use_camera flag.
            use_camera = False
            if isinstance(command_payload, dict):
                use_camera = bool(command_payload.get("use_camera", False))
            self.handle_see(["camera"] if use_camera else [])

        elif command_name == "notify":
            # //audit assumption: notify payload may include message; risk: invalid payload; invariant: string message; strategy: validate.
            message = command_payload.get("message") if isinstance(command_payload, dict) else None
            if message and isinstance(message, str):
                self.console.print(f"[cyan]Backend message:[/cyan] {message}")
            else:
                self.console.print("[yellow]Notify command missing message[/yellow]")

        else:
            # //audit assumption: unsupported commands should be logged; risk: unexpected behavior; invariant: error logged; strategy: warn.
            self.console.print(f"[yellow]Unsupported command: {command_name}[/yellow]")

    def _stop_daemon_threads(self) -> None:
        """Stop daemon heartbeat and command polling threads."""
        if not self._daemon_running:
            return

        self._daemon_running = False
        if self._heartbeat_thread:
            self._heartbeat_thread.join(timeout=5.0)
            self._heartbeat_thread = None
        if self._command_poll_thread:
            self._command_poll_thread.join(timeout=5.0)
            self._command_poll_thread = None

    def _perform_local_conversation(self, message: str) -> Optional[_ConversationResult]:
        history = self.memory.get_recent_conversations(limit=5)
        response, tokens, cost = self.gpt_client.ask(
            user_message=message,
            system_prompt=self.system_prompt,
            conversation_history=history
        )

        if not response:
            # //audit assumption: response required; risk: empty response; invariant: non-empty response; strategy: return None.
            return None

        return _ConversationResult(
            response_text=response,
            tokens_used=tokens,
            cost_usd=cost,
            model=Config.OPENAI_MODEL,
            source="local"
        )

    def _perform_backend_conversation(self, message: str, domain: Optional[str] = None) -> Optional[_ConversationResult]:
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: return None; strategy: warn and return None.
            self.console.print("[yellow]Backend is not configured.[/yellow]")
            return None

        self._last_confirmation_handled = False
        self._refresh_registry_cache_if_stale()

        # //audit assumption: history limit non-negative; risk: negative value; invariant: >=0; strategy: clamp to zero.
        history_limit = max(0, Config.BACKEND_HISTORY_LIMIT)
        # //audit assumption: history optional; risk: empty context; invariant: safe default; strategy: empty list when limit is zero.
        history = self.memory.get_recent_conversations(limit=history_limit) if history_limit else []
        messages = build_conversation_messages(
            system_prompt=self.system_prompt,
            conversation_history=history,
            user_message=message,
            max_history=history_limit
        )

        # Include daemon metadata
        metadata = {
            "source": "daemon",
            "client": self.client_id,
            "instanceId": self.instance_id
        }

        # Use /api/ask endpoint with domain hint for natural language routing
        # The backend dispatcher will route to modules based on domain
        if domain:
            # Call /api/ask with domain hint for module routing
            response = self._request_with_auth_retry(
                lambda: self.backend_client.request_ask_with_domain(
                    message=message,
                    domain=domain,
                    metadata=metadata
                ),
                "chat"
            )
        else:
            # Standard chat completion (no domain routing)
            response = self._request_with_auth_retry(
                lambda: self.backend_client.request_chat_completion(
                    messages=messages,
                    temperature=Config.TEMPERATURE,
                    model=Config.BACKEND_CHAT_MODEL or None,
                    metadata=metadata
                ),
                "chat"
            )

        if response.ok and response.value:
            # //audit assumption: backend response ok; risk: missing payload; invariant: response value present; strategy: return result.
            return _ConversationResult(
                response_text=response.value.response_text,
                tokens_used=response.value.tokens_used,
                cost_usd=response.value.cost_usd,
                model=response.value.model,
                source="backend"
            )

        if response.error and response.error.kind == "confirmation":
            # //audit assumption: backend requires confirmation; risk: bypassing prompt; invariant: confirmation handled; strategy: prompt or auto-confirm.
            self._last_confirmation_handled = True
            return self._handle_confirmation_required(response.error)

        # //audit assumption: backend response required; risk: backend failure; invariant: response ok; strategy: return None.
        return None

    def _encode_audio_base64(self, audio_data: bytes | bytearray) -> Optional[str]:
        try:
            audio_bytes = self.audio.extract_audio_bytes(audio_data)
        except RuntimeError as exc:
            # //audit assumption: audio bytes extraction can fail; risk: unsupported audio; invariant: error surfaced; strategy: print and return None.
            self.console.print(f"[red]Audio encoding failed: {exc}[/red]")
            return None

        # //audit assumption: base64 encoding is safe; risk: invalid bytes; invariant: ascii output; strategy: encode to base64.
        return base64.b64encode(audio_bytes).decode("ascii")

    def _perform_backend_transcription(self, audio_data: bytes | bytearray) -> Optional[str]:
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: return None; strategy: warn and return None.
            self.console.print("[yellow]Backend is not configured.[/yellow]")
            return None

        audio_base64 = self._encode_audio_base64(audio_data)
        if not audio_base64:
            # //audit assumption: base64 required; risk: missing audio; invariant: base64 available; strategy: return None.
            return None

        # Include daemon metadata
        metadata = {
            "source": "daemon",
            "client": self.client_id,
            "instanceId": self.instance_id
        }

        response = self._request_with_auth_retry(
            lambda: self.backend_client.request_transcription(
                audio_base64=audio_base64,
                filename="speech.wav",
                model=Config.BACKEND_TRANSCRIBE_MODEL or None,
                metadata=metadata
            ),
            "transcription"
        )

        if not response.ok or not response.value:
            # //audit assumption: backend response required; risk: backend failure; invariant: response ok; strategy: return None.
            return None

        return response.value.text

    def _perform_backend_vision(self, use_camera: bool) -> Optional[_ConversationResult]:
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: return None; strategy: warn and return None.
            self.console.print("[yellow]Backend is not configured.[/yellow]")
            return None

        # //audit assumption: camera flag controls capture mode; risk: wrong capture source; invariant: mode respected; strategy: branch on flag.
        if use_camera:
            image_base64 = self.vision.capture_camera(camera_index=0, save=True)
            default_prompt = "What do you see in this image? Describe it in detail."
            mode_label = "camera"
        else:
            image_base64 = self.vision.capture_screenshot(save=True)
            default_prompt = (
                "What do you see on this screen? Describe the key elements and what the user appears to be doing."
            )
            mode_label = "screen"

        if not image_base64:
            # //audit assumption: image capture required; risk: missing image; invariant: base64 available; strategy: return None.
            return None

        # Include daemon metadata
        metadata = {
            "source": "daemon",
            "client": self.client_id,
            "instanceId": self.instance_id
        }

        response = self._request_with_auth_retry(
            lambda: self.backend_client.request_vision_analysis(
                image_base64=image_base64,
                prompt=default_prompt,
                temperature=Config.TEMPERATURE,
                model=Config.BACKEND_VISION_MODEL or None,
                metadata=metadata,
                max_tokens=Config.MAX_TOKENS
            ),
            f"vision ({mode_label})"
        )

        if not response.ok or not response.value:
            # //audit assumption: backend response required; risk: backend failure; invariant: response ok; strategy: return None.
            return None

        return _ConversationResult(
            response_text=response.value.response_text,
            tokens_used=response.value.tokens_used,
            cost_usd=response.value.cost_usd,
            model=response.value.model,
            source="backend"
        )

    def _send_backend_update(self, update_type: str, data: Mapping[str, Any]) -> None:
        if not Config.BACKEND_SEND_UPDATES:
            # //audit assumption: updates can be disabled; risk: missing telemetry; invariant: skip when disabled; strategy: return.
            return
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: skip update; strategy: return.
            return

        # Include daemon metadata
        metadata = {
            "source": "daemon",
            "client": self.client_id,
            "instanceId": self.instance_id
        }

        # Use REST API for updates
        response = self._request_with_auth_retry(
            lambda: self.backend_client.submit_update_event(
                update_type=update_type,
                data=data,
                metadata=metadata
            ),
            "update"
        )
        if response.ok:
            # //audit assumption: update succeeded; risk: none; invariant: no action needed; strategy: return.
            return

    def _detect_domain_intent(self, message: str) -> Optional[str]:
        """
        Detect domain intent from user message for module routing.
        Returns domain hint (e.g., "backstage:booker") or None for general conversation.
        """
        message_lower = message.lower()

        # Simple keyword-based intent detection
        # Can be enhanced with AI-based classification later
        domain_keywords = {
            "backstage:booker": ["book", "booking", "match", "wrestling", "wwe", "aew", "wrestler", "storyline", "event"],
            "backstage": ["book", "booking", "match", "wrestling", "wwe", "aew"],
            "tutor": ["tutor", "teach", "learn", "lesson", "education", "study"],
            "arcanos:tutor": ["tutor", "teach", "learn", "lesson"],
            "gaming": ["game", "gaming", "play", "player"],
            "arcanos:gaming": ["game", "gaming"],
            "research": ["research", "study", "analyze", "investigate"]
        }

        for domain, keywords in domain_keywords.items():
            if any(keyword in message_lower for keyword in keywords):
                return domain

        return None

    def _truncate_for_tts(self, text: str, max_chars: int = 600) -> str:
        """
        Purpose: Trim text for TTS playback to avoid overly long responses.
        Inputs/Outputs: text and max_chars; returns a shortened string.
        Edge cases: Returns empty string for blank input; uses sentence boundary when possible.
        """
        normalized = (text or "").strip()
        if not normalized:
            # //audit assumption: empty text should not be spoken; risk: confusing output; invariant: empty string; strategy: return empty.
            return ""

        if len(normalized) <= max_chars:
            # //audit assumption: short text safe for TTS; risk: none; invariant: original text; strategy: return original.
            return normalized

        snippet = normalized[:max_chars]
        last_sentence = max(snippet.rfind("."), snippet.rfind("!"), snippet.rfind("?"))
        if last_sentence > 0:
            # //audit assumption: sentence boundary improves clarity; risk: mid-sentence cut; invariant: end at punctuation; strategy: trim to boundary.
            snippet = snippet[: last_sentence + 1].strip()
        else:
            # //audit assumption: no sentence boundary; risk: abrupt cut; invariant: trimmed length; strategy: keep max_chars slice.
            snippet = snippet.strip()

        if snippet.endswith("..."):
            return snippet
        return f"{snippet}..."

    def _detect_run_see_intent(self, text: str) -> Optional[Tuple[str, Optional[str]]]:
        """
        Purpose: Detect run/see intents from natural language input.
        Inputs/Outputs: raw text; returns ("run", command), ("see_screen", None), ("see_camera", None), or None.
        Edge cases: Returns None for empty or unsupported inputs.
        """
        normalized = (text or "").strip()
        if not normalized:
            # //audit assumption: empty input has no intent; risk: false positives; invariant: None; strategy: return None.
            return None

        run_patterns = [
            r"^\s*(run|execute)\s+(.+)$",
            r"^\s*(can you|could you|please)\s+run\s+(.+)$",
            r"^\s*(run|execute)\s+the\s+command\s+(.+)$"
        ]

        for pattern in run_patterns:
            match = re.search(pattern, normalized, re.IGNORECASE)
            if match:
                # //audit assumption: regex groups contain command; risk: missing command; invariant: command extracted; strategy: use last group.
                command = (match.groups()[-1] or "").strip()
                command = re.sub(r"\s+(for me|please)$", "", command, flags=re.IGNORECASE).strip()
                if command:
                    # //audit assumption: command is non-empty; risk: accidental empty run; invariant: return run intent; strategy: return tuple.
                    return ("run", command)

        camera_pattern = r"\b(see\s+(my\s+)?camera|look\s+at\s+(my\s+)?camera|webcam|take\s+a\s+(photo|picture))\b"
        if re.search(camera_pattern, normalized, re.IGNORECASE):
            # //audit assumption: camera keywords imply camera intent; risk: false match; invariant: camera route; strategy: return camera intent.
            return ("see_camera", None)

        screen_pattern = (
            r"\b(see\s+(my\s+)?screen|look\s+at\s+(my\s+)?screen|what('?s| is)\s+on\s+(my\s+)?screen|show\s+(me\s+)?my\s+screen|"
            r"screenshot|take\s+a\s+screenshot|capture\s+(my\s+)?screen|analyze\s+(my\s+)?screen)\b"
        )
        if re.search(screen_pattern, normalized, re.IGNORECASE):
            # //audit assumption: screen keywords imply screen intent; risk: false match; invariant: screen route; strategy: return screen intent.
            return ("see_screen", None)

        return None

    @handle_errors("processing user input")
    def handle_ask(
        self,
        message: str,
        route_override: Optional[str] = None,
        speak_response: bool = False,
        return_result: bool = False
    ) -> Optional[_ConversationResult]:
        """
        Purpose: Route and handle a conversation request locally or via backend.
        Inputs/Outputs: message text, optional route_override, speak_response flag; prints response and updates local state.
        Edge cases: Falls back to local when backend fails if configured.
        """
        display_response = not return_result

        # Check rate limits
        can_request, deny_reason = self.rate_limiter.can_make_request()
        if not can_request:
            # //audit assumption: rate limits enforced; risk: overuse; invariant: requests blocked; strategy: return with reason.
            if display_response:
                self.console.print(f"[red]Rate limit: {deny_reason}[/red]")
            return None

        route_decision = determine_conversation_route(
            user_message=message,
            routing_mode=Config.BACKEND_ROUTING_MODE,
            deep_prefixes=Config.BACKEND_DEEP_PREFIXES
        )
        if route_override in {"local", "backend"}:
            # //audit assumption: explicit override should win; risk: unexpected routing; invariant: override respected; strategy: replace decision.
            route_decision = ConversationRouteDecision(
                route=route_override,
                normalized_message=message.strip() or message,
                used_prefix=None
            )

        # //audit: when route would be backend, apply confidence threshold; if below, keep local so “simple” stays on daemon.
        if route_decision.route == "backend":
            conf = compute_backend_confidence(route_decision.normalized_message)
            if conf < Config.BACKEND_CONFIDENCE_THRESHOLD:
                route_decision = ConversationRouteDecision(
                    route="local",
                    normalized_message=route_decision.normalized_message,
                    used_prefix=None,
                )

        # Detect domain intent for natural language routing
        domain = self._detect_domain_intent(message) if route_decision.route == "backend" else None

        result: Optional[_ConversationResult] = None

        # Show thinking indicator
        status_context = self.console.status("Thinking...", spinner="dots") if display_response else nullcontext()
        with status_context:
            if route_decision.route == "backend":
                # //audit assumption: backend route requested; risk: backend unavailable; invariant: backend attempt; strategy: call backend.
                result = self._perform_backend_conversation(route_decision.normalized_message, domain=domain)
                if result is None and Config.BACKEND_FALLBACK_TO_LOCAL and not self._last_confirmation_handled:
                    # //audit assumption: fallback allowed when backend fails; risk: unwanted fallback on confirmation; invariant: skip when confirmation handled; strategy: gate on flag.
                    self.console.print("[yellow]Backend unavailable; falling back to local model.[/yellow]")
                    result = self._perform_local_conversation(route_decision.normalized_message)
            else:
                # //audit assumption: local route requested; risk: none; invariant: local model used; strategy: call local GPT.
                result = self._perform_local_conversation(route_decision.normalized_message)

        if not result:
            # //audit assumption: result required; risk: no response; invariant: message shown; strategy: return without updates.
            if display_response:
                self.console.print("[red]No response generated.[/red]")
            return None

        # Display response
        if display_response:
            self.console.print(f"\n[bold cyan]ARCANOS:[/bold cyan] {result.response_text}\n")
        self._last_response = result.response_text

        should_speak = (speak_response or Config.SPEAK_RESPONSES) and display_response
        if should_speak:
            # //audit assumption: TTS optional; risk: noisy output; invariant: speak only when enabled; strategy: gate on flag.
            truncated = self._truncate_for_tts(result.response_text)
            if truncated:
                # //audit assumption: truncated text may be empty; risk: silence; invariant: speak non-empty; strategy: guard.
                self.audio.speak(truncated, wait=True)

        # Record request locally
        self.rate_limiter.record_request(result.tokens_used, result.cost_usd)
        self.memory.add_conversation(route_decision.normalized_message, result.response_text, result.tokens_used, result.cost_usd)

        update_payload = {
            "eventId": str(uuid.uuid4()),
            "source": result.source,
            "tokens": result.tokens_used,
            "cost": result.cost_usd,
            "model": result.model,
            "messageLength": len(route_decision.normalized_message)
        }
        # //audit assumption: update payload is metadata-only; risk: leaking content; invariant: no raw text; strategy: send metrics only.
        self._send_backend_update("conversation_usage", update_payload)

        # Show stats
        if Config.SHOW_STATS and display_response:
            stats = self.rate_limiter.get_usage_stats()
            self.console.print(
                f"[dim]Tokens: {result.tokens_used} | Cost: ${result.cost_usd:.4f} | Total today: {stats['tokens_today']:,}[/dim]"
            )

        return result if return_result else None

    @handle_errors("vision analysis")
    def handle_see(self, args: list[str], return_result: bool = False) -> Optional[dict[str, Any]]:
        """
        Purpose: Handle vision commands for screen or camera input.
        Inputs/Outputs: args list; prints response and updates local stats.
        Edge cases: Returns early when vision is disabled or capture fails.
        """
        display_response = not return_result
        if not Config.VISION_ENABLED:
            # //audit assumption: vision can be disabled; risk: unsupported action; invariant: block when disabled; strategy: return.
            if display_response:
                self.console.print("[red]Vision is disabled in config.[/red]")
            return None

        # Check rate limits
        can_request, deny_reason = self.rate_limiter.can_make_request()
        if not can_request:
            # //audit assumption: rate limits enforced; risk: overuse; invariant: requests blocked; strategy: return with reason.
            if display_response:
                self.console.print(f"[red]Rate limit: {deny_reason}[/red]")
            return None

        route_decision = parse_vision_route_args(args, Config.BACKEND_VISION_ENABLED)
        result: Optional[_ConversationResult] = None

        if route_decision.use_backend:
            # //audit assumption: backend vision requested; risk: backend unavailable; invariant: backend attempt; strategy: call backend.
            result = self._perform_backend_vision(route_decision.use_camera)
            if result is None:
                if Config.BACKEND_FALLBACK_TO_LOCAL:
                    # //audit assumption: fallback allowed; risk: user expects backend; invariant: local fallback; strategy: retry locally.
                    if display_response:
                        self.console.print("[yellow]Backend unavailable; falling back to local vision.[/yellow]")
                else:
                    # //audit assumption: fallback disabled; risk: no vision response; invariant: backend required; strategy: return.
                    if display_response:
                        self.console.print("[red]Backend vision unavailable.[/red]")
                    return None

        if not result:
            # //audit assumption: local vision should run when backend absent; risk: missing response; invariant: local call; strategy: run local.
            if route_decision.use_camera:
                response, tokens, cost = self.vision.see_camera()
            else:
                response, tokens, cost = self.vision.see_screen()

            if response:
                result = _ConversationResult(
                    response_text=response,
                    tokens_used=tokens,
                    cost_usd=cost,
                    model=Config.OPENAI_VISION_MODEL,
                    source="local"
                )

        if not result:
            # //audit assumption: response required; risk: no response; invariant: message shown; strategy: return.
            if display_response:
                self.console.print("[red]No vision response generated.[/red]")
            return None

        if display_response:
            self.console.print(f"\n[bold cyan]ARCANOS:[/bold cyan] {result.response_text}\n")
        self._last_response = result.response_text

        if Config.SPEAK_RESPONSES and display_response:
            # //audit assumption: SPEAK_RESPONSES enables TTS; risk: noisy output; invariant: speak when enabled; strategy: gate on flag.
            truncated = self._truncate_for_tts(result.response_text)
            if truncated:
                # //audit assumption: truncated text may be empty; risk: silence; invariant: speak non-empty; strategy: guard.
                self.audio.speak(truncated, wait=True)
        self.rate_limiter.record_request(result.tokens_used, result.cost_usd)
        self.memory.increment_stat("vision_requests")

        update_payload = {
            "eventId": str(uuid.uuid4()),
            "source": result.source,
            "tokens": result.tokens_used,
            "cost": result.cost_usd,
            "model": result.model,
            "mode": "camera" if route_decision.use_camera else "screen"
        }
        # //audit assumption: update payload is metadata-only; risk: leaking content; invariant: no raw image; strategy: send metrics only.
        self._send_backend_update("vision_usage", update_payload)

        if Config.SHOW_STATS and display_response:
            self.console.print(f"[dim]Tokens: {result.tokens_used} | Cost: ${result.cost_usd:.4f}[/dim]")

        if return_result:
            return {
                "response_text": result.response_text,
                "tokens_used": result.tokens_used,
                "cost_usd": result.cost_usd,
                "model": result.model,
                "source": result.source,
            }
        return None

    @handle_errors("voice input")
    def handle_voice(self, args: list[str]) -> None:
        """
        Purpose: Capture voice input and transcribe locally or via backend.
        Inputs/Outputs: args list; prints transcription and forwards to conversation handler.
        Edge cases: Returns early when voice is disabled or transcription fails.
        """
        if not Config.VOICE_ENABLED:
            # //audit assumption: voice can be disabled; risk: unsupported action; invariant: block when disabled; strategy: return.
            self.console.print("[red]Voice is disabled in config.[/red]")
            return

        route_decision = parse_voice_route_args(args, Config.BACKEND_TRANSCRIBE_ENABLED)
        audio = self.audio.capture_microphone_audio(timeout=5, phrase_time_limit=10)
        if not audio:
            # //audit assumption: audio capture required; risk: missing audio; invariant: return None; strategy: return.
            self.console.print("[yellow]No speech detected.[/yellow]")
            return

        text: Optional[str] = None
        source = "local"
        model = Config.OPENAI_TRANSCRIBE_MODEL

        if route_decision.use_backend:
            # //audit assumption: backend transcription requested; risk: backend unavailable; invariant: backend attempt; strategy: call backend.
            text = self._perform_backend_transcription(audio)
            if text is None:
                if Config.BACKEND_FALLBACK_TO_LOCAL:
                    # //audit assumption: fallback allowed; risk: user expects backend; invariant: local fallback; strategy: retry locally.
                    self.console.print("[yellow]Backend unavailable; falling back to local transcription.[/yellow]")
                else:
                    # //audit assumption: fallback disabled; risk: no transcription; invariant: backend required; strategy: return.
                    self.console.print("[red]Backend transcription unavailable.[/red]")
                    return
            else:
                source = "backend"
                model = Config.BACKEND_TRANSCRIBE_MODEL or model

        if text is None:
            # //audit assumption: local transcription used as fallback; risk: local failure; invariant: best-effort; strategy: transcribe locally.
            text = self.audio.transcribe_audio(audio)

        if text:
            self.console.print(f"[green]You said:[/green] {text}\n")
            self.handle_ask(text, speak_response=True)
            self.memory.increment_stat("voice_requests")

            update_payload = {
                "eventId": str(uuid.uuid4()),
                "source": source,
                "model": model,
                "textLength": len(text)
            }
            # //audit assumption: update payload is metadata-only; risk: leaking content; invariant: no raw text; strategy: send metrics only.
            self._send_backend_update("transcription_usage", update_payload)
        else:
            self.console.print("[yellow]No speech detected.[/yellow]")

    @handle_errors("starting push-to-talk")
    def handle_ptt(self) -> None:
        """Start push-to-talk mode"""
        if not PTT_AVAILABLE:
            self.console.print("[red]❌ Push-to-talk not available (missing dependencies)[/red]")
            return

        if not self.ptt_manager:
            self.console.print("[red]❌ PTT manager not initialized[/red]")
            return

        self.console.print("[green]✨ Starting Push-to-Talk mode...[/green]")
        self.ptt_manager.start()

        # Wait for exit
        self.console.print("[dim]Press Ctrl+C to stop PTT mode[/dim]\n")
        try:
            while True:
                input()  # Keep running
        except KeyboardInterrupt:
            self.ptt_manager.stop()
            self.console.print("\n[yellow]⏹️  PTT mode stopped[/yellow]")

    def handle_ptt_speech(self, text: str, has_screenshot: bool) -> None:
        """
        Callback for PTT speech detection
        Args:
            text: Recognized speech text
            has_screenshot: Whether screenshot was requested
        """
        self.console.print(f"\n[green]🎤 You said:[/green] {text}")

        # Handle screenshot if requested
        if has_screenshot:
            self.console.print("[cyan]📸 Capturing screenshot...[/cyan]")
            img_base64 = self.vision.capture_screenshot(save=True)

            if img_base64:
                # Vision analysis with speech text as prompt
                response, tokens, cost = self.vision.analyze_image(img_base64, text)
                if response:
                    self.console.print(f"\n[bold cyan]ARCANOS:[/bold cyan] {response}\n")
                    self._last_response = response
                    self.rate_limiter.record_request(tokens, cost)
                    self.memory.increment_stat("vision_requests")
                    truncated = self._truncate_for_tts(response)
                    if truncated:
                        # //audit assumption: PTT expects spoken response; risk: noisy output; invariant: speak response; strategy: TTS when available.
                        self.audio.speak(truncated, wait=True)
        else:
            # Regular conversation
            self.handle_ask(text, speak_response=True)

    @handle_errors("executing terminal command")
    def handle_run(self, command: str, return_result: bool = False) -> Optional[dict[str, Any]]:
        """Execute terminal command"""
        display_response = not return_result
        if not command:
            if display_response:
                self.console.print("[red]❌ No command specified[/red]")
            return None

        if display_response:
            self.console.print(f"[cyan]💻 Running:[/cyan] {command}")

        # Execute command
        stdout, stderr, return_code = self.terminal.execute_powershell(
            command, elevated=Config.RUN_ELEVATED
        )

        # Display output
        if display_response and stdout:
            self.console.print(f"\n[green]{stdout}[/green]\n")
        if display_response and stderr:
            self.console.print(f"\n[red]{stderr}[/red]\n")

        if display_response:
            if return_code == 0:
                self.console.print(f"[dim]✅ Exit code: {return_code}[/dim]")
            else:
                self.console.print(f"[dim red]❌ Exit code: {return_code}[/dim red]")

        self.memory.increment_stat("terminal_commands")

        if return_result:
            return {
                "stdout": stdout,
                "stderr": stderr,
                "return_code": return_code,
            }
        return None

    @handle_errors("speaking response")
    def handle_speak(self) -> None:
        """
        Purpose: Replay the last response via TTS.
        Inputs/Outputs: None; speaks the last response if available.
        Edge cases: No prior response or TTS unavailable.
        """
        if not self._last_response:
            # //audit assumption: no response captured yet; risk: confusion; invariant: warning shown; strategy: notify user.
            self.console.print("[yellow]Nothing to speak yet.[/yellow]")
            return

        truncated = self._truncate_for_tts(self._last_response)
        if not truncated:
            # //audit assumption: empty truncated text should not be spoken; risk: silence; invariant: warning; strategy: notify user.
            self.console.print("[yellow]Nothing to speak yet.[/yellow]")
            return

        self.audio.speak(truncated, wait=True)

    def handle_stats(self) -> None:
        """Display usage statistics"""
        stats = self.memory.get_statistics()
        rate_stats = self.rate_limiter.get_usage_stats()

        table = Table(title="📊 ARCANOS Statistics")
        table.add_column("Metric", style="cyan")
        table.add_column("Value", style="green")

        table.add_row("Total Requests", f"{stats['total_requests']:,}")
        table.add_row("Total Tokens", f"{stats['total_tokens']:,}")
        table.add_row("Total Cost", f"${stats['total_cost']:.4f}")
        table.add_row("Vision Requests", f"{stats['vision_requests']:,}")
        table.add_row("Voice Requests", f"{stats['voice_requests']:,}")
        table.add_row("Terminal Commands", f"{stats['terminal_commands']:,}")
        table.add_row("", "")
        table.add_row("Requests This Hour", f"{rate_stats['requests_this_hour']}/{Config.MAX_REQUESTS_PER_HOUR}")
        table.add_row("Tokens Today", f"{rate_stats['tokens_today']:,}/{Config.MAX_TOKENS_PER_DAY:,}")
        table.add_row("Cost Today", f"${rate_stats['cost_today']:.4f}/${Config.MAX_COST_PER_DAY:.2f}")

        self.console.print(table)

    def handle_help(self) -> None:
        """Display help message"""
        help_text = """
# 📖 ARCANOS Commands

### Conversation
- Just type naturally to chat with ARCANOS
- **help** - Show this help message
- **exit** / **quit** - Exit ARCANOS
- **deep <prompt>** / **backend <prompt>** - Force backend routing
- **deep:** / **backend:** - Prefix for backend routing in hybrid mode

### Vision
- **see** - Analyze screenshot
- **see camera** - Analyze webcam image
- **see backend** - Analyze screenshot via backend
- **see camera backend** - Analyze webcam image via backend

### Voice
- **voice** - Use voice input (one-time)
- **voice backend** - Use backend transcription
- **ptt** - Start push-to-talk mode (hold SPACEBAR)
- **speak** - Replay the last response (TTS)

### Terminal
- **run <command>** - Execute PowerShell command
  Example: `run Get-Process`

### System
- **stats** - Show usage statistics
- **clear** - Clear conversation history
- **reset** - Reset statistics
- **update** - Check for updates and download installer (if GITHUB_RELEASES_REPO is set)

### Examples
```
You: hey arcanos, what's the weather like today?
You: see
You: run Get-Date
You: voice
You: ptt
```
        """

        self.console.print(Panel(
            Markdown(help_text),
            title="🌟 ARCANOS Help",
            border_style="cyan"
        ))

    def handle_clear(self) -> None:
        """Clear conversation history"""
        self.memory.clear_conversations()
        self.console.print("[green]✅ Conversation history cleared[/green]")

    def handle_reset(self) -> None:
        """Reset statistics"""
        confirm = input("Reset all statistics? (y/n): ").lower().strip()
        if confirm == 'y':
            self.memory.reset_statistics()
            self.console.print("[green]✅ Statistics reset[/green]")

    def handle_update(self) -> None:
        """Check for updates and optionally download and run ARCANOS-Setup.exe"""
        repo = Config.GITHUB_RELEASES_REPO or ""
        if not repo.strip():
            self.console.print("[yellow]Set GITHUB_RELEASES_REPO (owner/repo) to enable update checks.[/yellow]")
            return
        info = self._update_info or check_for_updates(Config.VERSION, repo)
        if not info:
            self.console.print("[green]You're up to date.[/green]")
            return
        url = info.get("download_url") or ""
        tag = info.get("tag", "latest")
        if not url:
            self.console.print("[red]No download URL in release.[/red]")
            return
        tmp = tempfile.gettempdir()
        safe = "".join(c if c.isalnum() or c in ".-_" else "-" for c in tag)
        path = os.path.join(tmp, f"ARCANOS-Setup-{safe}.exe")
        try:
            self.console.print(f"[cyan]Downloading {tag}...[/cyan]")
            with urllib.request.urlopen(url) as response, open(path, "wb") as out_file:
                out_file.write(response.read())
            if hasattr(os, "startfile"):
                os.startfile(path)
                self.console.print("[green]Installer started. Complete the setup to finish.[/green]")
            else:
                self.console.print(f"[green]Downloaded to: {path}[/green]")
        except Exception as e:
            self.console.print(f"[red]Download failed: {e}[/red]")

    def run(self) -> None:
        """Main CLI loop"""
        self.show_welcome()
        try:

            while True:
                try:
                    # Get user input
                    user_input = input("\n💬 You: ").strip()

                    if not user_input:
                        continue

                    # Parse command
                    parts = user_input.split(maxsplit=1)
                    command = parts[0].lower()
                    args = parts[1] if len(parts) > 1 else ""

                    # Handle commands
                    if command in ["exit", "quit", "bye"]:
                        self.console.print("[cyan]👋 Goodbye![/cyan]")
                        break
                    elif command == "help":
                        self.handle_help()
                    elif command in ["deep", "backend"]:
                        # //audit assumption: deep command signals backend routing; risk: missing prompt; invariant: args present; strategy: validate args.
                        if not args:
                            self.console.print("[red]No prompt provided for backend request.[/red]")
                        else:
                            self.handle_ask(args, route_override="backend")
                    elif command == "see":
                        self.handle_see(args.split())
                    elif command == "voice":
                        self.handle_voice(args.split())
                    elif command == "ptt":
                        self.handle_ptt()
                    elif command == "run":
                        self.handle_run(args)
                    elif command == "speak":
                        self.handle_speak()
                    elif command == "stats":
                        self.handle_stats()
                    elif command == "clear":
                        self.handle_clear()
                    elif command == "reset":
                        self.handle_reset()
                    elif command == "update":
                        self.handle_update()
                    else:
                        # Natural conversation
                        intent = self._detect_run_see_intent(user_input)
                        if intent:
                            # //audit assumption: detected intent should override chat; risk: misclassification; invariant: run/see handled; strategy: route to handlers.
                            intent_name, intent_payload = intent
                            if intent_name == "run" and intent_payload:
                                # //audit assumption: run intent has command; risk: empty command; invariant: command executed; strategy: call handle_run.
                                self.handle_run(intent_payload)
                            elif intent_name == "see_screen":
                                # //audit assumption: screen intent should capture screen; risk: wrong mode; invariant: screen capture; strategy: call handle_see.
                                self.handle_see([])
                            elif intent_name == "see_camera":
                                # //audit assumption: camera intent should capture camera; risk: wrong mode; invariant: camera capture; strategy: call handle_see with camera.
                                self.handle_see(["camera"])
                            else:
                                # //audit assumption: unknown intent should fallback to chat; risk: missed handling; invariant: chat path; strategy: call handle_ask.
                                self.handle_ask(user_input)
                        else:
                            self.handle_ask(user_input)

                except KeyboardInterrupt:
                    self.console.print("\n[cyan]👋 Goodbye![/cyan]")
                    break
                except Exception as e:
                    error_msg = ErrorHandler.handle_exception(e, "main loop")
                    self.console.print(f"[red]{error_msg}[/red]")


        finally:
            self._stop_daemon_threads()

def main() -> None:
    """Console entrypoint for ARCANOS."""
    # //audit assumption: bootstrap runs before CLI; risk: missing credentials; invariant: credentials ready; strategy: bootstrap then run.
    try:
        bootstrap_credentials()
    except CredentialBootstrapError as e:
        # //audit assumption: bootstrap can fail; risk: unusable CLI; invariant: error shown; strategy: exit with message.
        print(f"Credential setup failed: {e}")
        print(f"Crash reports are saved to: {Config.CRASH_REPORTS_DIR}")
        sys.exit(1)

    cli = ArcanosCLI()
    cli.run()


# //audit assumption: module used as entrypoint; risk: unexpected import side effects; invariant: main guard; strategy: only run on direct execution.
if __name__ == "__main__":
    main()

