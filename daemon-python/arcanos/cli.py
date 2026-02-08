"""
ARCANOS CLI - Main Command Line Interface
Human-like AI assistant with rich terminal UI.
"""

import json
import sys
import threading
import base64
import time
import uuid
from dataclasses import dataclass, asdict
from typing import Callable, Optional, Any, Mapping

# Fix Windows console encoding for emoji/Unicode support
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

from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown
from collections import deque

from .config import Config, validate_required_config
from .cli_types import DaemonCommand
from .backend_client import BackendApiClient, BackendResponse, BackendRequestError
from .cli_config import (
    DEFAULT_ACTIVITY_HISTORY_LIMIT,
    DEFAULT_DEBUG_SERVER_PORT,
    DEFAULT_CAMERA_VISION_PROMPT,
    DEFAULT_QUEUED_ACTIONS_COUNT,
    DEFAULT_SCREEN_VISION_PROMPT,
    DOMAIN_KEYWORDS,
    MIN_REGISTRY_CACHE_TTL_MINUTES,
    SINGLE_ACTION_COUNT,
    ZERO_COST_USD,
    ZERO_TOKENS_USED,
)
from .cli_intents import detect_domain_intent, truncate_for_tts
from .cli_ui import (
    build_help_panel,
    build_stats_table,
    build_welcome_markdown,
    get_first_run_setup_header,
    get_telemetry_description_lines,
    get_telemetry_prompt,
    get_telemetry_section_header,
)
from .cli_debug_helpers import build_debug_marker, resolve_debug_port
from .cli_daemon import (
    start_daemon_threads,
    heartbeat_loop,
    command_poll_loop,
    handle_daemon_command,
    stop_daemon_service
)
from .cli_runner import run_debug_mode, run_interactive_mode
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
from .update_checker import check_for_updates
from .voice_boundary import Persona, apply_voice_boundary

try:
    from .push_to_talk import AdvancedPushToTalkManager
    PTT_AVAILABLE = True
except ImportError:
    PTT_AVAILABLE = False


@dataclass
class SessionContext:
    session_id: str
    conversation_goal: Optional[str] = None
    current_intent: Optional[str] = None
    intent_confidence: float = 0.0
    phase: str = "init"          # init | active | refining | review
    tone: str = "neutral"        # neutral | precise | creative | critical
    turn_count: int = 0
    short_term_summary: Optional[str] = None
    last_summary_turn: int = 0


def infer_phase(turn_count: int, intent_confidence: float) -> str:
    if turn_count < 2:
        return "init"
    if intent_confidence >= 0.55:
        return "refining"
    return "active"


def infer_tone(intent: Optional[str]) -> str:
    if not intent:
        return "neutral"
    # Analytical / fact-seeking domains
    if intent in {"research", "debug", "analysis", "review"}:
        return "precise"
    # Creative / open-ended domains
    if intent in {"design", "brainstorm", "gaming", "arcanos:gaming"}:
        return "creative"
    # Teaching / structured domains
    if intent in {"tutor", "arcanos:tutor"}:
        return "precise"
    return "neutral"


TONE_TO_PERSONA = {
    "neutral": Persona.CALM,
    "precise": Persona.FOCUSED,
    "creative": Persona.EXPLORATORY,
    "critical": Persona.DIRECT,
}


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


_UNSET_FILTER: object = object()


