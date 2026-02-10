"""
Local GPT/vision/audio operations and multimodal command handlers.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict
from typing import Optional, TYPE_CHECKING

from ..cli_intents import truncate_for_tts
from ..config import Config
from ..gpt_client import GPT4O_MINI_INPUT_COST, GPT4O_MINI_OUTPUT_COST
from ..media_routing import parse_vision_route_args, parse_voice_route_args
from ..voice_boundary import apply_voice_boundary
from . import backend_ops, ui_ops
from .context import ConversationResult

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def perform_local_conversation(cli: "ArcanosCLI", message: str) -> Optional[ConversationResult]:
    """
    Purpose: Execute a local GPT conversation using recent conversation history.
    Inputs/Outputs: message text; returns ConversationResult or None.
    Edge cases: Returns None when GPT client yields no response text.
    """
    history = cli.memory.get_recent_conversations(limit=5)
    response, tokens, cost = cli.gpt_client.ask(
        user_message=message,
        system_prompt=cli.system_prompt,
        conversation_history=history,
    )

    if not response:
        return None

    return ConversationResult(
        response_text=response,
        tokens_used=tokens,
        cost_usd=cost,
        model=Config.OPENAI_MODEL,
        source="local",
    )


def perform_local_conversation_streaming(cli: "ArcanosCLI", message: str) -> Optional[ConversationResult]:
    """
    Purpose: Execute a local GPT conversation with streaming console output.
    Inputs/Outputs: message text; streams response and returns ConversationResult.
    Edge cases: Falls back to non-streaming mode if stream errors.
    """
    history = cli.memory.get_recent_conversations(limit=5)
    try:
        stream = cli.gpt_client.ask_stream(
            user_message=message,
            system_prompt=cli.system_prompt,
            conversation_history=history,
        )

        collected_chunks: list[str] = []
        tokens_used = 0
        cost_usd = 0.0
        first_chunk = True
        cli.console.print()
        cli.console.print("[dim]Thinking...[/dim]", end="\r")
        for chunk in stream:
            if isinstance(chunk, str):
                if first_chunk:
                    cli.console.print(" " * 20, end="\r")
                    first_chunk = False
                collected_chunks.append(chunk)
                cli.console.print(chunk, end="")
            else:
                tokens_used = chunk.total_tokens
                input_t = chunk.prompt_tokens
                output_t = chunk.completion_tokens
                cost_usd = (input_t * GPT4O_MINI_INPUT_COST) + (output_t * GPT4O_MINI_OUTPUT_COST)
        cli.console.print()
        cli.console.print()

        response_text = "".join(collected_chunks)
        if not response_text.strip():
            return None

        return ConversationResult(
            response_text=response_text,
            tokens_used=tokens_used,
            cost_usd=cost_usd,
            model=Config.OPENAI_MODEL,
            source="local",
        )
    except Exception:
        return perform_local_conversation(cli, message)


def handle_see(cli: "ArcanosCLI", args: list[str], return_result: bool = False) -> Optional[dict]:
    """
    Purpose: Handle vision commands for screen/camera with backend fallback behavior.
    Inputs/Outputs: argument list and optional return_result flag; prints output or returns structured result.
    Edge cases: Returns error payload when vision is disabled/rate-limited/capture fails.
    """
    cli._append_activity("see", "camera" if "camera" in args else "screen")
    if not Config.VISION_ENABLED:
        if not return_result:
            cli.console.print("[red]Vision is disabled in config.[/red]")
        return {"ok": False, "error": "Vision is disabled in config"} if return_result else None

    can_request, deny_reason = cli.rate_limiter.can_make_request()
    if not can_request:
        if not return_result:
            cli.console.print(f"[red]Rate limit: {deny_reason}[/red]")
        return {"ok": False, "error": f"Rate limit: {deny_reason}"} if return_result else None

    route_decision = parse_vision_route_args(args, Config.BACKEND_VISION_ENABLED)
    result: Optional[ConversationResult] = None

    if route_decision.use_backend:
        result = backend_ops.perform_backend_vision(cli, route_decision.use_camera)
        if result is None:
            if Config.BACKEND_FALLBACK_TO_LOCAL:
                if not return_result:
                    cli.console.print("[yellow]Backend unavailable; falling back to local vision.[/yellow]")
            else:
                if not return_result:
                    cli.console.print("[red]Backend vision unavailable.[/red]")
                return {"ok": False, "error": "Backend vision unavailable."} if return_result else None

    if not result:
        if route_decision.use_camera:
            response, tokens, cost = cli.vision.see_camera()
        else:
            response, tokens, cost = cli.vision.see_screen()

        if response:
            result = ConversationResult(
                response_text=response,
                tokens_used=tokens,
                cost_usd=cost,
                model=Config.OPENAI_VISION_MODEL,
                source="local",
            )

    if not result:
        if not return_result:
            cli.console.print("[red]No vision response generated.[/red]")
        return {"ok": False, "error": "No vision response generated."} if return_result else None

    response_for_user: Optional[str] = None
    if not return_result:
        response_for_user = apply_voice_boundary(
            result.response_text,
            persona=cli._voice_persona,
            user_text=" ".join(args),
            memory=cli.memory,
            debug_voice=False,
        )
        ui_ops.speak_to_user(
            cli,
            result.response_text,
            persona=cli._voice_persona,
            user_text=" ".join(args),
            memory=cli.memory,
            debug_voice=False,
            filtered_text=response_for_user,
        )

    cli.rate_limiter.record_request(result.tokens_used, result.cost_usd)
    cli.memory.increment_stat("vision_requests")
    cli._last_response = response_for_user if not return_result else cli._last_response

    update_payload = {
        "eventId": str(uuid.uuid4()),
        "source": result.source,
        "tokens": result.tokens_used,
        "cost": result.cost_usd,
        "model": result.model,
        "mode": "camera" if route_decision.use_camera else "screen",
    }
    backend_ops.send_backend_update(cli, "vision_usage", update_payload)

    if return_result:
        return {"ok": True, **asdict(result)}

    if Config.SPEAK_RESPONSES:
        truncated = truncate_for_tts(response_for_user or "")
        if truncated:
            cli.audio.speak(truncated, wait=True)

    if Config.SHOW_STATS:
        cli.console.print(f"[dim]Tokens: {result.tokens_used} | Cost: ${result.cost_usd:.4f}[/dim]")

    return None


def handle_voice(cli: "ArcanosCLI", args: list[str]) -> None:
    """
    Purpose: Capture microphone input and transcribe via backend or local path.
    Inputs/Outputs: argument list; prints recognized text and dispatches to handle_ask.
    Edge cases: Returns early when voice disabled, no audio, or no transcription.
    """
    cli._append_activity("voice", "mic capture")
    if not Config.VOICE_ENABLED:
        # //audit assumption: voice feature can be disabled by config; risk: unsupported path execution; invariant: hard-stop when disabled; strategy: print and return.
        cli.console.print("[red]Voice is disabled in config.[/red]")
        return

    route_decision = parse_voice_route_args(args, Config.BACKEND_TRANSCRIBE_ENABLED)
    audio = cli.audio.capture_microphone_audio(timeout=5, phrase_time_limit=10)
    if not audio:
        cli.console.print("[yellow]No speech detected.[/yellow]")
        return

    text: Optional[str] = None
    source = "local"
    model = Config.OPENAI_TRANSCRIBE_MODEL

    if route_decision.use_backend:
        text = backend_ops.perform_backend_transcription(cli, audio)
        if text is None:
            if Config.BACKEND_FALLBACK_TO_LOCAL:
                cli.console.print("[yellow]Backend unavailable; falling back to local transcription.[/yellow]")
            else:
                cli.console.print("[red]Backend transcription unavailable.[/red]")
                return
        else:
            source = "backend"
            model = Config.BACKEND_TRANSCRIBE_MODEL or model

    if text is None:
        text = cli.audio.transcribe_audio(audio)

    if text:
        cli.console.print(f"[green]You said:[/green] {text}\n")
        cli.handle_ask(text, speak_response=True)
        cli.memory.increment_stat("voice_requests")

        update_payload = {
            "eventId": str(uuid.uuid4()),
            "source": source,
            "model": model,
            "textLength": len(text),
        }
        backend_ops.send_backend_update(cli, "transcription_usage", update_payload)
    else:
        cli.console.print("[yellow]No speech detected.[/yellow]")


def handle_ptt(cli: "ArcanosCLI") -> None:
    """
    Purpose: Start push-to-talk mode loop and block until user exits.
    Inputs/Outputs: CLI instance; runs capture loop until KeyboardInterrupt.
    Edge cases: Returns early when PTT dependencies/manager are unavailable.
    """
    if not cli._ptt_available:
        cli.console.print("[red]? Push-to-talk not available (missing dependencies)[/red]")
        return

    if not cli.ptt_manager:
        cli.console.print("[red]? PTT manager not initialized[/red]")
        return

    cli.console.print("[green]? Starting Push-to-Talk mode...[/green]")
    cli.ptt_manager.start()

    cli.console.print("[dim]Press Ctrl+C to stop PTT mode[/dim]\n")
    try:
        while True:
            input()
    except KeyboardInterrupt:
        cli.ptt_manager.stop()
        cli.console.print("\n[yellow]??  PTT mode stopped[/yellow]")


def handle_ptt_speech(cli: "ArcanosCLI", text: str, has_screenshot: bool) -> None:
    """
    Purpose: Process speech recognized in PTT mode with optional screenshot context.
    Inputs/Outputs: text and screenshot flag; prints and responds via chat/vision.
    Edge cases: Skips vision response flow when screenshot capture fails.
    """
    cli.console.print(f"\n[green]?? You said:[/green] {text}")

    if has_screenshot:
        cli.console.print("[cyan]?? Capturing screenshot...[/cyan]")
        img_base64 = cli.vision.capture_screenshot(save=True)

        if img_base64:
            response, tokens, cost = cli.vision.analyze_image(img_base64, text)
            if response:
                response_for_user = apply_voice_boundary(
                    response,
                    persona=cli._voice_persona,
                    user_text=text,
                    memory=cli.memory,
                    debug_voice=False,
                )
                ui_ops.speak_to_user(
                    cli,
                    response,
                    persona=cli._voice_persona,
                    user_text=text,
                    memory=cli.memory,
                    debug_voice=False,
                    filtered_text=response_for_user,
                )
                cli._last_response = response_for_user
                cli.rate_limiter.record_request(tokens, cost)
                cli.memory.increment_stat("vision_requests")
                truncated = truncate_for_tts(response_for_user or "")
                if truncated:
                    cli.audio.speak(truncated, wait=True)
    else:
        cli.handle_ask(text, speak_response=True)


__all__ = [
    "handle_ptt",
    "handle_ptt_speech",
    "handle_see",
    "handle_voice",
    "perform_local_conversation",
    "perform_local_conversation_streaming",
]
