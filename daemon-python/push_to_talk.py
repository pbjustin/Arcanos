"""
Advanced Push-to-Talk System for ARCANOS
Multi-hotkey support with VAD auto-stop and system tray indicator.
"""

import threading
import time
import speech_recognition as sr
from typing import Optional, Callable
from pynput import keyboard
from audio import AudioSystem
from error_handler import handle_errors

try:
    from vad_processor import VADProcessor
    VAD_AVAILABLE = True
except ImportError:
    VAD_AVAILABLE = False

try:
    from ptt_indicator import PTTIndicator
    INDICATOR_AVAILABLE = True
except ImportError:
    INDICATOR_AVAILABLE = False


class AdvancedPushToTalkManager:
    """Advanced PTT with multi-hotkey, VAD, and system tray"""

    def __init__(self, audio_system: AudioSystem, on_speech: Callable[[str, bool], None]):
        """
        Initialize PTT manager
        Args:
            audio_system: AudioSystem instance for recording
            on_speech: Callback function(text, has_screenshot) when speech is detected
        """
        self.audio_system = audio_system
        self.on_speech = on_speech

        # State
        self.is_recording = False
        self.is_running = False
        self.ptt_key_pressed = False
        self.screenshot_key_pressed = False

        # Hotkeys
        self.ptt_hotkey = keyboard.Key.space
        self.screenshot_hotkey = keyboard.Key.f9

        # VAD processor
        self.vad_processor = VADProcessor() if VAD_AVAILABLE else None

        # System tray indicator
        self.indicator = PTTIndicator() if INDICATOR_AVAILABLE else None

        # Keyboard listener
        self.listener: Optional[keyboard.Listener] = None
        self.recording_thread: Optional[threading.Thread] = None

    def start(self) -> None:
        """Start PTT listener"""
        if self.is_running:
            return

        self.is_running = True

        # Start system tray indicator
        if self.indicator:
            self.indicator.start()

        # Start keyboard listener
        self.listener = keyboard.Listener(
            on_press=self._on_key_press,
            on_release=self._on_key_release
        )
        self.listener.start()

        print("✨ Push-to-Talk active! Hold SPACEBAR to talk, press F9 for screenshot")

    def stop(self) -> None:
        """Stop PTT listener"""
        if not self.is_running:
            return

        self.is_running = False

        # Stop keyboard listener
        if self.listener:
            self.listener.stop()
            self.listener = None

        # Stop system tray indicator
        if self.indicator:
            self.indicator.stop()

        print("⏹️  Push-to-Talk stopped")

    def _on_key_press(self, key) -> None:
        """Handle key press events"""
        try:
            # Check for PTT hotkey
            if key == self.ptt_hotkey:
                if not self.ptt_key_pressed:
                    self.ptt_key_pressed = True
                    self._start_recording()

            # Check for screenshot hotkey
            elif key == self.screenshot_hotkey:
                self.screenshot_key_pressed = True

        except AttributeError:
            pass  # Ignore special keys

    def _on_key_release(self, key) -> None:
        """Handle key release events"""
        try:
            # Check for PTT hotkey release
            if key == self.ptt_hotkey:
                self.ptt_key_pressed = False
                if not self.vad_processor:
                    # Manual stop if no VAD
                    self._stop_recording()

            # Check for screenshot hotkey release
            elif key == self.screenshot_hotkey:
                self.screenshot_key_pressed = False

        except AttributeError:
            pass

    @handle_errors("starting recording")
    def _start_recording(self) -> None:
        """Start recording audio"""
        if self.is_recording:
            return

        self.is_recording = True

        # Update system tray
        if self.indicator:
            self.indicator.set_recording(True, self.screenshot_key_pressed)

        # Start recording in background thread
        self.recording_thread = threading.Thread(target=self._record_audio, daemon=True)
        self.recording_thread.start()

    @handle_errors("stopping recording")
    def _stop_recording(self) -> None:
        """Stop recording audio"""
        if not self.is_recording:
            return

        self.is_recording = False

        # Update system tray
        if self.indicator:
            self.indicator.set_recording(False, False)

    def _record_audio(self) -> None:
        """Record audio with VAD auto-stop"""
        print("🎤 Recording... (release SPACEBAR or stop talking to end)")

        try:
            # Use VAD if available
            if self.vad_processor:
                audio_data = self.vad_processor.record_with_vad(
                    silence_duration=1.5,  # Stop after 1.5s silence
                    max_duration=30,  # Max 30 seconds
                    stop_check=lambda: not self.ptt_key_pressed
                )
            else:
                # Manual recording (wait for key release)
                audio_chunks = []
                with sr.Microphone() as source:
                    sample_rate = source.SAMPLE_RATE
                    sample_width = source.SAMPLE_WIDTH
                    while self.ptt_key_pressed and self.is_recording:
                        chunk = source.stream.read(source.CHUNK)
                        audio_chunks.append(chunk)
                        time.sleep(0.01)

                if audio_chunks:
                    audio_data = sr.AudioData(b"".join(audio_chunks), sample_rate, sample_width)
                else:
                    audio_data = None

            # Convert to text
            if audio_data:
                print("🔄 Processing speech...")
                text = self.audio_system.transcribe_audio(audio_data)

                if text:
                    # Check if screenshot was requested
                    has_screenshot = self.screenshot_key_pressed

                    # Call callback
                    self.on_speech(text, has_screenshot)
                else:
                    print("❓ Could not understand audio")
            else:
                print("⚠️  No audio recorded")

        except Exception as e:
            print(f"❌ Recording error: {e}")
        finally:
            self.is_recording = False
            if self.indicator:
                self.indicator.set_recording(False, False)

    def set_hotkeys(self, ptt_key: keyboard.Key, screenshot_key: keyboard.Key) -> None:
        """
        Change hotkey bindings
        Args:
            ptt_key: Key for push-to-talk
            screenshot_key: Key for screenshot trigger
        """
        # Stop listener
        was_running = self.is_running
        if was_running:
            self.stop()

        # Update hotkeys
        self.ptt_hotkey = ptt_key
        self.screenshot_hotkey = screenshot_key

        # Restart listener
        if was_running:
            self.start()

        print(f"✅ Hotkeys updated: PTT={ptt_key}, Screenshot={screenshot_key}")