class ArcanosCLI:
    """Main ARCANOS CLI application."""

    def __init__(self):
        """
        Purpose: Initialize CLI services, backends, and background threads.
        Inputs/Outputs: None; prepares components and prints startup info.
        Edge cases: Exits process if required API credentials are missing.
        """
        # Initialize console
        self.console = Console()
        self.start_time = time.time()
        self._last_error: Optional[str] = None
        self._activity: deque = deque(maxlen=DEFAULT_ACTIVITY_HISTORY_LIMIT)
        self._activity_lock = threading.Lock()

        # Initialize components
        self.memory = Memory()
        self.rate_limiter = RateLimiter()

        # Generate or retrieve persistent instance ID
        self.instance_id = self._get_or_create_instance_id()
        self.client_id = "arcanos-cli"  # Client identifier for CLI application

        # Daemon thread management (integrated from daemon_service.py)
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._command_poll_thread: Optional[threading.Thread] = None
        self._daemon_running = False
        # Use Config class (adapter boundary pattern)
        self._heartbeat_interval = Config.DAEMON_HEARTBEAT_INTERVAL_SECONDS
        self._command_poll_interval = Config.DAEMON_COMMAND_POLL_INTERVAL_SECONDS

        try:
            self.gpt_client = GPTClient()
        except ValueError as e:
            self.console.print(f"[red]⚠️  Error: {e}[/red]")
            self.console.print(f"\n[yellow]💡 Add your API key to {Config.ENV_PATH}[/yellow]")
            sys.exit(1)

        self.vision = VisionSystem(self.gpt_client)
        self.audio = AudioSystem(self.gpt_client)
        self.terminal = TerminalController()
        self._last_response: Optional[str] = None
        self._voice_persona = Persona.CALM

        self.backend_client: Optional[BackendApiClient] = None
        if Config.BACKEND_URL:
            # //audit assumption: backend URL configured; risk: misconfigured URL; invariant: client initialized; strategy: build client.
            try:
                self.backend_client = BackendApiClient(
                    base_url=Config.BACKEND_URL,
                    token_provider=lambda: Config.BACKEND_TOKEN,
                    timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT
                )
            except Exception as e:
                raise

        self._registry_cache: Optional[dict[str, Any]] = None
        self._registry_cache_updated_at: Optional[float] = None
        self._registry_cache_warning_logged = False
        self._registry_cache_ttl_seconds = max(MIN_REGISTRY_CACHE_TTL_MINUTES, Config.REGISTRY_CACHE_TTL_MINUTES) * 60
        self._last_confirmation_handled = False

        if self.backend_client:
            # //audit assumption: backend registry fetch is best-effort; risk: startup delay; invariant: fallback prompt; strategy: attempt fetch.
            self._refresh_registry_cache()

        # Start daemon threads for HTTP-based heartbeat and command polling
        if Config.BACKEND_URL and self.backend_client:
            self._start_daemon_threads()
            self.console.print(f"[green]?[/green] Backend connection active (heartbeat + command polling)")

        # PTT Manager
        self.ptt_manager = None
        if PTT_AVAILABLE:
            self.ptt_manager = AdvancedPushToTalkManager(
                self.audio,
                self.handle_ptt_speech
            )

        # Session context for conversation tracking
        self.session = SessionContext(session_id=self.instance_id)

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

        # Start debug server if enabled
        debug_enabled = (
            Config.DEBUG_SERVER_ENABLED
            or Config.IDE_AGENT_DEBUG
            or (Config.DAEMON_DEBUG_PORT and Config.DAEMON_DEBUG_PORT > 0)
        )
        if debug_enabled:
            try:
                # Prefer new config, fallback to legacy
                port = resolve_debug_port(
                    Config.DEBUG_SERVER_PORT,
                    Config.DAEMON_DEBUG_PORT,
                    DEFAULT_DEBUG_SERVER_PORT,
                )
                # Late import to avoid loading when not in use
                from .debug_server import start_debug_server
                from arcanos.debug import get_debug_logger
                
                start_debug_server(self, port)
                logger = get_debug_logger()
                logger.info(
                    "Debug server started",
                    extra={
                        "port": port,
                        "metrics_enabled": Config.DEBUG_SERVER_METRICS_ENABLED,
                        "log_level": Config.DEBUG_SERVER_LOG_LEVEL,
                    },
                )
                # Use ASCII-safe marker on Windows when stdout encoding is not UTF-8 (avoids UnicodeEncodeError on cp1252)
                _enc = getattr(sys.stdout, "encoding", "") or ""
                _mark = build_debug_marker(_enc)
                self.console.print(f"[green]{_mark}[/green] IDE agent debug server on 127.0.0.1:{port}")
            except Exception as e:
                from arcanos.debug import get_debug_logger
                logger = get_debug_logger()
                logger.exception("Debug server startup failed", extra={"error": str(e)})
                self.console.print(f"[yellow]Debug server failed to start: {e}[/yellow]")

    def _append_activity(self, kind: str, detail: str):
        with self._activity_lock:
            self._activity.appendleft({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "kind": kind,
                "detail": detail
            })

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
        """
        Purpose: Apply the voice boundary and render safe markdown at a single output choke point.
        Inputs/Outputs: raw text + persona/user context + memory adapter -> rendered safe text or None.
        Edge cases: Returns None when boundary suppression is triggered.
        """
        # //audit assumption: prefiltered text is optional optimization; risk: double-decay on repeated filtering; invariant: single boundary decision; strategy: honor caller-provided filtered text.
        filtered = filtered_text
        if filtered is _UNSET_FILTER:
            filtered = apply_voice_boundary(
                raw_text,
                persona=persona,
                user_text=user_text,
                memory=memory,
                debug_voice=debug_voice,
            )
        # //audit assumption: empty/None response should remain silent; risk: leakage via fallback print; invariant: print only safe non-empty text; strategy: guard before render.
        if filtered:
            self.console.print()
            self.console.print(Markdown(filtered))
            self.console.print()
        return filtered

    def _get_or_create_instance_id(self) -> str:
        """Get or create persistent instance ID for this daemon installation"""
        instance_id = self.memory.get_setting("instance_id")
        if not instance_id:
            # Generate new UUID
            instance_id = str(uuid.uuid4())
            self.memory.set_setting("instance_id", instance_id)
            self.console.print(f"[green]?[/green] Generated daemon instance ID: {instance_id[:8]}...")
        return instance_id

    def _resolve_persona(self) -> Persona:
        return TONE_TO_PERSONA.get(self.session.tone, Persona.CALM)

    def _update_short_term_summary(self) -> None:
        if (
            self.session.turn_count - self.session.last_summary_turn < 4
            or self.session.phase == "init"
        ):
            return

        history = self.memory.get_recent_conversations(limit=6)
        if not history:
            return

        summary_prompt = (
            "Summarize the conversation so far in 1\u20132 sentences, focusing on:\n"
            "- the user's goal\n"
            "- what has already been decided\n"
            "- what remains to be done\n\n"
            "Do NOT include implementation details or meta commentary."
        )

        summary, _, _ = self.gpt_client.ask(
            user_message=summary_prompt,
            system_prompt=self.system_prompt,
            conversation_history=history,
        )

        if summary:
            self.session.short_term_summary = summary.strip()
            self.session.last_summary_turn = self.session.turn_count

    def show_welcome(self) -> None:
        """
        Purpose: Display welcome message and first-run guidance.
        Inputs/Outputs: None; prints welcome panels and setup prompts.
        Edge cases: No-op when welcome is disabled in config.
        """
        if not Config.SHOW_WELCOME:
            return

        welcome_text = build_welcome_markdown(Config.VERSION)

        self.console.print(Panel(
            Markdown(welcome_text),
            title="ARCANOS",
            border_style="cyan"
        ))

        # First-run setup
        if self.memory.get_setting("first_run", True):
            self.first_run_setup()

    def first_run_setup(self) -> None:
        """
        Purpose: Guide users through first-run configuration prompts.
        Inputs/Outputs: None; updates stored settings based on consent.
        Edge cases: Skips telemetry prompt once consent is stored.
        """
        self.console.print(get_first_run_setup_header())

        # Telemetry consent
        if self.memory.get_setting("telemetry_consent") is None:
            self.console.print(get_telemetry_section_header())
            # //audit assumption: telemetry lines iterable; risk: missing lines; invariant: print each line; strategy: iterate.
            for line in get_telemetry_description_lines():
                self.console.print(line)

            consent = input(get_telemetry_prompt()).lower().strip()
            self.memory.set_setting("telemetry_consent", consent == 'y')

            if consent == 'y':
                Config.TELEMETRY_ENABLED = True
                ErrorHandler.initialize()
                self.console.print("[green]? Telemetry enabled[/green]")
            else:
                self.console.print("[green]? Telemetry disabled[/green]")

        self.memory.set_setting("first_run", False)

    def _report_backend_error(self, action_label: str, error: Optional[BackendRequestError]) -> None:
        """
        Purpose: Print a user-friendly backend error summary.
        Inputs/Outputs: action_label + optional error; prints error message.
        Edge cases: Falls back to generic message when error is missing.
        """
        if not error:
            # //audit assumption: error details may be missing; risk: silent failure; invariant: generic message; strategy: print fallback.
            self.console.print(f"[red]Backend {action_label} failed.[/red]")
            return

        details = f" ({error.details})" if error.details else ""
        status_info = f" [{error.status_code}]" if error.status_code else ""
        self.console.print(f"[red]Backend {action_label} failed{status_info}: {error.message}{details}[/red]")
        # //audit: network errors mean requests never reach the server; surface hint so user can fix BACKEND_URL or server.
        if error.kind == "network" or error.kind == "timeout":
            self.console.print("[yellow]Check BACKEND_URL and ensure the backend server is running and reachable.[/yellow]")

    def _refresh_backend_credentials(self) -> bool:
        """
        Purpose: Re-authenticate with the backend if credentials are stale.
        Inputs/Outputs: None; returns True on success, False otherwise.
        Edge cases: Returns False and prints error when refresh fails.
        """
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
        """
        Purpose: Execute a backend request with one auth-refresh retry.
        Inputs/Outputs: request_func + action_label; returns response.
        Edge cases: Returns auth/confirmation errors without retries beyond one.
        """
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

    def _get_backend_connection_status(self) -> str:
        """
        Purpose: One-line backend connection status for the system prompt so the model can answer "Am I connected?".
        Inputs/Outputs: None; returns a short status string.
        """
        if not self.backend_client:
            return "Current backend connection: not configured."
        if self._registry_cache_is_valid():
            return "Current backend connection: connected (registry available)."
        return "Current backend connection: unavailable (registry fetch failed or stale)."

    def _get_backend_block(self) -> str:
        """
        Purpose: Resolve the backend block for the system prompt.
        Inputs/Outputs: None; returns backend block string.
        Edge cases: Falls back to default block when registry is unavailable or invalid.
        """
        status_line = self._get_backend_connection_status()
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
                return f"{status_line}\n\n{registry_block}"

        # //audit assumption: fallback block needed; risk: stale registry; invariant: default block returned; strategy: return fallback.
        return f"{status_line}\n\n{DEFAULT_BACKEND_BLOCK}"

    def _build_system_prompt(self) -> str:
        """
        Purpose: Build the daemon system prompt with session context and backend block.
        Inputs/Outputs: None; returns system prompt string.
        Edge cases: Falls back to default backend block when registry is missing.
        """
        backend_block = self._get_backend_block()

        session_block = f"""
Conversation goal:
- {self.session.conversation_goal or "Exploratory"}

Conversation summary:
- {self.session.short_term_summary or "N/A"}

Current intent:
- {self.session.current_intent or "Exploring"} (confidence: {self.session.intent_confidence:.2f})

Conversation phase:
- {self.session.phase}

Tone:
- {self.session.tone}

Guidelines:
- Avoid repeating established context
- Ask clarifying questions only if necessary
- Do not mention internal systems unless explicitly asked
"""

        identity = (
            "You are ARCANOS, a conversational operating intelligence.\n"
            "You respond naturally, clearly, and concisely.\n"
        )

        return f"{identity}\n{backend_block}\n{session_block}"

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
        queued_count = DEFAULT_QUEUED_ACTIONS_COUNT
        if isinstance(queued_value, int):
            # //audit assumption: queued count numeric; risk: wrong type; invariant: int count; strategy: accept int value.
            queued_count = queued_value

        if queued_count == SINGLE_ACTION_COUNT:
            # //audit assumption: singular count; risk: grammar mismatch; invariant: singular noun; strategy: use "action".
            plural = "action"
        else:
            # //audit assumption: non-singular count; risk: grammar mismatch; invariant: plural noun; strategy: use "actions".
            plural = "actions"
        response_text = f"Queued {queued_count} {plural}."

        return _ConversationResult(
            response_text=response_text,
            tokens_used=ZERO_TOKENS_USED,
            cost_usd=ZERO_COST_USD,
            model=Config.BACKEND_CHAT_MODEL or "backend",
            source="backend"
        )

    def _handle_confirmation_required(
        self,
        error: BackendRequestError,
        from_debug: bool = False,
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
            error_logger.warning("Invalid confirmation payload received from backend.")
            return None

        if from_debug:
            error_logger.info("[DEBUG] Confirmation auto-rejected because request is from debug server.")
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
        return start_daemon_threads(self)

    def _heartbeat_loop(self) -> None:
        return heartbeat_loop(self)

    def _command_poll_loop(self) -> None:
        return command_poll_loop(self)

    def _handle_daemon_command(self, command: DaemonCommand) -> None:
        return handle_daemon_command(self, command)

    def _stop_daemon_service(self) -> None:
        return stop_daemon_service(self)

    def _perform_local_conversation(self, message: str) -> Optional[_ConversationResult]:
        """
        Purpose: Execute a local GPT conversation with recent history.
        Inputs/Outputs: message string; returns ConversationResult or None.
        Edge cases: Returns None when GPT client produces no response.
        """
        history = self.memory.get_recent_conversations(limit=5)
        response, tokens, cost = self.gpt_client.ask(
            user_message=message,
            system_prompt=self.system_prompt,
            conversation_history=history
        )

        if not response:
            return None

        return _ConversationResult(
            response_text=response,
            tokens_used=tokens,
            cost_usd=cost,
            model=Config.OPENAI_MODEL,
            source="local"
        )

    def _perform_local_conversation_streaming(self, message: str) -> Optional[_ConversationResult]:
        """
        Purpose: Execute a local GPT conversation with real-time streaming output.
        Inputs/Outputs: message string; streams to console and returns ConversationResult.
        Edge cases: Falls back to non-streaming on error.
        """
        history = self.memory.get_recent_conversations(limit=5)
        try:
            stream = self.gpt_client.ask_stream(
                user_message=message,
                system_prompt=self.system_prompt,
                conversation_history=history
            )

            collected_chunks: list[str] = []
            tokens_used = 0
            cost_usd = 0.0
            first_chunk = True
            # Show a brief thinking indicator while waiting for the first token
            self.console.print()
            self.console.print("[dim]Thinking...[/dim]", end="\r")
            for chunk in stream:
                if isinstance(chunk, str):
                    if first_chunk:
                        # Clear the thinking indicator
                        self.console.print(" " * 20, end="\r")
                        first_chunk = False
                    collected_chunks.append(chunk)
                    self.console.print(chunk, end="")
                else:
                    # Usage object from final stream chunk
                    tokens_used = chunk.total_tokens
                    input_t = chunk.prompt_tokens
                    output_t = chunk.completion_tokens
                    cost_usd = (input_t * 0.15 / 1_000_000) + (output_t * 0.60 / 1_000_000)
            self.console.print()  # final newline after stream completes
            self.console.print()  # blank line after response

            response_text = "".join(collected_chunks)
            if not response_text.strip():
                return None

            return _ConversationResult(
                response_text=response_text,
                tokens_used=tokens_used,
                cost_usd=cost_usd,
                model=Config.OPENAI_MODEL,
                source="local",
            )
        except Exception:
            return self._perform_local_conversation(message)

    def _perform_backend_conversation(self, message: str, domain: Optional[str] = None, from_debug: bool = False) -> Optional[_ConversationResult]:
        """
        Purpose: Execute backend conversation, including routing metadata.
        Inputs/Outputs: message string + optional domain; returns ConversationResult or None.
        Edge cases: Returns None when backend is unavailable or confirmation required.
        """
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
        metadata = self._build_backend_metadata()

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
            return self._handle_confirmation_required(response.error, from_debug=from_debug)

        # //audit assumption: backend response required; risk: backend failure; invariant: response ok; strategy: return None.
        return None

    def _encode_audio_base64(self, audio_data: bytes | bytearray) -> Optional[str]:
        """
        Purpose: Extract and base64-encode audio for backend transcription.
        Inputs/Outputs: audio bytes; returns base64 string or None.
        Edge cases: Returns None when audio extraction fails.
        """
        try:
            audio_bytes = self.audio.extract_audio_bytes(audio_data)
        except RuntimeError as exc:
            # //audit assumption: audio bytes extraction can fail; risk: unsupported audio; invariant: error surfaced; strategy: print and return None.
            self.console.print(f"[red]Audio encoding failed: {exc}[/red]")
            return None

        # //audit assumption: base64 encoding is safe; risk: invalid bytes; invariant: ascii output; strategy: encode to base64.
        return base64.b64encode(audio_bytes).decode("ascii")

    def _perform_backend_transcription(self, audio_data: bytes | bytearray) -> Optional[str]:
        """
        Purpose: Request backend transcription for audio payloads.
        Inputs/Outputs: audio bytes; returns transcription text or None.
        Edge cases: Returns None when backend is unavailable or fails.
        """
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: return None; strategy: warn and return None.
            self.console.print("[yellow]Backend is not configured.[/yellow]")
            return None

        audio_base64 = self._encode_audio_base64(audio_data)
        if not audio_base64:
            # //audit assumption: base64 required; risk: missing audio; invariant: base64 available; strategy: return None.
            return None

        # Include daemon metadata
        metadata = self._build_backend_metadata()

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
        """
        Purpose: Send a vision request to backend for camera or screen captures.
        Inputs/Outputs: use_camera flag; returns ConversationResult or None.
        Edge cases: Returns None when capture fails or backend errors.
        """
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: return None; strategy: warn and return None.
            self.console.print("[yellow]Backend is not configured.[/yellow]")
            return None

        # //audit assumption: camera flag controls capture mode; risk: wrong capture source; invariant: mode respected; strategy: branch on flag.
        if use_camera:
            image_base64 = self.vision.capture_camera(camera_index=0, save=True)
            default_prompt = DEFAULT_CAMERA_VISION_PROMPT
            mode_label = "camera"
        else:
            image_base64 = self.vision.capture_screenshot(save=True)
            default_prompt = DEFAULT_SCREEN_VISION_PROMPT
            mode_label = "screen"

        if not image_base64:
            # //audit assumption: image capture required; risk: missing image; invariant: base64 available; strategy: return None.
            return None

        # Include daemon metadata
        metadata = self._build_backend_metadata()

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

    def _build_backend_metadata(self) -> dict[str, str]:
        """
        Purpose: Build shared metadata for backend requests and update events.
        Inputs/Outputs: None; returns metadata dictionary.
        Edge cases: None.
        """
        return {
            "source": "daemon",
            "client": self.client_id,
            "instanceId": self.instance_id,
        }

    def _send_backend_update(self, update_type: str, data: Mapping[str, Any]) -> None:
        """
        Purpose: Send usage update events to the backend if enabled.
        Inputs/Outputs: update_type + payload data; no return value.
        Edge cases: No-op when backend updates are disabled or missing.
        """
        if not Config.BACKEND_SEND_UPDATES:
            # //audit assumption: updates can be disabled; risk: missing telemetry; invariant: skip when disabled; strategy: return.
            return
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: skip update; strategy: return.
            return

        # Include daemon metadata
        metadata = self._build_backend_metadata()

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
        Inputs/Outputs: message text, optional route_override, speak_response flag; prints response and updates local state.
        Edge cases: Falls back to local when backend fails if configured.
        """
        self._append_activity("ask", message)
        # Check rate limits
        can_request, deny_reason = self.rate_limiter.can_make_request()
        if not can_request:
            # //audit assumption: rate limits enforced; risk: overuse; invariant: requests blocked; strategy: return with reason.
            self.console.print(f"[red]Rate limit: {deny_reason}[/red]")
            return None if return_result else None

        # ---- Session update (pre-routing) ----
        self.session.turn_count += 1

        detected_intent = detect_domain_intent(message, DOMAIN_KEYWORDS)
        if detected_intent:
            self.session.current_intent = detected_intent
            self.session.intent_confidence = min(1.0, self.session.intent_confidence + 0.3)
        else:
            self.session.intent_confidence *= 0.85

        self.session.phase = infer_phase(
            self.session.turn_count,
            self.session.intent_confidence
        )

        self.session.tone = infer_tone(self.session.current_intent)

        if (
            self.session.conversation_goal is None
            and self.session.turn_count >= 2
            and self.session.intent_confidence >= 0.4
        ):
            self.session.conversation_goal = self.session.current_intent

        # Rebuild system prompt with updated session context
        self.system_prompt = self._build_system_prompt()

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
        domain = detect_domain_intent(message, DOMAIN_KEYWORDS) if route_decision.route == "backend" else None

        result: Optional[_ConversationResult] = None

        # Use streaming for local conversations when enabled (feels like ChatGPT typing)
        use_streaming = Config.STREAM_RESPONSES and route_decision.route == "local" and not return_result

        if use_streaming:
            result = self._perform_local_conversation_streaming(route_decision.normalized_message)
        else:
            # Show thinking indicator for non-streaming requests
            with self.console.status("[dim]Thinking...[/dim]", spinner="dots"):
                if route_decision.route == "backend":
                    result = self._perform_backend_conversation(route_decision.normalized_message, domain=domain, from_debug=from_debug)
                    if result is None and Config.BACKEND_FALLBACK_TO_LOCAL and not self._last_confirmation_handled:
                        try:
                            import json as _json
                            _debug_log_path = Config.DEBUG_LOG_PATH
                            _debug_log_path.parent.mkdir(parents=True, exist_ok=True)
                            with _debug_log_path.open("a", encoding="utf-8") as _lf:
                                _lf.write(_json.dumps({"kind": "suspicious", "location": "cli.py:handle_ask:fallback", "message": "Backend unavailable; falling back to local", "data": {"message_length": len(route_decision.normalized_message)}, "timestamp": int(time.time() * 1000), "sessionId": "debug-session", "hypothesisId": "FALLBACK"}) + "\n")
                        except (OSError, IOError) as _e:
                            error_logger.debug("Debug log write failed: %s", _e)
                        self.console.print("[yellow]Backend unavailable; falling back to local model.[/yellow]")
                        result = self._perform_local_conversation(route_decision.normalized_message)
                else:
                    result = self._perform_local_conversation(route_decision.normalized_message)

        if not result:
            # //audit assumption: result required; risk: no response; invariant: message shown; strategy: return without updates.
            if not return_result:
                self.console.print("[red]No response generated.[/red]")
            return None

        response_for_user: Optional[str] = None
        if not return_result:
            from .cli_midlayer import translate

            translated, show = translate(
                message,
                result.response_text,
                source=result.source,
                debug=from_debug,
            )
            if show and translated:
                # Apply voice-boundary filtering before rendering or storing
                persona = self._resolve_persona()
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
                    # Non-streamed: render the translated (and sanitized) response with Markdown
                    self.console.print()
                    self.console.print(Markdown(sanitized))
                    self.console.print()

        update_payload = {
            "eventId": str(uuid.uuid4()),
            "source": result.source,
            "tokens": result.tokens_used,
            "cost": result.cost_usd,
            "model": result.model,
            "messageLength": len(route_decision.normalized_message)
        }

        # Record request and update state after voice-boundary filtering so memory never stores suppressed internals.
        self.rate_limiter.record_request(result.tokens_used, result.cost_usd)
        conversation_response = result.response_text if return_result else (response_for_user or "")
        self.memory.add_conversation(
            route_decision.normalized_message,
            conversation_response,
            result.tokens_used,
            result.cost_usd,
        )
        if not return_result:
            self._last_response = response_for_user

        self._send_backend_update("conversation_usage", update_payload)

        # ---- Post-response summarization ----
        self._update_short_term_summary()

        if return_result:
            return result

        should_speak = speak_response or Config.SPEAK_RESPONSES
        if should_speak:
            # //audit assumption: TTS optional; risk: noisy output; invariant: speak only when enabled; strategy: gate on flag.
            truncated = truncate_for_tts(response_for_user or "")
            if truncated:
                # //audit assumption: truncated text may be empty; risk: silence; invariant: speak non-empty; strategy: guard.
                self.audio.speak(truncated, wait=True)

        # Show stats
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
        """
        Purpose: Handle vision commands for screen or camera input.
        Inputs/Outputs: args list; prints response and updates local stats.
        Edge cases: Returns early when vision is disabled or capture fails.
        """
        self._append_activity("see", "camera" if "camera" in args else "screen")
        if not Config.VISION_ENABLED:
            if not return_result:
                self.console.print("[red]Vision is disabled in config.[/red]")
            return {"ok": False, "error": "Vision is disabled in config"} if return_result else None

        # Check rate limits
        can_request, deny_reason = self.rate_limiter.can_make_request()
        if not can_request:
            if not return_result:
                self.console.print(f"[red]Rate limit: {deny_reason}[/red]")
            return {"ok": False, "error": f"Rate limit: {deny_reason}"} if return_result else None

        route_decision = parse_vision_route_args(args, Config.BACKEND_VISION_ENABLED)
        result: Optional[_ConversationResult] = None

        if route_decision.use_backend:
            result = self._perform_backend_vision(route_decision.use_camera)
            if result is None:
                if Config.BACKEND_FALLBACK_TO_LOCAL:
                    if not return_result:
                        self.console.print("[yellow]Backend unavailable; falling back to local vision.[/yellow]")
                else:
                    if not return_result:
                        self.console.print("[red]Backend vision unavailable.[/red]")
                    return {"ok": False, "error": "Backend vision unavailable."} if return_result else None

        if not result:
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
            if not return_result:
                self.console.print("[red]No vision response generated.[/red]")
            return {"ok": False, "error": "No vision response generated."} if return_result else None

        response_for_user: Optional[str] = None
        if not return_result:
            # //audit assumption: vision output is user-facing text; risk: diagnostic leakage from backend/local vision; invariant: boundary-filtered before render; strategy: apply VBL then speak_to_user.
            response_for_user = apply_voice_boundary(
                result.response_text,
                persona=self._voice_persona,
                user_text=" ".join(args),
                memory=self.memory,
                debug_voice=False,
            )
            self.speak_to_user(
                result.response_text,
                persona=self._voice_persona,
                user_text=" ".join(args),
                memory=self.memory,
                debug_voice=False,
                filtered_text=response_for_user,
            )

        self.rate_limiter.record_request(result.tokens_used, result.cost_usd)
        self.memory.increment_stat("vision_requests")
        self._last_response = response_for_user if not return_result else self._last_response
        
        update_payload = {
            "eventId": str(uuid.uuid4()),
            "source": result.source,
            "tokens": result.tokens_used,
            "cost": result.cost_usd,
            "model": result.model,
            "mode": "camera" if route_decision.use_camera else "screen"
        }
        self._send_backend_update("vision_usage", update_payload)

        if return_result:
            return {"ok": True, **asdict(result)}

        if Config.SPEAK_RESPONSES:
            truncated = truncate_for_tts(response_for_user or "")
            if truncated:
                self.audio.speak(truncated, wait=True)

        if Config.SHOW_STATS:
            self.console.print(f"[dim]Tokens: {result.tokens_used} | Cost: ${result.cost_usd:.4f}[/dim]")

        return None

    @handle_errors("voice input")
    def handle_voice(self, args: list[str]) -> None:
        """
        Purpose: Capture voice input and transcribe locally or via backend.
        Inputs/Outputs: args list; prints transcription and forwards to conversation handler.
        Edge cases: Returns early when voice is disabled or transcription fails.
        """
        self._append_activity("voice", "mic capture")
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
        """
        Purpose: Start push-to-talk mode for voice capture.
        Inputs/Outputs: None; blocks until user stops mode.
        Edge cases: Returns early when dependencies are missing.
        """
        if not PTT_AVAILABLE:
            self.console.print("[red]? Push-to-talk not available (missing dependencies)[/red]")
            return

        if not self.ptt_manager:
            self.console.print("[red]? PTT manager not initialized[/red]")
            return

        self.console.print("[green]? Starting Push-to-Talk mode...[/green]")
        self.ptt_manager.start()

        # Wait for exit
        self.console.print("[dim]Press Ctrl+C to stop PTT mode[/dim]\n")
        try:
            while True:
                input()  # Keep running
        except KeyboardInterrupt:
            self.ptt_manager.stop()
            self.console.print("\n[yellow]??  PTT mode stopped[/yellow]")

    def handle_ptt_speech(self, text: str, has_screenshot: bool) -> None:
        """
        Purpose: Process recognized speech from PTT, with optional screenshot.
        Inputs/Outputs: speech text + screenshot flag; prints and responds.
        Edge cases: Skips vision analysis when screenshot capture fails.
        """
        self.console.print(f"\n[green]?? You said:[/green] {text}")

        # Handle screenshot if requested
        if has_screenshot:
            self.console.print("[cyan]?? Capturing screenshot...[/cyan]")
            img_base64 = self.vision.capture_screenshot(save=True)

            if img_base64:
                # Vision analysis with speech text as prompt
                response, tokens, cost = self.vision.analyze_image(img_base64, text)
                if response:
                    response_for_user = apply_voice_boundary(
                        response,
                        persona=self._voice_persona,
                        user_text=text,
                        memory=self.memory,
                        debug_voice=False,
                    )
                    self.speak_to_user(
                        response,
                        persona=self._voice_persona,
                        user_text=text,
                        memory=self.memory,
                        debug_voice=False,
                        filtered_text=response_for_user,
                    )
                    self._last_response = response_for_user
                    self.rate_limiter.record_request(tokens, cost)
                    self.memory.increment_stat("vision_requests")
                    truncated = truncate_for_tts(response_for_user or "")
                    if truncated:
                        # //audit assumption: PTT expects spoken response; risk: noisy output; invariant: speak response; strategy: TTS when available.
                        self.audio.speak(truncated, wait=True)
        else:
            # Regular conversation
            self.handle_ask(text, speak_response=True)

    @handle_errors("executing terminal command")
    def handle_run(self, command: str, return_result: bool = False) -> Optional[dict]:
        """
        Purpose: Execute a terminal command via the terminal controller.
        Inputs/Outputs: command string + return_result flag; prints output or returns dict.
        Edge cases: Returns error dict when command is empty.
        """
        self._append_activity("run", command)
        if not command:
            if not return_result:
                self.console.print("[red]⚠️  No command specified[/red]")
            return {"ok": False, "error": "No command specified"} if return_result else None

        if not return_result:
            self.console.print(f"[cyan]▶️  Running:[/cyan] {command}")

        # Execute command
        stdout, stderr, return_code = self.terminal.execute(
            command, elevated=Config.RUN_ELEVATED
        )

        self.memory.increment_stat("terminal_commands")

        if return_result:
            return {
                "ok": True,
                "stdout": stdout,
                "stderr": stderr,
                "return_code": return_code,
            }

        # Display output
        if stdout:
            self.console.print(f"\n[green]{stdout}[/green]\n")
        if stderr:
            self.console.print(f"\n[red]{stderr}[/red]\n")

        if return_code == 0:
            self.console.print(f"[dim]? Exit code: {return_code}[/dim]")
        else:
            self.console.print(f"[dim red]? Exit code: {return_code}[/dim red]")
        
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

        truncated = truncate_for_tts(self._last_response)
        if not truncated:
            # //audit assumption: empty truncated text should not be spoken; risk: silence; invariant: warning; strategy: notify user.
            self.console.print("[yellow]Nothing to speak yet.[/yellow]")
            return

        self.audio.speak(truncated, wait=True)

    def handle_stats(self) -> None:
        """
        Purpose: Display usage statistics for the current session.
        Inputs/Outputs: None; prints a stats table.
        Edge cases: None.
        """
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

    def handle_help(self) -> None:
        """
        Purpose: Display CLI help text.
        Inputs/Outputs: None; prints help panel.
        Edge cases: None.
        """
        self.console.print(build_help_panel())

    def handle_clear(self) -> None:
        """
        Purpose: Clear stored conversation history.
        Inputs/Outputs: None; clears memory and prints confirmation.
        Edge cases: None.
        """
        self.memory.clear_conversations()
        self.console.print("[green]? Conversation history cleared[/green]")

    def handle_reset(self) -> None:
        """
        Purpose: Reset stored usage statistics.
        Inputs/Outputs: None; prompts for confirmation before reset.
        Edge cases: No changes when user declines.
        """
        confirm = input("Reset all statistics? (y/n): ").lower().strip()
        if confirm == 'y':
            self.memory.reset_statistics()
            self.console.print("[green]? Statistics reset[/green]")

    def handle_update(self) -> None:
        """
        Purpose: Check for updates and show manual download info.
        Inputs/Outputs: None; prints update information.
        Edge cases: No-op when repo is not configured.
        """
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
        
        self.console.print(f"[cyan]Update available: {tag}[/cyan]")
        self.console.print(f"[yellow]Download URL: {url}[/yellow]")
        self.console.print("[yellow]Please download and install the update manually from the release page.[/yellow]")
        
        # Optionally open the release page in browser
        try:
            import webbrowser
            release_url = f"https://github.com/{repo}/releases/tag/{tag}"
            webbrowser.open(release_url)
            self.console.print(f"[green]Opened release page in browser: {release_url}[/green]")
        except Exception as e:
            self.console.print(f"[yellow]Could not open browser: {e}[/yellow]")

    def run(self, debug_mode: bool = False) -> None:
        """
        Purpose: Start the CLI loop in debug or interactive mode.
        Inputs/Outputs: debug_mode flag; runs until exit.
        Edge cases: None.
        """
        if debug_mode:
            run_debug_mode(self)
        else:
            run_interactive_mode(self)


def main() -> None:
    """
    Purpose: Console script entry point for ARCANOS CLI.
    Inputs/Outputs: None; runs the CLI loop and exits on fatal errors.
    Edge cases: Exits with status 1 when credential bootstrap fails.
    """
    # //audit assumption: bootstrap runs before CLI; risk: missing credentials; invariant: credentials ready; strategy: bootstrap then run.
    try:
        bootstrap_credentials()
    except CredentialBootstrapError as e:
        # //audit assumption: bootstrap can fail; risk: unusable CLI; invariant: error shown; strategy: exit with message.
        print(f"Credential setup failed: {e}")
        print(f"Crash reports are saved to: {Config.CRASH_REPORTS_DIR}")
        sys.exit(1)

    # Fail-fast validation after bootstrap (ensures all required config is valid)
    validate_required_config(exit_on_error=True)

    # //audit assumption: debug flag toggles mode; risk: unexpected behavior; invariant: boolean flag; strategy: parse argv.
    debug_mode = "--debug-mode" in sys.argv
    cli = ArcanosCLI()
    cli.run(debug_mode=debug_mode)


# //audit assumption: module used as entrypoint; risk: unexpected import side effects; invariant: main guard; strategy: only run on direct execution.
if __name__ == "__main__":
    main()
