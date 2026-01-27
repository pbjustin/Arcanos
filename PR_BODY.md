## Overview

Make the Python daemon cross-platform and pip-installable, remove Windows-only dependencies, and align docs/tests/builds.

## Changes

- Package the daemon under `daemon-python/arcanos` with `pyproject.toml`; move assets/memory into the package.
- Remove Windows-only integrations and dependencies; make uninstall and terminal execution cross-platform.
- Add shell auto-detection and `ARCANOS_SHELL` override; keep sudo behavior on Unix.
- Update config base-dir resolution and CLI/docs usage to `python -m arcanos.cli`.
- Replace print statements in daemon polling with `error_logger` for consistent logging.
- Fix Jest teardown by lazy-loading GPT module map; update cross-codebase sync script path checks.

## Testing

- `python -m pytest tests/test_daemon.py -q`
- `npm test -- --runInBand`
- `npm run build`
