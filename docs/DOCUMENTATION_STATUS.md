# Arcanos Documentation Status

> **Last Updated:** 2025-02-14 | **Audit Cycle:** 2025-Q1 | **Version:** 2.0.0

## Overview

This document tracks the current state of documentation coverage across the Arcanos repository.
It is updated as each audit pass standardizes documentation to the required structure and
verifies accuracy against the current codebase.

**Current status:** ⏳ In progress. The documentation set is being standardized across multiple
passes, starting with deployment and Railway compatibility guides.

## Prerequisites

- Familiarity with the repository structure and the `docs/` directory.
- Access to the current codebase for verifying doc statements.

## Setup

When updating documentation:

1. Audit each document against the current code and config files.
2. Rewrite the content into the standard structure:
   **Overview → Prerequisites → Setup → Configuration → Run locally → Deploy (Railway) → Troubleshooting → References**.
3. Add TODO notes for any sections that cannot be verified immediately.
4. Record the update in the Audit Records section (below) for traceability.

## Configuration

Primary sources of truth for configuration details:

- `docs/CONFIGURATION.md`
- `.env.example`
- `railway.json`

## Run locally

See `README.md` for validated local run instructions, including build and start commands.

## Deploy (Railway)

Railway deployment guidance lives in `docs/RAILWAY_DEPLOYMENT.md`, which is the canonical
reference for build/start commands, environment variables, and rollback steps.

## Troubleshooting

### Known gaps / TODOs

- **TODO:** Standardize remaining docs under `docs/`, `.github/`, and root-level markdown to the
  required structure.
- **TODO:** Re-validate OpenAI SDK usage examples in legacy docs for v6.16.0 alignment.
- **TODO:** Confirm any historical/legacy documentation is clearly labeled and separated.

### Audit Records (latest pass)

- **2025-02-14:** Standardized deployment and Railway compatibility docs (`docs/RAILWAY_DEPLOYMENT.md`,
  `DEPLOYMENT_GUIDE.md`, `RAILWAY_COMPATIBILITY_GUIDE.md`).

## References

- `docs/README.md` - Documentation index
- `docs/RAILWAY_DEPLOYMENT.md` - Railway deployment guide
- `docs/CONFIGURATION.md` - Environment variable reference
- `README.md` - Root overview and SDK examples
