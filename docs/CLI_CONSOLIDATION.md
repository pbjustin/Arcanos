# CLI Consolidation Decision

## Decision
- Canonical CLI runtime path: `daemon-python/arcanos/cli/`.
- Canonical governance primitives: `daemon-python/arcanos/cli/{audit,execute,governance,idempotency,startup,trust_state}.py`.
- Backend/CLI contract source of truth: `contracts/backend_cli_contract.v1.json`.

## Legacy Zones
- `cli/` at repository root is legacy and should not receive new business logic.
- `cli_v2/` is experimental and must not be imported by production daemon modules.
- `daemon-python/arcanos/cli_*.py` remains transitional; new CLI orchestration logic belongs in `daemon-python/arcanos/cli/`.

## Enforcement
- Node validator: `npm run validate:backend-cli:contract`.
- Python validator: `python daemon-python/validate_backend_cli_offline.py`.
- CI runs contract validation in `.github/workflows/ci-cd.yml`.

