import os
import subprocess
from pathlib import Path


class ContextScanner:

    @staticmethod
    def get_directory_tree(path: str = ".", max_depth: int = 2) -> str:
        """
        Purpose: Build a bounded-depth directory tree snapshot for prompt context.
        Inputs/Outputs: root path and max depth; returns a newline-delimited tree string.
        Edge cases: Filesystem access failures return a stable fallback message.
        """
        try:
            # Simple recursive listing
            lines = []
            base_path = Path(path).resolve()
            for root, dirs, files in os.walk(base_path):
                depth = len(Path(root).relative_to(base_path).parts)
                if depth >= max_depth:
                    continue
                indent = "  " * depth
                lines.append(f"{indent}{os.path.basename(root)}/")
                for f in files[:10]:  # Limit files per dir
                    lines.append(f"{indent}  {f}")
            return "\n".join(lines)
        except OSError as error:
            # //audit Assumption: scan may hit permission/path issues; risk: scan crash blocks request; invariant: stable fallback text; handling: log and degrade gracefully.
            print(f"[ERROR] Unable to scan directory tree at '{path}': {error}")
            return "Unable to scan directory."

    @staticmethod
    def get_git_status() -> str:
        """
        Purpose: Retrieve concise git status metadata for local context.
        Inputs/Outputs: None; returns short git status output or fallback message.
        Edge cases: Missing git binary, timeouts, or non-repo paths return safe fallbacks.
        """
        try:
            result = subprocess.run(
                ["git", "status", "--short"],
                capture_output=True,
                text=True,
                timeout=2
            )
            return result.stdout if result.returncode == 0 else "Not a git repo."
        except subprocess.TimeoutExpired as error:
            # //audit Assumption: git status can hang in large repos; risk: request latency spike; invariant: bounded call duration; handling: timeout fallback.
            print(f"[ERROR] Git status timed out: {error}")
            return "Git status timed out."
        except FileNotFoundError as error:
            # //audit Assumption: git may be unavailable in minimal environments; risk: missing context; invariant: explicit fallback; handling: log and return unavailable marker.
            print(f"[ERROR] Git executable not found: {error}")
            return "Git not available."
        except OSError as error:
            # //audit Assumption: subprocess invocation may fail for OS reasons; risk: unhandled exception; invariant: fallback string; handling: log and degrade.
            print(f"[ERROR] Git status failed: {error}")
            return "Git not available."

    def scan(self) -> dict:
        """
        Purpose: Collect local runtime context used for escalation decisions.
        Inputs/Outputs: None; returns dictionary with cwd, tree, git, and os metadata.
        Edge cases: Tree/git fields may contain fallback messages on local failures.
        """
        return {
            "cwd": os.getcwd(),
            "tree": self.get_directory_tree(),
            "git": self.get_git_status(),
            "os": os.name,
        }
