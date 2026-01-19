"""
Windows Terminal Integration
Installs custom ARCANOS profile and desktop shortcuts.
"""

import json
import os
from pathlib import Path

try:
    import winshell
except ModuleNotFoundError:
    winshell = None

try:
    from win32com.client import Dispatch
except ModuleNotFoundError:
    Dispatch = None

from config import Config
from error_handler import handle_errors


class WindowsIntegration:
    """Manages Windows Terminal and system integration"""

    def __init__(self):
        self.settings_path = self._get_terminal_settings_path()
        self.arcanos_exe = Path(__file__).parent / "dist" / "ARCANOS.exe"

    def _get_shell(self):
        if Dispatch is None:
            print("Windows integration requires pywin32. Install with: pip install pywin32")
            return None
        return Dispatch("WScript.Shell")

    def _get_desktop_path(self) -> Path:
        if winshell is not None:
            try:
                return Path(winshell.desktop())
            except Exception:
                pass

        user_profile = os.getenv("USERPROFILE")
        candidates = []
        if user_profile:
            candidates.append(Path(user_profile) / "Desktop")
            candidates.append(Path(user_profile) / "OneDrive" / "Desktop")
        public = os.getenv("PUBLIC")
        if public:
            candidates.append(Path(public) / "Desktop")
        for candidate in candidates:
            if candidate.exists():
                return candidate
        if candidates:
            return candidates[0]
        return Path.home() / "Desktop"

    def _get_start_menu_path(self) -> Path:
        if winshell is not None:
            try:
                return Path(winshell.start_menu())
            except Exception:
                pass

        appdata = os.getenv("APPDATA")
        if appdata:
            return Path(appdata) / "Microsoft" / "Windows" / "Start Menu"
        return Path.home() / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu"

    def _get_start_menu_programs_path(self) -> Path:
        return self._get_start_menu_path() / "Programs"

    def _get_startup_path(self) -> Path:
        if winshell is not None:
            try:
                return Path(winshell.startup())
            except Exception:
                pass
        return self._get_start_menu_programs_path() / "Startup"

    def _get_terminal_settings_path(self) -> Path:
        """Get Windows Terminal settings.json path"""
        local_appdata = os.getenv("LOCALAPPDATA")
        if not local_appdata:
            local_appdata = str(Path.home() / "AppData" / "Local")
        return Path(local_appdata) / "Packages" / "Microsoft.WindowsTerminal_8wekyb3d8bbwe" / "LocalState" / "settings.json"

    @handle_errors("checking Windows Terminal installation")
    def is_terminal_installed(self) -> bool:
        """Check if Windows Terminal is installed"""
        return self.settings_path.exists()

    @handle_errors("installing Terminal profile")
    def install_terminal_profile(self) -> bool:
        """
        Add ARCANOS profile to Windows Terminal
        Returns:
            True if successful
        """
        if not self.is_terminal_installed():
            print("⚠️  Windows Terminal not found")
            return False

        # Read current settings
        with open(self.settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)

        # Check if profile already exists
        profiles = settings.get("profiles", {}).get("list", [])
        for profile in profiles:
            if profile.get("name") == "ARCANOS":
                print("✅ ARCANOS profile already exists")
                return True

        # Create ARCANOS profile
        arcanos_profile = {
            "name": "ARCANOS",
            "commandline": f"python {Path(__file__).parent / 'cli.py'}",
            "icon": str(Path(__file__).parent / "assets" / "icon.png"),
            "colorScheme": "ARCANOS Dark",
            "fontFace": "Cascadia Code",
            "fontSize": 11,
            "cursorShape": "filledBox",
            "backgroundImage": "",
            "backgroundImageOpacity": 0.1,
            "startingDirectory": str(Path(__file__).parent),
            "hidden": False
        }

        # Add ARCANOS Dark color scheme if not exists
        if "schemes" not in settings:
            settings["schemes"] = []

        has_scheme = any(scheme.get("name") == "ARCANOS Dark" for scheme in settings["schemes"])
        if not has_scheme:
            arcanos_scheme = {
                "name": "ARCANOS Dark",
                "background": "#0C0C0C",
                "foreground": "#E0E0E0",
                "black": "#0C0C0C",
                "blue": "#0037DA",
                "cyan": "#3A96DD",
                "green": "#13A10E",
                "purple": "#881798",
                "red": "#C50F1F",
                "white": "#CCCCCC",
                "yellow": "#C19C00",
                "brightBlack": "#767676",
                "brightBlue": "#3B78FF",
                "brightCyan": "#61D6D6",
                "brightGreen": "#16C60C",
                "brightPurple": "#B4009E",
                "brightRed": "#E74856",
                "brightWhite": "#F2F2F2",
                "brightYellow": "#F9F1A5"
            }
            settings["schemes"].append(arcanos_scheme)

        # Add profile
        profiles.append(arcanos_profile)

        # Save settings
        with open(self.settings_path, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=4)

        print("✅ ARCANOS profile installed in Windows Terminal")
        return True

    @handle_errors("creating desktop shortcut")
    def create_desktop_shortcut(self) -> bool:
        """
        Create ARCANOS desktop shortcut
        Returns:
            True if successful
        """
        desktop = self._get_desktop_path()
        desktop.mkdir(parents=True, exist_ok=True)
        shortcut_path = desktop / "ARCANOS.lnk"

        # Create shortcut
        shell = self._get_shell()
        if shell is None:
            return False
        shortcut = shell.CreateShortCut(str(shortcut_path))

        # Check if .exe exists, otherwise use python script
        if self.arcanos_exe.exists():
            shortcut.TargetPath = str(self.arcanos_exe)
        else:
            python_exe = os.path.join(os.path.dirname(os.sys.executable), "python.exe")
            shortcut.TargetPath = python_exe
            shortcut.Arguments = f'"{Path(__file__).parent / "cli.py"}"'

        shortcut.WorkingDirectory = str(Path(__file__).parent)
        shortcut.IconLocation = str(Path(__file__).parent / "assets" / "icon.ico")
        shortcut.Description = "ARCANOS AI Assistant"
        shortcut.save()

        print(f"✅ Desktop shortcut created: {shortcut_path}")
        return True

    @handle_errors("creating start menu shortcut")
    def create_start_menu_shortcut(self) -> bool:
        """
        Create ARCANOS start menu shortcut
        Returns:
            True if successful
        """
        start_menu = self._get_start_menu_programs_path()
        start_menu.mkdir(parents=True, exist_ok=True)
        shortcut_path = start_menu / "ARCANOS.lnk"

        # Create shortcut
        shell = self._get_shell()
        if shell is None:
            return False
        shortcut = shell.CreateShortCut(str(shortcut_path))

        if self.arcanos_exe.exists():
            shortcut.TargetPath = str(self.arcanos_exe)
        else:
            python_exe = os.path.join(os.path.dirname(os.sys.executable), "python.exe")
            shortcut.TargetPath = python_exe
            shortcut.Arguments = f'"{Path(__file__).parent / "cli.py"}"'

        shortcut.WorkingDirectory = str(Path(__file__).parent)
        shortcut.IconLocation = str(Path(__file__).parent / "assets" / "icon.ico")
        shortcut.Description = "ARCANOS AI Assistant"
        shortcut.save()

        print(f"✅ Start menu shortcut created: {shortcut_path}")
        return True

    @handle_errors("adding to startup")
    def add_to_startup(self) -> bool:
        """
        Add ARCANOS to Windows startup (auto-start on login)
        Returns:
            True if successful
        """
        startup = self._get_startup_path()
        startup.mkdir(parents=True, exist_ok=True)
        shortcut_path = startup / "ARCANOS.lnk"

        # Create shortcut
        shell = self._get_shell()
        if shell is None:
            return False
        shortcut = shell.CreateShortCut(str(shortcut_path))

        if self.arcanos_exe.exists():
            shortcut.TargetPath = str(self.arcanos_exe)
        else:
            python_exe = os.path.join(os.path.dirname(os.sys.executable), "python.exe")
            shortcut.TargetPath = python_exe
            shortcut.Arguments = f'"{Path(__file__).parent / "cli.py"}"'

        shortcut.WorkingDirectory = str(Path(__file__).parent)
        shortcut.save()

        print(f"✅ Added to startup: {shortcut_path}")
        return True

    @handle_errors("removing from startup")
    def remove_from_startup(self) -> bool:
        """
        Remove ARCANOS from Windows startup
        Returns:
            True if successful
        """
        startup = self._get_startup_path()
        shortcut_path = startup / "ARCANOS.lnk"

        if shortcut_path.exists():
            shortcut_path.unlink()
            print("✅ Removed from startup")
            return True
        else:
            print("⚠️  Not in startup")
            return False

    def install_all(self) -> bool:
        """
        Install all Windows integrations
        Returns:
            True if all successful
        """
        results = []

        print("\n🔧 Installing Windows Integration...")
        print("=" * 50)

        # Terminal profile
        if self.is_terminal_installed():
            results.append(self.install_terminal_profile())
        else:
            print("⏭️  Skipping Terminal profile (Terminal not installed)")

        # Desktop shortcut
        results.append(self.create_desktop_shortcut())

        # Start menu shortcut
        results.append(self.create_start_menu_shortcut())

        # Auto-start (optional)
        if Config.AUTO_START:
            results.append(self.add_to_startup())

        print("=" * 50)
        if all(results):
            print("✅ Windows integration complete!")
            return True
        else:
            print("⚠️  Some integrations failed")
            return False
