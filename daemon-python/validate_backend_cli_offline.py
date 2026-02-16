"""
Compatibility entrypoint for offline backend/CLI validation.

Purpose:
- Preserve existing command usage (`python validate_backend_cli_offline.py`).
- Delegate to canonical validator module under `scripts/`.
"""

from __future__ import annotations

from scripts.validate_backend_cli_offline import main


if __name__ == "__main__":
    raise SystemExit(main())

