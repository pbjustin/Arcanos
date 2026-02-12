import os
import subprocess
from pathlib import Path


class ContextScanner:

    @staticmethod
    def get_directory_tree(path: str = ".", max_depth: int = 2) -> str:
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
        except Exception:
            return "Unable to scan directory."

    @staticmethod
    def get_git_status() -> str:
        try:
            result = subprocess.run(
                ["git", "status", "--short"],
                capture_output=True,
                text=True,
                timeout=2
            )
            return result.stdout if result.returncode == 0 else "Not a git repo."
        except Exception:
            return "Git not available."

    def scan(self) -> dict:
        return {
            "cwd": os.getcwd(),
            "tree": self.get_directory_tree(),
            "git": self.get_git_status(),
            "os": os.name,
        }
