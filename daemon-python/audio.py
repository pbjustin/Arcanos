"""
Audio System for ARCANOS
Speech recognition and text-to-speech capabilities.
"""

from __future__ import annotations

from typing import Optional, Union

try:
    import speech_recognition as sr
except ModuleNotFoundError:
    sr = None

try:
    import pyttsx3
except ModuleNotFoundError:
    pyttsx3 = None
from config import Config
from error_handler import handle_errors
from gpt_client import GPTClient

AudioInput = Union["sr.AudioData", bytes, bytearray]


class AudioSystem:
    """Handles speech recognition and text-to-speech"""

    def __init__(self, gpt_client: Optional[GPTClient] = None):
        self.gpt_client = gpt_client

        # Initialize speech recognition
        self.recognizer = None
        if sr is not None:
            self.recognizer = sr.Recognizer()
            self.recognizer.energy_threshold = 4000  # Adjust for ambient noise
            self.recognizer.dynamic_energy_threshold = True

        # Initialize text-to-speech
        self.tts_engine = None
        if pyttsx3 is not None:
            try:
                self.tts_engine = pyttsx3.init()
                self.tts_engine.setProperty('rate', 175)  # Speed
                self.tts_engine.setProperty('volume', 0.9)  # Volume

                # Use female voice if available (more natural)
                voices = self.tts_engine.getProperty('voices')
                for voice in voices:
                    if 'female' in voice.name.lower() or 'zira' in voice.name.lower():
                        self.tts_engine.setProperty('voice', voice.id)
                        break
            except Exception:
                self.tts_engine = None

    def _get_gpt_client(self) -> GPTClient:
        if not self.gpt_client:
            self.gpt_client = GPTClient()
        return self.gpt_client

    def extract_audio_bytes(self, audio: AudioInput) -> bytes:
        """
        Purpose: Convert supported audio inputs to raw WAV bytes.
        Inputs/Outputs: AudioInput (AudioData, bytes, bytearray); returns bytes.
        Edge cases: Raises RuntimeError for unsupported input types.
        """
        if hasattr(audio, "get_wav_data"):
            # //audit assumption: AudioData exposes get_wav_data; risk: missing method; invariant: bytes returned; strategy: call method.
            return audio.get_wav_data()
        if isinstance(audio, (bytes, bytearray)):
            # //audit assumption: raw bytes are valid; risk: empty audio; invariant: bytes returned; strategy: cast to bytes.
            return bytes(audio)
        # //audit assumption: unsupported audio types are invalid; risk: silent failure; invariant: error raised; strategy: raise RuntimeError.
        raise RuntimeError("Unsupported audio input type for transcription.")

    @handle_errors("transcribing speech")
    def transcribe_audio(self, audio: AudioInput) -> Optional[str]:
        """
        Transcribe speech using OpenAI
        """
        if not audio:
            return None

        audio_bytes = self.extract_audio_bytes(audio)
        text = self._get_gpt_client().transcribe_audio(audio_bytes)
        return text.strip() if text else None

    @handle_errors("capturing microphone audio")
    def capture_microphone_audio(self, timeout: int = 5, phrase_time_limit: int = 10) -> Optional[AudioInput]:
        """
        Purpose: Capture microphone audio without transcription.
        Inputs/Outputs: timeout and phrase_time_limit; returns AudioData or None.
        Edge cases: Returns None when speech recognition dependencies are missing.
        """
        if sr is None or self.recognizer is None:
            # //audit assumption: speech recognition optional; risk: missing dependency; invariant: return None; strategy: print warning.
            print("Voice input unavailable (missing SpeechRecognition).")
            return None

        with sr.Microphone() as source:
            print("Listening... (speak now)")

            # Adjust for ambient noise
            self.recognizer.adjust_for_ambient_noise(source, duration=0.5)

            try:
                # Listen for audio
                audio = self.recognizer.listen(
                    source,
                    timeout=timeout,
                    phrase_time_limit=phrase_time_limit
                )

                print("Processing speech...")
                return audio

            except sr.WaitTimeoutError:
                print("No speech detected (timeout)")
                return None
            except sr.UnknownValueError:
                print("Could not understand audio")
                return None
            except sr.RequestError as e:
                print(f"Speech recognition error: {e}")
                return None

    @handle_errors("listening to microphone")
    def listen(self, timeout: int = 5, phrase_time_limit: int = 10) -> Optional[str]:
        """
        Listen to microphone and convert speech to text
        Args:
            timeout: Seconds to wait for speech to start
            phrase_time_limit: Max seconds for a single phrase
        Returns:
            Recognized text or None
        """
        audio = self.capture_microphone_audio(timeout=timeout, phrase_time_limit=phrase_time_limit)
        if not audio:
            # //audit assumption: no audio captured; risk: null transcription; invariant: None returned; strategy: return None.
            return None

        # Convert speech to text using OpenAI transcription
        return self.transcribe_audio(audio)

    @handle_errors("speaking text")
    def speak(self, text: str, wait: bool = True) -> bool:
        """
        Convert text to speech and play it
        Args:
            text: Text to speak
            wait: Whether to wait for speech to finish
        Returns:
            Success status
        """
        if not self.tts_engine:
            print(f"🔊 (TTS unavailable) {text}")
            return False

        try:
            self.tts_engine.say(text)
            if wait:
                self.tts_engine.runAndWait()
            return True
        except Exception as e:
            print(f"❌ TTS error: {e}")
            return False

    @handle_errors("recording audio")
    def record_audio(self, duration: int = 5) -> Optional[sr.AudioData]:
        """
        Record audio for a specific duration
        Args:
            duration: Recording duration in seconds
        Returns:
            AudioData object or None
        """
        if sr is None or self.recognizer is None:
            print("Voice input unavailable (missing SpeechRecognition).")
            return None

        with sr.Microphone() as source:
            print(f"🎤 Recording for {duration} seconds...")

            # Adjust for ambient noise
            self.recognizer.adjust_for_ambient_noise(source, duration=0.5)

            # Record
            audio = self.recognizer.record(source, duration=duration)
            print("✅ Recording complete")

            return audio

    def test_microphone(self) -> bool:
        """
        Test if microphone is working
        Returns:
            True if microphone is accessible
        """
        if sr is None or self.recognizer is None:
            return False

        try:
            with sr.Microphone() as source:
                self.recognizer.adjust_for_ambient_noise(source, duration=0.5)
            return True
        except Exception:
            return False

    def test_speakers(self) -> bool:
        """
        Test if speakers/TTS is working
        Returns:
            True if TTS is functional
        """
        if not self.tts_engine:
            return False

        try:
            self.speak("Testing speakers", wait=True)
            return True
        except Exception:
            return False
