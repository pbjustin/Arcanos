"""
Terminal Control for ARCANOS
Execute shell commands with security checks across Windows/macOS/Linux.
When RUN_ELEVATED=true, uses UAC elevation on Windows and sudo on Unix-like systems.
"""

import base64
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from typing import Optional, Tuple

from .config import Config
from .debug_logging import log_audit_event
from .error_handler import handle_errors


class TerminalController:
    """Handles safe execution of terminal commands"""

    def __init__(self):
        self.dangerous_commands = Config.get_dangerous_commands()
        self.whitelist = Config.COMMAND_WHITELIST
        self.allow_dangerous = Config.ALLOW_DANGEROUS_COMMANDS

    def _normalize_shell_name(self, shell: str) -> str:
        """
        Purpose: Normalize a shell string to a canonical name for command construction.
        Inputs/Outputs: raw shell string; returns normalized shell token.
        Edge cases: Handles full paths and .exe suffixes.
        """
        raw = shell.strip()
        # //audit assumption: shell may be a full path; risk: wrong basename; invariant: basename extracted; strategy: normalize via os.path.basename.
        name = os.path.basename(raw).lower()
        if name.endswith(".exe"):
            # //audit assumption: Windows shell names end with .exe; risk: mismatched detection; invariant: .exe stripped; strategy: trim suffix.
            name = name[:-4]
        if name in ("pwsh", "powershell"):
            return "powershell"
        if name in ("cmd", "cmd.exe"):
            return "cmd"
        return name

    def _detect_shell(self) -> str:
        """
        Purpose: Detect the appropriate shell for the current platform.
        Inputs/Outputs: None; returns shell string or path.
        Edge cases: Honors ARCANOS_SHELL override; falls back to cmd/sh if preferred shell missing.
        """
        # Prefer Config if available (adapter boundary pattern)
        # TODO: Add ARCANOS_SHELL to Config class
        shell_override = getattr(Config, "ARCANOS_SHELL", None) or os.getenv("ARCANOS_SHELL")
        if shell_override:
            # //audit assumption: override provided by user; risk: invalid shell; invariant: user intent respected; strategy: return override.
            return shell_override

        system = platform.system().lower()
        if system == "windows":
            # //audit assumption: PowerShell exists on Windows; risk: missing pwsh/powershell; invariant: fallback to cmd; strategy: check availability.
            if shutil.which("powershell"):
                return "powershell"
            if shutil.which("pwsh"):
                return "pwsh"
            return "cmd"

        # //audit assumption: bash preferred on Unix; risk: bash missing; invariant: fallback to sh; strategy: probe for bash.
        if shutil.which("bash"):
            return "bash"
        return "sh"

    def _build_shell_command(self, shell: str, command: str) -> list[str]:
        """
        Purpose: Build a subprocess command list for the requested shell.
        Inputs/Outputs: shell name/path and command; returns argv list.
        Edge cases: Unsupported shells raise ValueError.
        """
        normalized = self._normalize_shell_name(shell)
        # //audit assumption: normalized shell governs invocation; risk: unsupported shell; invariant: raise on unknown; strategy: match known shells.
        if normalized == "powershell":
            return [shell, "-Command", command]
        if normalized == "cmd":
            return [shell, "/c", command]
        if normalized in {"bash", "sh", "zsh", "fish", "ksh", "dash"}:
            return [shell, "-c", command]
        raise ValueError(f"Unsupported shell: {shell}. Set ARCANOS_SHELL to a valid shell.")

    def is_command_safe(self, command: str) -> Tuple[bool, Optional[str]]:
        """
        Check if command is safe to execute
        Returns: (is_safe, reason_if_not)
        """
        # Whitelist overrides everything
        if self.whitelist:
            # //audit assumption: whitelist present; risk: overly strict block; invariant: only whitelisted allowed; strategy: prefix match.
            for allowed_cmd in self.whitelist:
                if command.lower().startswith(allowed_cmd.lower()):
                    return True, None
            return False, f"Command not in whitelist. Allowed: {', '.join(self.whitelist)}"

        # Check dangerous commands
        if not self.allow_dangerous:
            # //audit assumption: dangerous commands blocked; risk: false positives; invariant: block known patterns; strategy: substring check.
            for dangerous_cmd in self.dangerous_commands:
                if dangerous_cmd.lower() in command.lower():
                    return False, f"Dangerous command detected: '{dangerous_cmd}'. Enable ALLOW_DANGEROUS_COMMANDS in .env to override."

        return True, None

    def _execute_elevated_windows(self, command: str, timeout: int) -> Tuple[Optional[str], Optional[str], int]:
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

    def _execute_elevated(self, command: str, shell: str, timeout: int) -> Tuple[Optional[str], Optional[str], int]:
        """
        Purpose: Execute a command with elevation on the current platform.
        Inputs/Outputs: command, shell, timeout; returns (stdout, stderr, return_code).
        Edge cases: Unix sudo may prompt for password; unsupported shells raise ValueError.
        """
        normalized = self._normalize_shell_name(shell)
        if sys.platform == "win32":
            # //audit assumption: Windows elevation supported for PowerShell and cmd; risk: unsupported shell; invariant: fail fast with clear message; strategy: validate shell.
            if normalized not in ("powershell", "cmd"):
                raise ValueError(
                    f"Elevated execution on Windows is only supported with PowerShell or cmd. "
                    f"Current shell: {shell} (normalized: {normalized}). "
                    f"Set ARCANOS_SHELL=powershell or ARCANOS_SHELL=cmd to use elevated commands."
                )
            if normalized == "cmd":
                # cmd elevation uses runas - convert to PowerShell for consistency
                # Note: cmd elevation is less reliable, prefer PowerShell
                raise ValueError(
                    "Elevated execution with cmd is not fully supported. "
                    "Please use PowerShell (set ARCANOS_SHELL=powershell) for elevated commands."
                )
            return self._execute_elevated_windows(command, timeout)

        # //audit assumption: sudo available on Unix; risk: sudo missing or requires TTY; invariant: attempt sudo; strategy: wrap shell command.
        full_command = ["sudo"] + self._build_shell_command(shell, command)
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
            raise RuntimeError(f"Failed to execute elevated command: {str(e)}")

    @handle_errors("executing command")
    def execute(
        self,
        command: str,
        shell: Optional[str] = None,
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
            elevated: If True, run with elevation (UAC on Windows, sudo on Unix)
        Returns:
            (stdout, stderr, return_code)
        """
        # Calculate command hash for audit logging (never log raw command)
        command_hash = hashlib.sha256(command.encode()).hexdigest()
        
        # Safety check
        if check_safety:
            is_safe, reason = self.is_command_safe(command)
            if not is_safe:
                # Audit log: command blocked
                log_audit_event(
                    "command_attempt",
                    command_hash=command_hash,
                    command_length=len(command),
                    safe=False,
                    reason_if_blocked=reason,
                    source="terminal",
                    outcome="blocked"
                )
                raise ValueError(reason)
        
        # Audit log: command attempt (before execution)
        log_audit_event(
            "command_attempt",
            command_hash=command_hash,
            command_length=len(command),
            safe=True,
            source="terminal",
            outcome="attempting"
        )

        if shell is None:
            # //audit assumption: caller wants auto-detected shell; risk: wrong shell; invariant: detected shell used; strategy: detect now.
            shell = self._detect_shell()

        # Elevated path: platform-aware
        if elevated:
            # //audit assumption: elevated execution requested; risk: sudo/UAC prompt; invariant: run elevated; strategy: route to elevation handler.
            try:
                stdout, stderr, return_code = self._execute_elevated(command, shell, timeout)
                # Audit log: elevated command execution completed
                log_audit_event(
                    "command_executed",
                    command_hash=command_hash,
                    command_length=len(command),
                    safe=True,
                    source="terminal",
                    outcome="completed",
                    return_code=return_code,
                    elevated=True
                )
                return stdout, stderr, return_code
            except Exception as e:
                # Audit log: elevated command execution error
                log_audit_event(
                    "command_executed",
                    command_hash=command_hash,
                    command_length=len(command),
                    safe=True,
                    source="terminal",
                    outcome="error",
                    error_type=type(e).__name__,
                    elevated=True
                )
                raise

        # Prepare command based on shell
        full_command = self._build_shell_command(shell, command)

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
            # Audit log: command timeout
            log_audit_event(
                "command_executed",
                command_hash=command_hash,
                command_length=len(command),
                safe=True,
                source="terminal",
                outcome="timeout",
                return_code=None
            )
            raise TimeoutError(f"Command timed out after {timeout} seconds")
        except Exception as e:
            # Audit log: command execution error
            log_audit_event(
                "command_executed",
                command_hash=command_hash,
                command_length=len(command),
                safe=True,
                source="terminal",
                outcome="error",
                error_type=type(e).__name__
            )
            raise RuntimeError(f"Failed to execute command: {str(e)}")

    @handle_errors("executing PowerShell")
    def execute_powershell(
        self, command: str, timeout: int = 30, elevated: bool = False
    ) -> Tuple[Optional[str], Optional[str], int]:
        """
        Purpose: Execute a PowerShell command on Windows; use bash/sh on Unix.
        Inputs/Outputs: command, timeout, elevated; returns (stdout, stderr, return_code).
        Edge cases: Falls back to sh when bash missing on Unix.
        """
        # Prefer Config if available (adapter boundary pattern)
        shell_override = getattr(Config, "ARCANOS_SHELL", None) or os.getenv("ARCANOS_SHELL")
        if shell_override:
            # //audit assumption: override provided; risk: mismatch with method name; invariant: respect override; strategy: delegate to execute.
            return self.execute(command, shell=shell_override, timeout=timeout, elevated=elevated)

        if sys.platform == "win32":
            # //audit assumption: PowerShell available on Windows; risk: missing powershell binary; invariant: try powershell; strategy: fallback to pwsh/cmd.
            shell = "powershell"
            if not shutil.which("powershell") and shutil.which("pwsh"):
                shell = "pwsh"
            return self.execute(command, shell=shell, timeout=timeout, elevated=elevated)

        # //audit assumption: Unix uses bash/sh; risk: bash missing; invariant: fallback to sh; strategy: probe availability.
        shell = "bash" if shutil.which("bash") else "sh"
        return self.execute(command, shell=shell, timeout=timeout, elevated=elevated)

    @handle_errors("executing CMD")
    def execute_cmd(self, command: str, timeout: int = 30) -> Tuple[Optional[str], Optional[str], int]:
        """
        Purpose: Execute CMD on Windows; use sh on Unix.
        Inputs/Outputs: command, timeout; returns (stdout, stderr, return_code).
        Edge cases: Falls back to bash if sh unavailable.
        """
        if sys.platform == "win32":
            # //audit assumption: cmd available on Windows; risk: missing cmd; invariant: try cmd; strategy: fallback to powershell.
            shell = "cmd"
            if not shutil.which("cmd") and shutil.which("powershell"):
                shell = "powershell"
            return self.execute(command, shell=shell, timeout=timeout)

        # //audit assumption: sh available on Unix; risk: sh missing; invariant: fallback to bash; strategy: probe availability.
        shell = "sh" if shutil.which("sh") else "bash"
        return self.execute(command, shell=shell, timeout=timeout)

    def get_dangerous_commands(self) -> list[str]:
        """Get list of dangerous commands"""
        return self.dangerous_commands

    def add_to_blacklist(self, command: str) -> None:
        """Add command to blacklist"""
        if command not in self.dangerous_commands:
            self.dangerous_commands.append(command)
