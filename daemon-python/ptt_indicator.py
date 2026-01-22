"""
System Tray Indicator for Push-to-Talk
Shows microphone status in Windows system tray.
"""

import threading
from typing import Optional
import pystray
from PIL import Image, ImageDraw
from error_handler import handle_errors


class PTTIndicator:
    """System tray indicator for PTT status"""

    def __init__(self):
        self.icon: Optional[pystray.Icon] = None
        self.is_recording = False
        self.has_screenshot = False
        self.thread: Optional[threading.Thread] = None

    def _create_icon_image(self, recording: bool, screenshot: bool) -> Image.Image:
        """Create icon image based on status"""
        # Create 64x64 image
        img = Image.new('RGB', (64, 64), color='black')
        draw = ImageDraw.Draw(img)

        # Draw microphone icon
        if recording:
            # Red microphone (recording)
            color = 'red'
            # Microphone body
            draw.ellipse([20, 15, 44, 35], fill=color)
            draw.rectangle([28, 35, 36, 45], fill=color)
            # Stand
            draw.rectangle([30, 45, 34, 55], fill=color)
            draw.rectangle([22, 55, 42, 58], fill=color)

            # Screenshot indicator
            if screenshot:
                draw.rectangle([48, 10, 58, 20], outline='yellow', width=2)
        else:
            # Gray microphone (idle)
            color = 'gray'
            draw.ellipse([20, 15, 44, 35], fill=color)
            draw.rectangle([28, 35, 36, 45], fill=color)
            draw.rectangle([30, 45, 34, 55], fill=color)
            draw.rectangle([22, 55, 42, 58], fill=color)

        return img

    @handle_errors("starting system tray indicator")
    def start(self) -> None:
        """Start system tray indicator"""
        if self.icon:
            return

        # Create icon
        self.icon = pystray.Icon(
            "arcanos_ptt",
            self._create_icon_image(False, False),
            "ARCANOS PTT (Idle)",
            menu=pystray.Menu(
                pystray.MenuItem("ARCANOS Push-to-Talk", lambda: None, enabled=False),
                pystray.MenuItem("Hold SPACEBAR to talk", lambda: None, enabled=False),
                pystray.MenuItem("Press F9 for screenshot", lambda: None, enabled=False)
            )
        )

        # Run in background thread
        self.thread = threading.Thread(target=self.icon.run, daemon=True)
        self.thread.start()

    @handle_errors("stopping system tray indicator")
    def stop(self) -> None:
        """Stop system tray indicator"""
        if self.icon:
            self.icon.stop()
            self.icon = None
            self.thread = None

    def set_recording(self, recording: bool, screenshot: bool) -> None:
        """
        Update recording status
        Args:
            recording: Whether currently recording
            screenshot: Whether screenshot requested
        """
        self.is_recording = recording
        self.has_screenshot = screenshot

        if self.icon:
            # Update icon
            self.icon.icon = self._create_icon_image(recording, screenshot)

            # Update title
            if recording:
                status = "Recording" + (" + Screenshot" if screenshot else "")
            else:
                status = "Idle"
            self.icon.title = f"ARCANOS PTT ({status})"
