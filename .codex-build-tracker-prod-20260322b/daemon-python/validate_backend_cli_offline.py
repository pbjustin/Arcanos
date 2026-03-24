"""
Compatibility entrypoint for offline backend/CLI validation.

Purpose:
- Preserve existing command usage (`python validate_backend_cli_offline.py`).
- Delegate to canonical validator module under `scripts/offline_backend_cli_validator.py`.
"""

from __future__ import annotations

from scripts.offline_backend_cli_validator import main


if __name__ == "__main__":
    raise SystemExit(main())
