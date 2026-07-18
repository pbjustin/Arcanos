# Gate V draft — not ready to request

Gate V is blocked until Gate R containment and Gate C re-verification complete.
The corrected target also requires a GitHub-triggered deployment whose
Railway-provided source commit exactly matches the approved commit; a separate
Gate G push approval is therefore a prerequisite.

Committed, inert one-shot targets now exist for plan, apply, migration verify,
runtime verify, drain, and the disposable-schema PostgreSQL 18 suite. They use
operation-specific Railway config files, restart policy `NEVER`, a pre-Node
injection guard, fixed safe output, and explicit process exit. No local
container runtime exists, so neither validator image has been built locally and
the PostgreSQL 18 target has not run against a real server.

When ready, the bounded service may receive only these non-system variables:

- `DATABASE_URL` as a private reference to the replacement PostgreSQL service
- `PHASE2E_VALIDATOR_EXPECTED_DATABASE_HOST`
- `PHASE2E_VALIDATOR_EXPECTED_DATABASE_NAME`
- `PHASE2E_VALIDATOR_EXPECTED_SERVICE_ID`
- `PHASE2E_VALIDATOR_EXPECTED_SERVICE_NAME`
- `PHASE2E_VALIDATOR_EXPECTED_SOURCE_COMMIT`

The PostgreSQL 18 integration target additionally requires exactly:

- `ACTION_PLAN_EXECUTION_PG18_INTEGRATION=1`
- `ACTION_PLAN_EXECUTION_PG18_RAILWAY_VALIDATION=1`

The permitted custom config paths are:

- `/railway.phase2e-validator.json` for plan
- `/railway.phase2e-validator.apply.json` for apply
- `/railway.phase2e-validator.verify.json` for migration verification
- `/railway.phase2e-validator.runtime-verify.json` for runtime verification
- `/railway.phase2e-validator.drain.json` for drain
- `/railway.phase2e-validator.pg18-integration.json` for the disposable suite

The default `/railway.json` target is forbidden. Each deployment must prove the
custom config source, exact service identity, exact source commit, expected
private database host/name, connected database, `public` schema, and PostgreSQL
18 before database work. The Phase 2D.1 compatibility service must use
`/railway.phase2d1-compatibility-validator.json` from its separately approved
exact commit.

No target exposes compensation, an application server, worker, MCP, Python,
provider, bridge, healing loop, public domain, TCP proxy, or restart loop.
Exact service identities and deployment operations remain intentionally absent
until Gate R, Gate C re-verification, a local or approved image-build check, and
Gate G are complete.
