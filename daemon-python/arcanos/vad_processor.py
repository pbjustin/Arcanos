"""
Voice Activity Detection (VAD) Processor
Auto-stop recording when user stops speaking.
"""

import time
import collections
from typing import Optional, Callable
import speech_recognition as sr

try:
    import webrtcvad
    VAD_AVAILABLE = True
except ImportError:
    VAD_AVAILABLE = False


class VADProcessor:
    """Process audio with voice activity detection"""

    def __init__(self, aggressiveness: int = 2):
        """
        Initialize VAD processor
        Args:
            aggressiveness: VAD aggressiveness (0-3, higher = more strict)
        """
        if not VAD_AVAILABLE:
            raise ImportError("webrtcvad not available. Install with: python -m pip install webrtcvad")

        self.vad = webrtcvad.Vad(aggressiveness)
        self.sample_rate = 16000  # 16kHz required by WebRTC VAD

    def is_speech(self, audio_frame: bytes) -> bool:
        """
        Check if audio frame contains speech
        Args:
            audio_frame: Raw audio bytes (16kHz, 16-bit PCM)
        Returns:
            True if speech detected
        """
        try:
            return self.vad.is_speech(audio_frame, self.sample_rate)
        except Exception:
            return False

    def record_with_vad(
        self,
        silence_duration: float = 1.5,
        max_duration: int = 30,
        stop_check: Optional[Callable[[], bool]] = None
    ) -> Optional[sr.AudioData]:
        """
        Record audio with automatic stop on silence
        Args:
            silence_duration: Seconds of silence before stopping
            max_duration: Maximum recording duration
            stop_check: Optional function that returns True to stop
        Returns:
            AudioData or None
        """
        recognizer = sr.Recognizer()

        with sr.Microphone(sample_rate=self.sample_rate) as source:
            # Adjust for ambient noise
            recognizer.adjust_for_ambient_noise(source, duration=0.3)

            frames = []
            silence_frames = 0
            frames_per_second = self.sample_rate // 320  # 20ms frames
            max_silence_frames = int(silence_duration * frames_per_second)

            start_time = time.time()

            # Record until silence or max duration
            while True:
                # Check stop conditions
                if stop_check and stop_check():
                    break
                if time.time() - start_time > max_duration:
                    break

                # Read audio frame (20ms at 16kHz)
                try:
                    frame = source.stream.read(320)
                    frames.append(frame)

                    # Check for speech
                    if self.is_speech(frame):
                        silence_frames = 0
                    else:
                        silence_frames += 1

                    # Stop if silence threshold reached (but only after some speech)
                    if len(frames) > frames_per_second and silence_frames >= max_silence_frames:
                        break

                except Exception:
                    break

            # Convert frames to AudioData
            if frames:
                audio_data = sr.AudioData(b''.join(frames), self.sample_rate, 2)
                return audio_data

            return None
