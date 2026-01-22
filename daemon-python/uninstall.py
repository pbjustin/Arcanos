"""
ARCANOS Uninstaller
Complete removal tool with optional data preservation.
"""

import os
import shutil
from pathlib import Path

try:
    import winshell
except ModuleNotFoundError:
    winshell = None

from config import Config


class Uninstaller:
    """Handles complete ARCANOS uninstallation"""

    def __init__(self):
        self.base_dir = Config.BASE_DIR
        desktop = self._get_desktop_path()
        start_menu = self._get_start_menu_programs_path()
        startup = self._get_startup_path()
        self.shortcuts = [
            desktop / "ARCANOS.lnk",
            start_menu / "ARCANOS.lnk",
            startup / "ARCANOS.lnk"
        ]

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

    def remove_shortcuts(self) -> None:
        """Remove all ARCANOS shortcuts"""
        print("🗑️  Removing shortcuts...")
        for shortcut in self.shortcuts:
            if shortcut.exists():
                shortcut.unlink()
                print(f"   ✅ Removed: {shortcut.name}")

    def remove_terminal_profile(self) -> None:
        """Remove Windows Terminal profile"""
        try:
            import json
            from windows_integration import WindowsIntegration

            integration = WindowsIntegration()
            settings_path = integration.settings_path

            if not settings_path.exists():
                print("   ⏭️  Windows Terminal not found")
                return

            print("🗑️  Removing Terminal profile...")

            # Load settings
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)

            # Remove ARCANOS profile
            profiles = settings.get("profiles", {}).get("list", [])
            new_profiles = [p for p in profiles if p.get("name") != "ARCANOS"]

            if len(new_profiles) < len(profiles):
                settings["profiles"]["list"] = new_profiles

                # Save settings
                with open(settings_path, "w", encoding="utf-8") as f:
                    json.dump(settings, f, indent=4)

                print("   ✅ Terminal profile removed")
            else:
                print("   ⏭️  Terminal profile not found")

        except Exception as e:
            print(f"   ⚠️  Failed to remove Terminal profile: {e}")

    def backup_user_data(self, backup_path: Path) -> bool:
        """
        Backup user data (memories, settings, logs)
        Returns:
            True if successful
        """
        try:
            print(f"💾 Backing up user data to: {backup_path}")
            backup_path.mkdir(parents=True, exist_ok=True)

            # Backup memories
            if Config.MEMORY_FILE.exists():
                shutil.copy2(Config.MEMORY_FILE, backup_path / "memories.json")
                print("   ✅ Backed up memories")

            # Backup .env
            env_file = Config.BASE_DIR / ".env"
            if env_file.exists():
                shutil.copy2(env_file, backup_path / ".env")
                print("   ✅ Backed up configuration")

            # Backup logs
            if Config.LOG_DIR.exists():
                shutil.copytree(Config.LOG_DIR, backup_path / "logs", dirs_exist_ok=True)
                print("   ✅ Backed up logs")

            print(f"✅ Backup complete: {backup_path}")
            return True

        except Exception as e:
            print(f"❌ Backup failed: {e}")
            return False

    def remove_all_data(self) -> None:
        """Remove all ARCANOS data (destructive!)"""
        print("🗑️  Removing all data...")

        # Remove memories
        if Config.MEMORY_FILE.exists():
            Config.MEMORY_FILE.unlink()
            print("   ✅ Removed memories")

        # Remove logs
        if Config.LOG_DIR.exists():
            shutil.rmtree(Config.LOG_DIR)
            print("   ✅ Removed logs")

        # Remove screenshots
        if Config.SCREENSHOT_DIR.exists():
            shutil.rmtree(Config.SCREENSHOT_DIR)
            print("   ✅ Removed screenshots")

        # Remove crash reports
        if Config.CRASH_REPORTS_DIR.exists():
            shutil.rmtree(Config.CRASH_REPORTS_DIR)
            print("   ✅ Removed crash reports")

        # Remove telemetry
        if Config.TELEMETRY_DIR.exists():
            shutil.rmtree(Config.TELEMETRY_DIR)
            print("   ✅ Removed telemetry")

    def uninstall(self, backup: bool = True) -> None:
        """
        Complete uninstallation
        Args:
            backup: Whether to backup user data before removal
        """
        print("\n" + "="*50)
        print("🗑️  ARCANOS UNINSTALLER")
        print("="*50 + "\n")

        # Confirm
        print("⚠️  This will remove ARCANOS from your system.")
        print("   - Windows shortcuts")
        print("   - Terminal profile")
        print("   - All data and settings" + (" (after backup)" if backup else ""))

        confirm = input("\nAre you sure? Type 'UNINSTALL' to confirm: ").strip()
        if confirm != "UNINSTALL":
            print("❌ Uninstall cancelled")
            return

        # Backup if requested
        if backup:
            backup_path = Path.home() / "Desktop" / "ARCANOS_Backup"
            self.backup_user_data(backup_path)

        # Remove components
        self.remove_shortcuts()
        self.remove_terminal_profile()
        self.remove_all_data()

        print("\n" + "="*50)
        print("✅ ARCANOS has been uninstalled")
        print("="*50)

        if backup:
            print(f"\n💾 Your data was backed up to:")
            print(f"   {backup_path}")

        print("\n👋 Thank you for using ARCANOS!")


if __name__ == "__main__":
    uninstaller = Uninstaller()
    uninstaller.uninstall(backup=True)
