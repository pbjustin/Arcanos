"""
ARCANOS CLI - Main Command Line Interface
Human-like AI assistant with rich terminal UI.
"""

import sys
import base64
import uuid
from dataclasses import dataclass
from typing import Callable, Optional, Any, Mapping
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.markdown import Markdown
from rich import print as rprint

from config import Config
from backend_client import BackendApiClient, BackendResponse, BackendRequestError
from conversation_routing import determine_conversation_route, build_conversation_messages, ConversationRouteDecision
from media_routing import parse_vision_route_args, parse_voice_route_args
from credential_bootstrap import CredentialBootstrapError, bootstrap_credentials
from schema import Memory
from gpt_client import GPTClient
from vision import VisionSystem
from audio import AudioSystem
from terminal import TerminalController
from rate_limiter import RateLimiter
from error_handler import handle_errors, ErrorHandler
from windows_integration import WindowsIntegration

try:
    from push_to_talk import AdvancedPushToTalkManager
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


class ArcanosCLI:
    """Main ARCANOS CLI application"""

    def __init__(self):
        # Initialize console
        self.console = Console()

        # Initialize components
        self.memory = Memory()
        self.rate_limiter = RateLimiter()

        try:
            self.gpt_client = GPTClient()
        except ValueError as e:
            self.console.print(f"[red]❌ {e}[/red]")
            self.console.print("\n[yellow]💡 Add your API key to daemon-python/.env[/yellow]")
            sys.exit(1)

        self.vision = VisionSystem(self.gpt_client)
        self.audio = AudioSystem(self.gpt_client)
        self.terminal = TerminalController()
        self.windows_integration = WindowsIntegration()

        self.backend_client: Optional[BackendApiClient] = None
        if Config.BACKEND_URL:
            # //audit assumption: backend URL configured; risk: misconfigured URL; invariant: client initialized; strategy: build client.
            self.backend_client = BackendApiClient(
                base_url=Config.BACKEND_URL,
                token_provider=lambda: Config.BACKEND_TOKEN,
                timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT
            )

        # PTT Manager
        self.ptt_manager = None
        if PTT_AVAILABLE:
            self.ptt_manager = AdvancedPushToTalkManager(
                self.audio,
                self.handle_ptt_speech
            )

        # System prompt for AI personality
        self.system_prompt = """You are ARCANOS, a helpful and friendly AI assistant with a warm personality.
You can see screens, hear voice, execute terminal commands, and have natural conversations.
Keep responses concise but friendly. Use emojis occasionally. Be helpful and proactive."""

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

        if not response.ok:
            # //audit assumption: response still failed; risk: backend unavailable; invariant: error reported; strategy: report.
            self._report_backend_error(action_label, response.error)

        return response

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

    def _perform_backend_conversation(self, message: str) -> Optional[_ConversationResult]:
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: return None; strategy: warn and return None.
            self.console.print("[yellow]Backend is not configured.[/yellow]")
            return None

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

        response = self._request_with_auth_retry(
            lambda: self.backend_client.request_chat_completion(
                messages=messages,
                temperature=Config.TEMPERATURE,
                model=Config.BACKEND_CHAT_MODEL or None
            ),
            "chat"
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

    def _encode_audio_base64(self, audio_data: Any) -> Optional[str]:
        try:
            audio_bytes = self.audio.extract_audio_bytes(audio_data)
        except RuntimeError as exc:
            # //audit assumption: audio bytes extraction can fail; risk: unsupported audio; invariant: error surfaced; strategy: print and return None.
            self.console.print(f"[red]Audio encoding failed: {exc}[/red]")
            return None

        # //audit assumption: base64 encoding is safe; risk: invalid bytes; invariant: ascii output; strategy: encode to base64.
        return base64.b64encode(audio_bytes).decode("ascii")

    def _perform_backend_transcription(self, audio_data: Any) -> Optional[str]:
        if not self.backend_client:
            # //audit assumption: backend client optional; risk: missing backend; invariant: return None; strategy: warn and return None.
            self.console.print("[yellow]Backend is not configured.[/yellow]")
            return None

        audio_base64 = self._encode_audio_base64(audio_data)
        if not audio_base64:
            # //audit assumption: base64 required; risk: missing audio; invariant: base64 available; strategy: return None.
            return None

        response = self._request_with_auth_retry(
            lambda: self.backend_client.request_transcription(
                audio_base64=audio_base64,
                filename="speech.wav",
                model=Config.BACKEND_TRANSCRIBE_MODEL or None
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

        response = self._request_with_auth_retry(
            lambda: self.backend_client.request_vision_analysis(
                image_base64=image_base64,
                prompt=default_prompt,
                temperature=Config.TEMPERATURE,
                model=Config.BACKEND_VISION_MODEL or None,
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

        response = self._request_with_auth_retry(
            lambda: self.backend_client.submit_update_event(update_type, data),
            "update"
        )
        if response.ok:
            # //audit assumption: update succeeded; risk: none; invariant: no action needed; strategy: return.
            return

    @handle_errors("processing user input")
    def handle_ask(self, message: str, route_override: Optional[str] = None) -> None:
        """
        Purpose: Route and handle a conversation request locally or via backend.
        Inputs/Outputs: message text, optional route_override; prints response and updates local state.
        Edge cases: Falls back to local when backend fails if configured.
        """
        # Check rate limits
        can_request, deny_reason = self.rate_limiter.can_make_request()
        if not can_request:
            # //audit assumption: rate limits enforced; risk: overuse; invariant: requests blocked; strategy: return with reason.
            self.console.print(f"[red]Rate limit: {deny_reason}[/red]")
            return

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

        result: Optional[_ConversationResult] = None

        # Show thinking indicator
        with self.console.status("Thinking...", spinner="dots"):
            if route_decision.route == "backend":
                # //audit assumption: backend route requested; risk: backend unavailable; invariant: backend attempt; strategy: call backend.
                result = self._perform_backend_conversation(route_decision.normalized_message)
                if result is None and Config.BACKEND_FALLBACK_TO_LOCAL:
                    # //audit assumption: fallback allowed; risk: user expects backend; invariant: local fallback; strategy: retry locally.
                    self.console.print("[yellow]Backend unavailable; falling back to local model.[/yellow]")
                    result = self._perform_local_conversation(route_decision.normalized_message)
            else:
                # //audit assumption: local route requested; risk: none; invariant: local model used; strategy: call local GPT.
                result = self._perform_local_conversation(route_decision.normalized_message)

        if not result:
            # //audit assumption: result required; risk: no response; invariant: message shown; strategy: return without updates.
            self.console.print("[red]No response generated.[/red]")
            return

        # Display response
        self.console.print(f"\n[bold cyan]ARCANOS:[/bold cyan] {result.response_text}\n")

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
        if Config.SHOW_STATS:
            stats = self.rate_limiter.get_usage_stats()
            self.console.print(
                f"[dim]Tokens: {result.tokens_used} | Cost: ${result.cost_usd:.4f} | Total today: {stats['tokens_today']:,}[/dim]"
            )

    @handle_errors("vision analysis")
    def handle_see(self, args: list[str]) -> None:
        """
        Purpose: Handle vision commands for screen or camera input.
        Inputs/Outputs: args list; prints response and updates local stats.
        Edge cases: Returns early when vision is disabled or capture fails.
        """
        if not Config.VISION_ENABLED:
            # //audit assumption: vision can be disabled; risk: unsupported action; invariant: block when disabled; strategy: return.
            self.console.print("[red]Vision is disabled in config.[/red]")
            return

        # Check rate limits
        can_request, deny_reason = self.rate_limiter.can_make_request()
        if not can_request:
            # //audit assumption: rate limits enforced; risk: overuse; invariant: requests blocked; strategy: return with reason.
            self.console.print(f"[red]Rate limit: {deny_reason}[/red]")
            return

        route_decision = parse_vision_route_args(args, Config.BACKEND_VISION_ENABLED)
        result: Optional[_ConversationResult] = None

        if route_decision.use_backend:
            # //audit assumption: backend vision requested; risk: backend unavailable; invariant: backend attempt; strategy: call backend.
            result = self._perform_backend_vision(route_decision.use_camera)
            if result is None:
                if Config.BACKEND_FALLBACK_TO_LOCAL:
                    # //audit assumption: fallback allowed; risk: user expects backend; invariant: local fallback; strategy: retry locally.
                    self.console.print("[yellow]Backend unavailable; falling back to local vision.[/yellow]")
                else:
                    # //audit assumption: fallback disabled; risk: no vision response; invariant: backend required; strategy: return.
                    self.console.print("[red]Backend vision unavailable.[/red]")
                    return

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
            self.console.print("[red]No vision response generated.[/red]")
            return

        self.console.print(f"\n[bold cyan]ARCANOS:[/bold cyan] {result.response_text}\n")
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

        if Config.SHOW_STATS:
            self.console.print(f"[dim]Tokens: {result.tokens_used} | Cost: ${result.cost_usd:.4f}[/dim]")

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
            self.handle_ask(text)
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
                    self.rate_limiter.record_request(tokens, cost)
                    self.memory.increment_stat("vision_requests")
        else:
            # Regular conversation
            self.handle_ask(text)

    @handle_errors("executing terminal command")
    def handle_run(self, command: str) -> None:
        """Execute terminal command"""
        if not command:
            self.console.print("[red]❌ No command specified[/red]")
            return

        self.console.print(f"[cyan]💻 Running:[/cyan] {command}")

        # Execute command
        stdout, stderr, return_code = self.terminal.execute_powershell(command)

        # Display output
        if stdout:
            self.console.print(f"\n[green]{stdout}[/green]\n")
        if stderr:
            self.console.print(f"\n[red]{stderr}[/red]\n")

        if return_code == 0:
            self.console.print(f"[dim]✅ Exit code: {return_code}[/dim]")
        else:
            self.console.print(f"[dim red]❌ Exit code: {return_code}[/dim red]")

        self.memory.increment_stat("terminal_commands")

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

### Terminal
- **run <command>** - Execute PowerShell command
  Example: `run Get-Process`

### System
- **stats** - Show usage statistics
- **clear** - Clear conversation history
- **reset** - Reset statistics

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

    def run(self) -> None:
        """Main CLI loop"""
        self.show_welcome()

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
                elif command == "stats":
                    self.handle_stats()
                elif command == "clear":
                    self.handle_clear()
                elif command == "reset":
                    self.handle_reset()
                else:
                    # Natural conversation
                    self.handle_ask(user_input)

            except KeyboardInterrupt:
                self.console.print("\n[cyan]👋 Goodbye![/cyan]")
                break
            except Exception as e:
                error_msg = ErrorHandler.handle_exception(e, "main loop")
                self.console.print(f"[red]{error_msg}[/red]")


# //audit assumption: module used as entrypoint; risk: unexpected import side effects; invariant: main guard; strategy: only run on direct execution.
if __name__ == "__main__":
    # //audit assumption: bootstrap runs before CLI; risk: missing credentials; invariant: credentials ready; strategy: bootstrap then run.
    try:
        bootstrap_credentials()
    except CredentialBootstrapError as e:
        # //audit assumption: bootstrap can fail; risk: unusable CLI; invariant: error shown; strategy: exit with message.
        print(f"Credential setup failed: {e}")
        sys.exit(1)

    cli = ArcanosCLI()
    cli.run()
