"""
ARCANOS Uninstaller
Complete removal tool with optional data preservation.
"""

import os
import shutil
import sys
from pathlib import Path

from .config import Config


class Uninstaller:
    """Handles complete ARCANOS uninstallation"""

    def __init__(self):
        self.base_dir = Config.BASE_DIR
        self._is_windows = sys.platform == "win32"
        self.shortcuts = self._get_shortcut_paths()

    def _get_shortcut_paths(self) -> list[Path]:
        """
        Purpose: Build the list of Windows shortcut paths to remove.
        Inputs/Outputs: None; returns a list of .lnk paths (empty on non-Windows).
        Edge cases: Uses best-effort path resolution for user/Desktop locations.
        """
        if not self._is_windows:
            # //audit assumption: shortcuts are Windows-only; risk: invalid paths on Unix; invariant: return empty; strategy: skip.
            return []
        desktop = self._get_desktop_path()
        start_menu = self._get_start_menu_programs_path()
        startup = self._get_startup_path()
        return [
            desktop / "ARCANOS.lnk",
            start_menu / "ARCANOS.lnk",
            startup / "ARCANOS.lnk"
        ]

    def _get_desktop_path(self) -> Path:
        """
        Purpose: Resolve Windows desktop path without winshell.
        Inputs/Outputs: None; returns a candidate desktop Path.
        Edge cases: Returns a best-effort path even if it does not exist.
        """
        user_profile = os.getenv("USERPROFILE")
        candidates = []
        if user_profile:
            # //audit assumption: user profile set; risk: missing Desktop path; invariant: add candidate; strategy: append paths.
            candidates.append(Path(user_profile) / "Desktop")
            candidates.append(Path(user_profile) / "OneDrive" / "Desktop")
        public = os.getenv("PUBLIC")
        if public:
            # //audit assumption: PUBLIC set; risk: no public desktop; invariant: add candidate; strategy: append path.
            candidates.append(Path(public) / "Desktop")
        for candidate in candidates:
            if candidate.exists():
                # //audit assumption: candidate exists; risk: stale path; invariant: return first existing; strategy: early return.
                return candidate
        if candidates:
            # //audit assumption: candidate list non-empty; risk: path may not exist; invariant: return best-effort; strategy: return first candidate.
            return candidates[0]
        return Path.home() / "Desktop"

    def _get_start_menu_path(self) -> Path:
        """
        Purpose: Resolve Windows Start Menu path without winshell.
        Inputs/Outputs: None; returns a start menu Path.
        Edge cases: Falls back to default AppData path when env vars missing.
        """
        appdata = os.getenv("APPDATA")
        if appdata:
            # //audit assumption: APPDATA available; risk: non-Windows env; invariant: use AppData path; strategy: return derived path.
            return Path(appdata) / "Microsoft" / "Windows" / "Start Menu"
        return Path.home() / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu"

    def _get_start_menu_programs_path(self) -> Path:
        """Return Start Menu Programs path (Windows-only)."""
        return self._get_start_menu_path() / "Programs"

    def _get_startup_path(self) -> Path:
        """Return Startup path under Start Menu Programs (Windows-only)."""
        return self._get_start_menu_programs_path() / "Startup"

    def remove_shortcuts(self) -> None:
        """Remove all ARCANOS shortcuts"""
        if not self._is_windows:
            # //audit assumption: shortcuts only exist on Windows; risk: misleading errors; invariant: skip; strategy: early return.
            print("???  Skipping shortcuts removal (non-Windows).")
            return
        print("???  Removing shortcuts...")
        for shortcut in self.shortcuts:
            if shortcut.exists():
                # //audit assumption: shortcut exists; risk: unlink failure; invariant: delete link; strategy: unlink and report.
                shortcut.unlink()
                print(f"   ? Removed: {shortcut.name}")

    def _get_windows_terminal_settings_path(self) -> Path:
        """
        Purpose: Resolve Windows Terminal settings.json path.
        Inputs/Outputs: None; returns settings Path.
        Edge cases: Falls back to user AppData path when LOCALAPPDATA missing.
        """
        local_appdata = os.getenv("LOCALAPPDATA")
        if not local_appdata:
            # //audit assumption: LOCALAPPDATA missing; risk: wrong path; invariant: fallback to user profile; strategy: use AppData/Local.
            local_appdata = str(Path.home() / "AppData" / "Local")
        return (
            Path(local_appdata)
            / "Packages"
            / "Microsoft.WindowsTerminal_8wekyb3d8bbwe"
            / "LocalState"
            / "settings.json"
        )

    def remove_terminal_profile(self) -> None:
        """Remove Windows Terminal profile"""
        if not self._is_windows:
            # //audit assumption: Windows Terminal only on Windows; risk: invalid path on Unix; invariant: skip; strategy: early return.
            print("???  Skipping Terminal profile removal (non-Windows).")
            return
        try:
            import json
            settings_path = self._get_windows_terminal_settings_path()

            if not settings_path.exists():
                # //audit assumption: settings path missing; risk: no Windows Terminal; invariant: skip; strategy: early return.
                print("   ??  Windows Terminal not found")
                return

            print("???  Removing Terminal profile...")

            # Load settings
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)

            # Remove ARCANOS profile
            profiles = settings.get("profiles", {}).get("list", [])
            new_profiles = [p for p in profiles if p.get("name") != "ARCANOS"]

            if len(new_profiles) < len(profiles):
                # //audit assumption: ARCANOS profile found; risk: invalid settings schema; invariant: update list; strategy: overwrite profiles list.
                settings["profiles"]["list"] = new_profiles

                # Save settings
                with open(settings_path, "w", encoding="utf-8") as f:
                    json.dump(settings, f, indent=4)

                print("   ? Terminal profile removed")
            else:
                # //audit assumption: profile missing; risk: false negative; invariant: notify user; strategy: log skip.
                print("   ??  Terminal profile not found")

        except Exception as e:
            print(f"   ??  Failed to remove Terminal profile: {e}")

    def backup_user_data(self, backup_path: Path) -> bool:
        """
        Backup user data (memories, settings, logs)
        Returns:
            True if successful
        """
        try:
            print(f"?? Backing up user data to: {backup_path}")
            backup_path.mkdir(parents=True, exist_ok=True)

            # Backup memories
            if Config.MEMORY_FILE.exists():
                # //audit assumption: memory file exists; risk: missing file; invariant: copy; strategy: copy to backup.
                shutil.copy2(Config.MEMORY_FILE, backup_path / "memories.json")
                print("   ? Backed up memories")

            # Backup .env
            env_file = Config.BASE_DIR / ".env"
            if env_file.exists():
                # //audit assumption: .env exists; risk: missing file; invariant: copy config; strategy: copy to backup.
                shutil.copy2(env_file, backup_path / ".env")
                print("   ? Backed up configuration")

            # Backup logs
            if Config.LOG_DIR.exists():
                # //audit assumption: log dir exists; risk: empty dir; invariant: copy tree; strategy: copytree.
                shutil.copytree(Config.LOG_DIR, backup_path / "logs", dirs_exist_ok=True)
                print("   ? Backed up logs")

            print(f"? Backup complete: {backup_path}")
            return True

        except Exception as e:
            print(f"? Backup failed: {e}")
            return False

    def remove_all_data(self) -> None:
        """Remove all ARCANOS data (destructive!)"""
        print("???  Removing all data...")

        # Remove memories
        if Config.MEMORY_FILE.exists():
            # //audit assumption: memory file exists; risk: unlink failure; invariant: delete; strategy: unlink file.
            Config.MEMORY_FILE.unlink()
            print("   ? Removed memories")

        # Remove logs
        if Config.LOG_DIR.exists():
            # //audit assumption: log dir exists; risk: rmtree failure; invariant: delete; strategy: rmtree.
            shutil.rmtree(Config.LOG_DIR)
            print("   ? Removed logs")

        # Remove screenshots
        if Config.SCREENSHOT_DIR.exists():
            # //audit assumption: screenshot dir exists; risk: rmtree failure; invariant: delete; strategy: rmtree.
            shutil.rmtree(Config.SCREENSHOT_DIR)
            print("   ? Removed screenshots")

        # Remove crash reports
        if Config.CRASH_REPORTS_DIR.exists():
            # //audit assumption: crash dir exists; risk: rmtree failure; invariant: delete; strategy: rmtree.
            shutil.rmtree(Config.CRASH_REPORTS_DIR)
            print("   ? Removed crash reports")

        # Remove telemetry
        if Config.TELEMETRY_DIR.exists():
            # //audit assumption: telemetry dir exists; risk: rmtree failure; invariant: delete; strategy: rmtree.
            shutil.rmtree(Config.TELEMETRY_DIR)
            print("   ? Removed telemetry")

    def uninstall(self, backup: bool = True) -> None:
        """
        Complete uninstallation
        Args:
            backup: Whether to backup user data before removal
        """
        print("\n" + "="*50)
        print("???  ARCANOS UNINSTALLER")
        print("="*50 + "\n")

        # Confirm
        print("??  This will remove ARCANOS from your system.")
        if self._is_windows:
            # //audit assumption: Windows-specific artifacts exist; risk: missing shortcuts; invariant: warn user; strategy: print Windows items.
            print("   - Windows shortcuts")
            print("   - Terminal profile")
        print("   - All data and settings" + (" (after backup)" if backup else ""))

        confirm = input("\nAre you sure? Type 'UNINSTALL' to confirm: ").strip()
        if confirm != "UNINSTALL":
            # //audit assumption: confirmation mismatch; risk: accidental uninstall; invariant: cancel; strategy: return early.
            print("? Uninstall cancelled")
            return

        # Backup if requested
        if backup:
            # //audit assumption: backup requested; risk: backup failure; invariant: attempt backup; strategy: run backup first.
            backup_path = Path.home() / "Desktop" / "ARCANOS_Backup"
            self.backup_user_data(backup_path)

        # Remove components
        self.remove_shortcuts()
        self.remove_terminal_profile()
        self.remove_all_data()

        print("\n" + "="*50)
        print("? ARCANOS has been uninstalled")
        print("="*50)

        if backup:
            # //audit assumption: backup requested; risk: missing backup_path; invariant: report location; strategy: print path.
            print(f"\n?? Your data was backed up to:")
            print(f"   {backup_path}")

        print("\n?? Thank you for using ARCANOS!")


if __name__ == "__main__":
    uninstaller = Uninstaller()
    uninstaller.uninstall(backup=True)
