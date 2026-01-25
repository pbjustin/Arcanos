"""
Terminal Control for ARCANOS
Execute PowerShell/CMD commands with security checks.
When RUN_ELEVATED=true, PowerShell runs via Start-Process -Verb RunAs (UAC) on Windows.
"""

import base64
import os
import subprocess
import sys
import tempfile
from typing import Optional, Tuple

from config import Config
from error_handler import handle_errors


class TerminalController:
    """Handles safe execution of terminal commands"""

    def __init__(self):
        self.dangerous_commands = Config.get_dangerous_commands()
        self.whitelist = Config.COMMAND_WHITELIST
        self.allow_dangerous = Config.ALLOW_DANGEROUS_COMMANDS

    def is_command_safe(self, command: str) -> Tuple[bool, Optional[str]]:
        """
        Check if command is safe to execute
        Returns: (is_safe, reason_if_not)
        """
        # Whitelist overrides everything
        if self.whitelist:
            for allowed_cmd in self.whitelist:
                if command.lower().startswith(allowed_cmd.lower()):
                    return True, None
            return False, f"Command not in whitelist. Allowed: {', '.join(self.whitelist)}"

        # Check dangerous commands
        if not self.allow_dangerous:
            for dangerous_cmd in self.dangerous_commands:
                if dangerous_cmd.lower() in command.lower():
                    return False, f"Dangerous command detected: '{dangerous_cmd}'. Enable ALLOW_DANGEROUS_COMMANDS in .env to override."

        return True, None

    def _execute_elevated_powershell(self, command: str, timeout: int) -> Tuple[Optional[str], Optional[str], int]:
        """
        Run PowerShell elevated via Start-Process -Verb RunAs on Windows.
        Uses temp files for stdout, stderr, and exit code. UAC prompt when RunAs.
        """
        fd_out, p_out = tempfile.mkstemp(suffix=".txt", prefix="arcanos_out_")
        os.close(fd_out)
        fd_err, p_err = tempfile.mkstemp(suffix=".txt", prefix="arcanos_err_")
        os.close(fd_err)
        fd_rc, p_rc = tempfile.mkstemp(suffix=".txt", prefix="arcanos_rc_")
        os.close(fd_rc)
        try:
            b64 = base64.b64encode(command.encode("utf-8")).decode("ascii")
            # Escape single quotes for PowerShell: ' -> ''
            def q(s: str) -> str:
                return s.replace("'", "''")
            ps_script = f"""
& {{
  $out = '{q(p_out)}'
  $err = '{q(p_err)}'
  $rc  = '{q(p_rc)}'
  $b64 = '{q(b64)}'
  $cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
  $p = Start-Process powershell -ArgumentList '-NoProfile','-NonInteractive','-Command',$cmd -Verb RunAs -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $p.ExitCode | Set-Content -Path $rc
}}
"""
            subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
                capture_output=True,
                timeout=timeout,
                encoding="utf-8",
                errors="replace",
                cwd=os.getcwd(),
            )
            with open(p_out, "r", encoding="utf-8", errors="replace") as f:
                stdout = f.read().strip()
            with open(p_err, "r", encoding="utf-8", errors="replace") as f:
                stderr = f.read().strip()
            with open(p_rc, "r", encoding="utf-8", errors="replace") as f:
                rc_s = f.read().strip()
            return_code = int(rc_s) if (rc_s and rc_s.strip().isdigit()) else 1
            return (stdout or None, stderr or None, return_code)
        except subprocess.TimeoutExpired:
            raise TimeoutError(f"Command timed out after {timeout} seconds")
        except Exception as e:
            raise RuntimeError(f"Elevated run failed: {e}")
        finally:
            for p in (p_out, p_err, p_rc):
                try:
                    os.unlink(p)
                except OSError:
                    pass

    @handle_errors("executing command")
    def execute(
        self,
        command: str,
        shell: str = "powershell",
        timeout: int = 30,
        check_safety: bool = True,
        elevated: bool = False,
    ) -> Tuple[Optional[str], Optional[str], int]:
        """
        Execute a terminal command.
        Args:
            command: Command to execute
            shell: Shell to use ('powershell' or 'cmd')
            timeout: Command timeout in seconds
            check_safety: Whether to check command safety
            elevated: If True and Windows+PowerShell, run via Start-Process -Verb RunAs (UAC)
        Returns:
            (stdout, stderr, return_code)
        """
        # Safety check
        if check_safety:
            is_safe, reason = self.is_command_safe(command)
            if not is_safe:
                raise ValueError(reason)

        # Elevated path: Windows + PowerShell only
        if elevated and sys.platform == "win32" and shell.lower() == "powershell":
            return self._execute_elevated_powershell(command, timeout)

        # Prepare command based on shell
        if shell.lower() == "powershell":
            full_command = ["powershell", "-Command", command]
        elif shell.lower() == "cmd":
            full_command = ["cmd", "/c", command]
        else:
            raise ValueError(f"Unsupported shell: {shell}. Use 'powershell' or 'cmd'.")

        # Execute command
        try:
            result = subprocess.run(
                full_command,
                capture_output=True,
                text=True,
                timeout=timeout,
                encoding="utf-8",
                errors="replace",
            )
            stdout = result.stdout.strip()
            stderr = result.stderr.strip()
            return_code = result.returncode
            return stdout, stderr, return_code
        except subprocess.TimeoutExpired:
            raise TimeoutError(f"Command timed out after {timeout} seconds")
        except Exception as e:
            raise RuntimeError(f"Failed to execute command: {str(e)}")

    @handle_errors("executing PowerShell")
    def execute_powershell(
        self, command: str, timeout: int = 30, elevated: bool = False
    ) -> Tuple[Optional[str], Optional[str], int]:
        """Execute PowerShell command (convenience wrapper)."""
        return self.execute(command, shell="powershell", timeout=timeout, elevated=elevated)

    @handle_errors("executing CMD")
    def execute_cmd(self, command: str, timeout: int = 30) -> Tuple[Optional[str], Optional[str], int]:
        """Execute CMD command (convenience wrapper)"""
        return self.execute(command, shell="cmd", timeout=timeout)

    def get_dangerous_commands(self) -> list[str]:
        """Get list of dangerous commands"""
        return self.dangerous_commands

    def add_to_blacklist(self, command: str) -> None:
        """Add command to blacklist"""
        if command not in self.dangerous_commands:
            self.dangerous_commands.append(command)
