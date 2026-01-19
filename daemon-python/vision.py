"""
Vision System for ARCANOS
Screen capture and camera integration with GPT-4o Vision.
"""

import base64
from io import BytesIO
from pathlib import Path
from typing import Optional, Tuple

# `cv2` (OpenCV) is optional — if it's not installed, set to None and
# provide a helpful error when camera capture is attempted.
cv2 = None
try:
    from PIL import Image
except ModuleNotFoundError:
    Image = None
from config import Config
from error_handler import handle_errors

try:
    import pyautogui
except ModuleNotFoundError:
    pyautogui = None


class VisionSystem:
    """Handles screen and camera capture for vision analysis"""

    def __init__(self, gpt_client):
        """
        Initialize vision system with dependency injection
        Args:
            gpt_client: GPTClient instance for making vision requests
        """
        self.gpt_client = gpt_client
        self.screenshot_dir = Config.SCREENSHOT_DIR
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)

    def _encode_cv2_image(self, frame_rgb, frame_bgr, save: bool, prefix: str) -> str:
        max_size = 2000
        height, width = frame_rgb.shape[:2]
        if max(width, height) > max_size:
            ratio = max_size / max(width, height)
            new_size = (int(width * ratio), int(height * ratio))
            frame_rgb = cv2.resize(frame_rgb, new_size, interpolation=cv2.INTER_LANCZOS4)
            frame_bgr = cv2.resize(frame_bgr, new_size, interpolation=cv2.INTER_LANCZOS4)

        if save:
            from datetime import datetime
            filename = f"{prefix}{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            filepath = self.screenshot_dir / filename
            cv2.imwrite(str(filepath), frame_bgr)

        success, buffer = cv2.imencode(".png", frame_rgb)
        if not success:
            raise RuntimeError("Failed to encode image to PNG.")

        return base64.b64encode(buffer.tobytes()).decode("utf-8")

    @handle_errors("capturing screenshot")
    def capture_screenshot(self, save: bool = True) -> Optional[str]:
        """
        Capture screenshot and return base64 encoded image
        Args:
            save: Whether to save screenshot to disk
        Returns:
            Base64 encoded PNG image or None on error
        """
        # Take screenshot (prefer pyautogui, fallback to PIL.ImageGrab)
        screenshot = None
        if pyautogui is not None:
            try:
                screenshot = pyautogui.screenshot()
            except Exception:
                screenshot = None

        if screenshot is None:
            try:
                from PIL import ImageGrab
            except Exception as exc:
                raise RuntimeError(
                    "Screenshot capture requires pyautogui or Pillow ImageGrab."
                ) from exc
            try:
                screenshot = ImageGrab.grab()
            except Exception as exc:
                raise RuntimeError(
                    "Failed to capture screenshot. Install pyautogui or run in a GUI session."
                ) from exc

        # Convert to RGB (remove alpha channel if present)
        if screenshot.mode == 'RGBA':
            screenshot = screenshot.convert('RGB')

        # Resize if too large (max 2000px on longest side)
        max_size = 2000
        if max(screenshot.size) > max_size:
            ratio = max_size / max(screenshot.size)
            new_size = tuple(int(dim * ratio) for dim in screenshot.size)
            screenshot = screenshot.resize(new_size, Image.Resampling.LANCZOS)

        # Save to disk if requested
        if save:
            from datetime import datetime
            filename = f"screenshot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            filepath = self.screenshot_dir / filename
            screenshot.save(filepath)

        # Convert to base64
        buffer = BytesIO()
        screenshot.save(buffer, format='PNG')
        img_bytes = buffer.getvalue()
        img_base64 = base64.b64encode(img_bytes).decode('utf-8')

        return img_base64

    @handle_errors("capturing from camera")
    def capture_camera(self, camera_index: int = 0, save: bool = True) -> Optional[str]:
        """
        Capture image from webcam and return base64 encoded image
        Args:
            camera_index: Camera device index (usually 0 for default)
            save: Whether to save image to disk
        Returns:
            Base64 encoded PNG image or None on error
        """
        # Require OpenCV for camera capture (lazy import)
        global cv2
        if cv2 is None:
            try:
                import importlib
                cv2 = importlib.import_module("cv2")
            except ModuleNotFoundError:
                raise RuntimeError(
                    "OpenCV (cv2) is not installed. Install it with: `pip install opencv-python`. "
                    "Alternatively, use `see_screen()` to analyze your screen without a webcam."
                )

        # Open camera
        cap = cv2.VideoCapture(camera_index)

        if not cap.isOpened():
            raise RuntimeError("Could not open camera. Make sure webcam is connected.")

        # Capture frame
        ret, frame = cap.read()
        cap.release()

        if not ret:
            raise RuntimeError("Failed to capture image from camera.")

        # Convert BGR to RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        if Image is None:
            return self._encode_cv2_image(frame_rgb, frame, save, "camera_")

        # Convert to PIL Image
        image = Image.fromarray(frame_rgb)

        # Resize if too large
        max_size = 2000
        if max(image.size) > max_size:
            ratio = max_size / max(image.size)
            new_size = tuple(int(dim * ratio) for dim in image.size)
            image = image.resize(new_size, Image.Resampling.LANCZOS)

        # Save to disk if requested
        if save:
            from datetime import datetime
            filename = f"camera_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            filepath = self.screenshot_dir / filename
            image.save(filepath)

        # Convert to base64
        buffer = BytesIO()
        image.save(buffer, format='PNG')
        img_bytes = buffer.getvalue()
        img_base64 = base64.b64encode(img_bytes).decode('utf-8')

        return img_base64

    @handle_errors("analyzing image with vision")
    def analyze_image(
        self,
        image_base64: str,
        prompt: str = "What do you see in this image? Describe it in detail.",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None
    ) -> Tuple[Optional[str], int, float]:
        """
        Send image to GPT-4o Vision for analysis
        Returns: (response_text, tokens_used, cost)
        """
        return self.gpt_client.ask_with_vision(
            user_message=prompt,
            image_base64=image_base64,
            temperature=temperature,
            max_tokens=max_tokens
        )

    @handle_errors("analyzing screenshot")
    def see_screen(self, prompt: Optional[str] = None) -> Tuple[Optional[str], int, float]:
        """
        Capture screenshot and analyze it
        Returns: (response_text, tokens_used, cost)
        """
        print("📸 Capturing screenshot...")
        img_base64 = self.capture_screenshot(save=True)

        if not img_base64:
            return None, 0, 0.0

        print("👁️  Analyzing with GPT-4o Vision...")
        default_prompt = "What do you see on this screen? Describe the key elements and what the user appears to be doing."
        return self.analyze_image(img_base64, prompt or default_prompt)

    @handle_errors("analyzing camera")
    def see_camera(self, prompt: Optional[str] = None, camera_index: int = 0) -> Tuple[Optional[str], int, float]:
        """
        Capture from camera and analyze it
        Returns: (response_text, tokens_used, cost)
        """
        print("📷 Capturing from camera...")
        img_base64 = self.capture_camera(camera_index=camera_index, save=True)

        if not img_base64:
            return None, 0, 0.0

        print("👁️  Analyzing with GPT-4o Vision...")
        default_prompt = "What do you see in this image? Describe it in detail."
        return self.analyze_image(img_base64, prompt or default_prompt)
