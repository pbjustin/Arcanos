# Historical ingestion status fixtures

`records.json` contains synthetic queued bodies emitted by the committed approved-ingestion producer and CLEAR assessment factory at each retained policy version. These are **derived from historical producer source**, not exported production/database records. The fixture manifest records full commit and source blob IDs.

| CLEAR policy | Historical producer commit | Source policy |
| --- | --- | --- |
| v1 | `ca45f623686b1cd24a6c49a3fd935d85dcdfb045` | v1 |
| v2 | `8186e253bf02d2f0d0a0dc32a7bf7bb769c75f15` | v2 |
| v3 | `e5c88eae1a2a860dc98384eb61ff30275f9ad00d` | v2 |
| v4 | `741b00a8236f66c02beec700f68a9e1aa42e95b7` | v2 |
| v5 | `cd8da15369421119f5d836e6eef7f7c18dff7e0f` | v2 |

The v1 body predates applicability context/binding; v2-v5 producers emit those fields. All five use `gaming-hybrid-freshness-v1`, `gaming-hybrid-candidates/v1`, and the `gaming-clear/v1` wire rubric. No retained policy version is missing from this source-derived matrix. It does not claim to enumerate every historical producer revision or the contents of a real retained row.

To regenerate offline, with these commits available in Git history and the pinned Node/dependencies installed, run `node tests/fixtures/gaming-historical-status/generate.mjs`. The generator selects original declarations using TypeScript's parser, executes their pure assessment factory and approved-source mapping, and validates with the original assessment/body schemas using the bundled Zod 3 compatibility export. It supplies synthetic content/context and captures URL admission/enqueue instead of running historical network, repository, or worker code. Unused question classification and registry-context creation are excluded. Generation does not alter any application state.

The acceptance suite wraps these authentic queued bodies in actor-bound job records and repository doubles to exercise each public status transition, retained approval stripping, and strict current execution separately. This is service-boundary acceptance; it is not PostgreSQL persistence or live-provider acceptance.

`tests/integration/gaming-historical-status.pg18.integration.test.ts` separately
persists these source-derived bodies and current v6 bodies through the real job
repository in an isolated PostgreSQL 18 schema. It exercises real status reads,
actor isolation, execution refusal, current source persistence, idempotency,
expiry cleanup and stored-evidence coverage. The existing guarded durable-RAG
suite supplies additional real source/revision/catalog/lexical retrieval checks.
Use only the dedicated loopback `JOB_CLAIM_FENCING_TEST_DATABASE_URL` accepted by
`tests/integration/postgresTestDatabase.ts`; set
`ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1` to forbid silent skipping. The new
suite is included in the existing `test:postgres-fencing` CI command. These tests
perform real SQL operations on synthetic rows; they do not read production data
or run a background worker loop, live provider, or Railway deployment.
