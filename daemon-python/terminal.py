"""
Terminal Control for ARCANOS
Execute PowerShell/CMD commands with security checks.
"""

import subprocess
import shlex
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

    @handle_errors("executing command")
    def execute(
        self,
        command: str,
        shell: str = "powershell",
        timeout: int = 30,
        check_safety: bool = True
    ) -> Tuple[Optional[str], Optional[str], int]:
        """
        Execute a terminal command
        Args:
            command: Command to execute
            shell: Shell to use ('powershell' or 'cmd')
            timeout: Command timeout in seconds
            check_safety: Whether to check command safety
        Returns:
            (stdout, stderr, return_code)
        """
        # Safety check
        if check_safety:
            is_safe, reason = self.is_command_safe(command)
            if not is_safe:
                raise ValueError(reason)

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
                encoding='utf-8',
                errors='replace'
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
    def execute_powershell(self, command: str, timeout: int = 30) -> Tuple[Optional[str], Optional[str], int]:
        """Execute PowerShell command (convenience wrapper)"""
        return self.execute(command, shell="powershell", timeout=timeout)

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
