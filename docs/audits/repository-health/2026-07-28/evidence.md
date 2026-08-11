# Repository health-audit evidence ledger

Last reconciled: 2026-08-11 UTC, after audit-scoped product PR #1427 and
delivery-control PRs #1428–#1430 merged, and exact #1430 was automatically
promoted as one web/worker pair

This ledger records durable delivery identities and bounded proof. It does not
turn local, preview, merge, or CI evidence into production credit. Current
tracked source, live PR metadata, required CI, and freshly read provider state
remain authoritative.

## Evidence levels

| Level | What it can establish | What it cannot establish |
| --- | --- | --- |
| Local candidate | Source behavior under the named commands and environment | Publication, merge, deployment, or live provider behavior |
| Published draft | Branch, commit, and draft-PR identity | Completed review, terminal required CI, merge, deployment, or production behavior |
| Reviewed PR head | Exact published source plus surfaced PR checks/reviews | Merge or production rollout |
| Contained preview | Served commit identity and the explicitly exposed sealed/read-only contract | Normal production handlers, credentials, provider calls, PostgreSQL behavior unless specifically connected, or production state |
| Exact merge | Source/tree integrated into `main` plus exact-merge checks | Deployment unless an exact deployed revision is attested |
| Production verification | Only the exact target, revision, time, and contract observed under explicit authorization | Future state or unobserved paths |

## PRs #1428–#1430 — automatic paired production promotion

### Exact identities

| PR | Base | Final reviewed head | Merge | Reviewed/merged tree | Merge time | Size |
| --- | --- | --- | --- | --- | --- | --- |
| [#1428](https://github.com/pbjustin/Arcanos/pull/1428) | `2db3d41a58d9d34be6ee2119f7da9c0d682ac31e` | `fcabc28398c4f943fa9529bdb9b10570609d0b1f` | `c3763fe9a970503baab5f19f1fb1490b52abb622` | `ddfe9047d5060fd768ffa6b900da598b129a1c6f` | `2026-08-11T18:29:15Z` | 9 files; +505/-232 |
| [#1429](https://github.com/pbjustin/Arcanos/pull/1429) | `c3763fe9a970503baab5f19f1fb1490b52abb622` | `efe6e216d3fb9bba7d5d3dca56b5b301a0d56174` | `8361e37263d6b0a9c32c15b76c1999fd80bf98bb` | `947a39b7fa7983baaa7c402c8da8e3c592e56a6c` | `2026-08-11T19:10:10Z` | 6 files; +20/-5 |
| [#1430](https://github.com/pbjustin/Arcanos/pull/1430) | `8361e37263d6b0a9c32c15b76c1999fd80bf98bb` | `08bd9d2c15805a465700d5ea064b93f80cfd5613` | `98d6ad998e936d4db26b1330b28a9edff1331018` | `23a9f5e5853f60508b25b8f7e2148026304c98be` | `2026-08-11T19:50:47Z` | 3 files; +7/-3 |

### Merged contract

PR #1428 changed the tracked coordinated-writer hold to the exact inactive
sentinel `none` and replaced the former single-service/skipped path with one
serialized, worker-first pair. It requires explicit project and environment
identity, distinct web and worker service IDs, and a dedicated production
project-token secret. Before mutation it validates static Railway compatibility,
captures both exact active baselines, and checks each resolved role/readiness
target. Each detached upload returns one deployment ID which must reach
`SUCCESS`, remain the active non-stopped deployment, and pass the expected
role/readiness contract. Web is not enqueued until worker verification
completes; afterward both new IDs are checked together and the web-only
timeout/budget watchdog runs. Native Railway deployment triggers remain
disabled, avoiding duplicate independent service releases.

PR #1429 synchronized both repository-owned production web verifiers with the
current exact five-check `/readyz` projection: `openai`, `database`, `redis`,
`public-provider-admission`, and `startup`. It added unhealthy-admission
regressions, refreshed the pinned verifier digest, and corrected maintained
startup-readiness prose.

PR #1430 bounded detached-deployment polling to the newest 20 records while
preserving exact-ID selection, a 256 KiB subprocess-output limit, ten-second
polling, and a 45-minute elapsed-time budget. A live read of the long-lived
worker service measured those 20 records at 60,507 bytes and included the
just-enqueued exact ID. If an out-of-band race displaced the ID, observation
would remain `NOT_FOUND` and time out; it cannot approve another deployment.

### Local, review, and CI evidence

| Evidence | Result |
| --- | --- |
| PR #1428 local validation | Node 20.19 build, lint (zero errors; existing warnings only), four focused Railway suites / 80 tests, `validate:railway`, Documentation Audit 327/327, and `git diff --check` passed |
| PR #1428 review | Independent reviewers found no blocker. Copilot reviewed all nine files and generated no comments; no unresolved thread remained |
| PR #1428 final-head/merge | Required PR checks passed at `fcabc283`; exact-merge CI [`31522967337`](https://github.com/pbjustin/Arcanos/actions/runs/31522967337), Documentation Audit `31522967326`, and Repository Registration `31522967304` passed |
| PR #1429 local validation | Node 20.19 build, lint, six focused Railway suites / 142 tests, `validate:railway`, Documentation Audit 327/327, and `git diff --check` passed |
| PR #1429 review | Copilot's surfaced zero-comment review was attached to earlier three-file commit `f2e91a0c`, not final head. Independent final-head review found no blocker and no review thread remained |
| PR #1429 final-head/merge | All required checks passed at `efe6e216`; exact-merge CI [`31526489055`](https://github.com/pbjustin/Arcanos/actions/runs/31526489055), Documentation Audit `31526489036`, and Repository Registration `31526488968` passed |
| PR #1430 local validation | Node 20.19 build, lint, three focused rollout suites / 74 tests, `validate:railway`, Documentation Audit 327/327, and `git diff --check` passed |
| PR #1430 review | Copilot opened one thread asking the test to consume the exported 20-record contract. Final head `08bd9d2c` implemented it, refreshed the pinned digest, replied, and resolved thread `PRRT_kwDOPKkVZ86YWjo4`; independent final-head review found no blocker |
| PR #1430 final-head/merge | All PR checks passed, including Codecov patch, Railway Compatibility, Deployment Readiness, and All Checks Complete. Exact-merge CI [`31529904593`](https://github.com/pbjustin/Arcanos/actions/runs/31529904593) passed all 13 jobs; Documentation Audit `31529904589` and Repository Registration `31529904597` passed |

Auxiliary Analyze Documentation Updates runs `31522967336`, `31526489082`,
and `31529904611` each repeated the known missing
`ARCANOS_JOB_READ_CAPABILITY_SECRET` fixture failure. They did not replace the
green maintained Documentation Audit or required promotion gate.

### Fail-closed acceptance chronology

| Automatic run | Result |
| --- | --- |
| [#1428 merge run `31524244647`](https://github.com/pbjustin/Arcanos/actions/runs/31524244647) | Policy job `93888521085` passed. Production job `93888616857` failed in preflight with `RAILWAY_READINESS_RESPONSE_INVALID` because the verifier expected four names while the valid live web response exposed five. No deployment was enqueued; baselines worker `71f3c370-9054-43f7-a44f-dd37fe7e6147` and web `8fce3a96-e7c2-408c-9eae-f28e55dce823` remained active |
| [#1429 merge run `31527715994`](https://github.com/pbjustin/Arcanos/actions/runs/31527715994) | Policy job `93899996222` and paired-target preflight passed. Production job `93900055496` enqueued exact worker `1732d5d2-9433-4fbd-b2a0-db2e9534f87d`, then the first 100-record history poll exceeded 256 KiB and returned `RAILWAY_COMMAND_OUTPUT_LIMIT`. Web was not enqueued. The detached worker later became active; both roles stayed ready, and the revisions between old web/new worker changed no `src`, migration, package, worker, or runtime code |
| [#1430 merge run `31531116356`](https://github.com/pbjustin/Arcanos/actions/runs/31531116356) | Policy job `93911098579` and production job `93911152941` passed. The corrected observer tracked the exact worker and web through `INITIALIZING`/`BUILDING`/`DEPLOYING` to `SUCCESS`, joint active-ID verification passed, and the strict watchdog found no `/ask` timeout or budget-abort regression |

### Automatic production acceptance

Run `31531116356` started from exact merge
`98d6ad998e936d4db26b1330b28a9edff1331018` without manual dispatch. Preflight
recorded worker baseline `1732d5d2-9433-4fbd-b2a0-db2e9534f87d` and web
baseline `8fce3a96-e7c2-408c-9eae-f28e55dce823`. It activated:

- worker `d20a6833-2448-4677-89df-84e46a0d2567`, verified at
  `2026-08-11T20:08:40Z`; and
- web `e59f6a27-2d2a-4e24-b9e8-f9ba5d26dd41`, jointly verified with the
  worker at `2026-08-11T20:13:22Z`.

Both exact IDs were active on the same merge and passed role/readiness plus the
tracked `/readyz` and 60-second drain contract. The final watchdog scanned 500
web log lines over 15 minutes with strict budget-abort failure and reported no
`/ask` timeout regression. The run completed successfully at
`2026-08-11T20:13:27Z`.

Final provider readback found each as the sole active deployment, with worker
instance `eebcafd3-31f5-491e-bae6-30d60636a1f7` and web instance
`9bf8279c-37ad-4375-879d-82dabe34450e` both `RUNNING`. Both public `/readyz`
requests returned HTTP 200. Each exact active deployment manifest reported one
replica in `us-east4-eqdc4a`, `/readyz`, 300-second activation timeout,
60-second drain, and
`node scripts/start-railway-service-with-integrity.mjs`. The broader
environment-level base config still projects `/healthz` and the non-integrity
launcher; those base values do not override the effective checked-in manifest
captured on these exact deployments.

GitHub configuration readback retained canonical `RAILWAY_PROJECT_ID`,
`RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_WEB_SERVICE_ID`, and
`RAILWAY_WORKER_SERVICE_ID` variables and the dedicated
`RAILWAY_PRODUCTION_PROJECT_TOKEN` secret by name. The obsolete web-only
repository variable `RAILWAY_SERVICE_ID` was removed after acceptance. Both
Railway-native application deployment-trigger lists remain empty; GitHub is
the sole automatic path. No secret value was logged or committed.

This is exact paired-promotion, activation, readiness, and watchdog evidence.
It is not provider-atomicity, a measured rollback, database/retention behavior,
provider/model behavior, or live-memory behavior. Worker success followed by
web failure can still require reviewed forward completion or exact-baseline
restore; the workflow intentionally performs no guessed generic redeploy or
automatic code rollback across an unknown schema state.

## PR #1427 — successful non-GPT terminal retention

### Exact identity and contract

| Field | Value |
| --- | --- |
| Base | `b270997a356071fdfa63823ca67beabde897b67f` |
| Branch | `codex/non-gpt-terminal-retention-main` |
| Initial published head | `e09c73acbeda162d8b3d2bb4b8e81bfb2dc68616` |
| Final reviewed head | `0e3c1d6ebbb4523a71728f8b1d847b27ad23053a` |
| Merge | `2db3d41a58d9d34be6ee2119f7da9c0d682ac31e` |
| Reviewed/merged tree | `626e623852c70481cbb8a76b6ad9113631ddde18` |
| Merge time | `2026-08-11T07:16:23Z` |
| Size | 2 commits; 26 files; +2,291/-75 |
| Pull request | [#1427](https://github.com/pbjustin/Arcanos/pull/1427), merged into `main`; the verified merge parents are the exact base and final head, and the reviewed-head/merge trees are identical |
| Scope boundary | Gaming PRs #1425/#1426 are present in the base but are unrelated and excluded from this audit slice; GPT-OSS remains excluded |

The merged policy positively allowlists only `ask` and `dag-node` rows in
`completed` or `cancelled`. Ask retention defaults to 24 hours and DAG-node
retention to one hour; configured durations clamp from one hour through 30
days. All six authoritative terminal writer families—create, generic update,
fenced claimed-job completion/cancellation, pending cancellation, stale-job
cancellation recovery, and stalled-worker cancellation recovery—use the
PostgreSQL clock for the fallback. Explicit and persisted deadlines retain
precedence. GPT lifecycle ownership is unchanged; failed, pending, running,
expired, unknown, and local-agent rows remain excluded.

Cleanup is enabled by default, takes one deterministic bounded batch (default
100, clamped 1–1,000), requires elapsed retention and idempotency plus an
`updated_at` older than the greater of one hour and the diagnostics window, and
uses `FOR UPDATE SKIP LOCKED`. The cleanup and inventory paths neither delete
nor backfill unstamped legacy rows; no bulk or automatic backfill was performed.
Their inventory is bounded and aggregate-only; cleanup logs omit job IDs, and a
process-local latch warns once per continuous legacy-null presence. Retention is
earliest eligibility, not a deletion service-level guarantee.

### Local, CI, review, and contained-preview evidence

| Evidence | Result |
| --- | --- |
| Node `20.19.0` build, type-check, and lint | Passed; lint had zero errors and 76 existing warnings |
| Focused Jest | Eight suites / 120 tests passed, including all writer families, cleanup policy/inventory, and the real Ask consumer-slot success path with provider/database transports mocked |
| PostgreSQL 18 | Required suite passed real writer, precedence/exclusion, deterministic bounded cleanup, idempotency/observation protection, and locked-row skip cases |
| Railway/docs/generated artifacts | `validate:railway`, 327/327 Documentation Audit, all four generated-index checks, and `git diff --check` passed |
| Independent review | Source/SQL-concurrency/test reviews found no blocker. Copilot reviewed initial head `e09c73ac`, explicitly generated no comments, and no review thread remained |
| Final-head GitHub | [CI/CD `31463630148`](https://github.com/pbjustin/Arcanos/actions/runs/31463630148), [API `31463630146`](https://github.com/pbjustin/Arcanos/actions/runs/31463630146), [Documentation Audit `31463630135`](https://github.com/pbjustin/Arcanos/actions/runs/31463630135), [PR CI `31463630141`](https://github.com/pbjustin/Arcanos/actions/runs/31463630141), approval `31463629006`, Codecov, and both Railway contexts passed; GitHub reported `CLEAN`, `MERGEABLE`, and zero unresolved threads |

The automatic preview environment was
`2b806b26-50de-4803-b710-b1fab9956ebb`, with green web deployment
`05b35321-df86-4ac0-ac1f-68a895ac9057` and passive-worker deployment
`111f0a3d-46ae-44d5-b5ef-3d3b9a2b40de`. Cleanup run
[`31468287960`](https://github.com/pbjustin/Arcanos/actions/runs/31468287960)
passed, and the deployment record was inactive by `2026-08-11T07:17:31Z`.
This preview proved exact served identity and the sealed deployment contract.
It was intentionally credential/database-empty and passive, so it supplied no
PostgreSQL retention or cleanup evidence.

### Exact-merge and automatic-rollout evidence

| Evidence | Result |
| --- | --- |
| [CI/CD Pipeline `31468287598`](https://github.com/pbjustin/Arcanos/actions/runs/31468287598) | Passed all 13 jobs, including the required PostgreSQL fencing job, `Deployment Readiness`, and `All Checks Complete` |
| [Documentation Audit `31468287552`](https://github.com/pbjustin/Arcanos/actions/runs/31468287552) | Passed 327/327 maintained-documentation checks |
| [Repository Registration `31468287557`](https://github.com/pbjustin/Arcanos/actions/runs/31468287557) | Workflow-green; its backend registration request returned HTTP 400 |
| [Analyze Documentation Updates `31468287618`](https://github.com/pbjustin/Arcanos/actions/runs/31468287618) | Failed because the inherited auxiliary startup fixture omitted required `ARCANOS_JOB_READ_CAPABILITY_SECRET`; the maintained Documentation Audit passed |
| [Railway Auto Deploy `31469237913`](https://github.com/pbjustin/Arcanos/actions/runs/31469237913) | Policy passed, returned `automatic_promotion_blocked` under hold `20260727-dag-snapshot-generation-v1`, and skipped production job `93708761589` |
| Railway repository-integration fan-out | GitHub recorded nine non-production #1427 merge-SHA deployment records. Their initial attempts failed, the same pattern was present on the base, all nine records were inactive at the bounded 2026-08-11 readback, and none was production |

### Authorized production promotion and bounded verification

Production project `7faf44e5-519c-4e73-8d7a-da9f389e6187`, environment
`fb583147-6c39-4343-9267-500f357d25ab`, web service
`c4ade025-3f13-4fca-9309-5d0dd81396fe`, and worker service
`1765befb-b805-4051-9af9-28634e986886` were independently confirmed before
mutation. The operation verified zero running/cancel-requested jobs and the DAG
snapshot-generation schema, then stopped the prior web and worker writers.

Exact merge `2db3d41a58d9d34be6ee2119f7da9c0d682ac31e` was deployed to:

- web deployment `8fce3a96-e7c2-408c-9eae-f28e55dce823`, successful at
  `2026-08-11T17:24:24Z`; and
- worker deployment `71f3c370-9054-43f7-a44f-dd37fe7e6147`, successful at
  `2026-08-11T17:24:21Z`.

GitHub production deployment record `5855290028` reported success at
`2026-08-11T17:24:27Z`.

Both final provider records report branch `main`, the exact merge commit, one
running replica, `/readyz`, a 300-second activation timeout, 60-second drain,
and `node scripts/start-railway-service-with-integrity.mjs`. Public web and
worker `/readyz` returned HTTP 200 with `ready: true`. Bounded sanitized deploy
logs contained readiness markers and no fatal startup condition; the nonempty
error-classified lines were Node's JSON-module experimental warning. The worker
also emitted `queue.non_gpt_terminal.legacy_null.protected`, showing that a
startup inspection observed the aggregate legacy inventory; source eligibility
and the post-deploy database readback establish that those rows remained.

A read-only post-deploy transaction verified:

- zero `running` or `cancel_requested` jobs;
- one non-null BIGINT `dag_runs.snapshot_generation` column and one validated
  `dag_runs_snapshot_generation_nonnegative` constraint;
- 23 completed/cancelled Ask and 256 completed/cancelled DAG-node legacy rows
  with null retention; and
- zero stamped terminal rows in either allowlisted family.

The repository production-smoke wrapper itself did not complete because this
audit worktree was intentionally not Railway-linked; it passed its CLI check and
then failed topology discovery. The worktree was not linked as a workaround.
Its exact-target deployment, readiness, sanitized-log, and database invariants
were instead checked directly as described above.

This establishes exact production deployment, paired-role readiness, required
schema, and legacy-null protection. It does not establish a live successful
terminal writer, a new retention stamp, eligible-row deletion, cleanup latency,
backfill, provider/model behavior, or live-memory behavior. The promotion made
no provider-setting change and performed no manual migration or backfill,
retention aging, operator-invoked cleanup, provider/model request, or live-
memory call. The worker's automatic startup inspection remained enabled.

At the time of the #1427 reconciliation, automatic promotion did not occur
because the tracked coordinated-writer hold was still active. Live readback
then found zero production deployment triggers, a web-only repository service
selector, and no dedicated production project-token secret. Those are dated
#1427 facts, not current configuration. PRs #1428–#1430 subsequently retired
the hold to `none`, configured and verified the two-role GitHub path, removed
the obsolete selector, preserved zero native triggers, and produced the exact
automatic acceptance evidence recorded above.

## PR #1424 — protected-digest tooling and fail-closed startup gate

### Exact identity and scope

| Field | Value |
| --- | --- |
| Base | PR #1423 merge `6a3ef8763e3d97ef10e5345d3061268527d87373` |
| Branch | `codex/repository-health-progress-1423` |
| Initial published implementation | `51b7bfb117f6a6632f3244628c6b950f71a20559` |
| Reviewed implementation commit | `703c58e57e5f3555759c3f6a818c91eb0693d20f` |
| Final reviewed head | `b59da846b829a9133c3dbb75d64e2d6994f523ab` |
| Merge | `4f253ff68bdcea5c1b5fcc9e8525a43b92d291d3` |
| Reviewed/merged tree | `aa570f1a1415fabcd09d451072f0abbd9c9f2256` |
| Merge time | `2026-08-08T23:37:38Z` |
| Size | 6 commits; 56 files; +9,066/-5,532 |
| Pull request | [#1424](https://github.com/pbjustin/Arcanos/pull/1424), merged into `main`; the verified merge has parents equal to the exact base and final reviewed head, and its tree equals the reviewed-head tree |
| External state | GitHub branch/PR updates, automatic Railway PR preview, exact-merge workflows, and automatic non-production Railway fan-out occurred. No manual Railway/provider-settings mutation, database action, live-memory action, configured-pin match, or production rollout is credited |

The reviewed implementation extracts the established version-one
semantic serializer and SHA-256 implementation into a shared runtime/tooling
owner. It adds deterministic
generate, single-check, complete pinned-check, and startup-precutover modes; all
seven manifest entries have explicit candidate adapters, while only the six
maintained runtime-owned pins participate in automatic startup. The generic
`protected_json_file` entry remains an explicit-source, manual tooling contract.

File-backed adapters reuse the runtime's exact source resolution and assistant-
registry validation. Complete checks reject arbitrary source substitution,
symbolic links, source-identity changes, BOM-prefixed or malformed JSON, schema
violations, malformed pins, and mismatches. GPT map projection uses null-
prototype records, own-property lookup, declared/loaded catalog parity under a
pin, and strict validation of every configured override. Non-finite JSON number
values now fail schema validation instead of colliding semantically with
`null`. Automatic startup output redacts both expected and candidate digests.

Tracked normal Railway startup invokes the compiled comparison after volume
mounts and before the existing role launcher. The wrapper latches termination
signals across the gate-to-launch transition. The source-workspace npm commands
build before invoking compiled code so stale `dist` cannot yield manual green
evidence; direct compiled commands remain available for the identified,
already-built pruned runtime image. Native PR preview startup now runs the same
gate before forwarding the exact sealed-preview argument to the role launcher.
The CI/CD Deployment Readiness job exercises that canonical wrapper with
an explicit safe web role and `RUN_WORKERS=false`, while retaining its readiness
probe and SIGTERM cleanup.

### Local validation

| Check | Result |
| --- | --- |
| Node `20.19.0` `npm run build` | Passed |
| Node `20.19.0` `npm run type-check` | Passed |
| Node `20.19.0` `npm run lint` | Passed with zero errors and 76 warnings |
| Initial focused protected-digest, startup-wrapper, Railway, GPT-routing, integrity, module-loader, and Research suites | Passed 82/82 across eight suites |
| Final focused protected-digest, startup-wrapper/workflow, Railway, and role-launcher matrix | Passed 115/115 |
| Direct compiled generation and isolated pinned `--precutover` smoke | Passed; automatic output exposed no expected or candidate digest |
| `npm run validate:railway` and native-PR import-boundary check | Passed |
| Generated indexes | All four regenerated together; `reindex-codebase.js --check` passed |
| Broad non-GPT Jest sweep | 7,600 tests passed; two unrelated load-sensitive Windows process tests failed, then their isolated rerun passed 28/28 |
| Unfiltered root Jest | Not green because one unchanged, explicitly excluded GPT-OSS CRLF-fixture test failed on Windows |

The broad-suite exceptions are not in modified protected-digest paths. No
GPT-OSS correction is included because that program remains explicitly outside
this queue. These local results alone did not establish a reviewed head,
required CI, contained preview, merge, deployment, or production behavior.

### Final-head review and contained preview evidence

| Evidence | Result |
| --- | --- |
| [CI/CD Pipeline `31283307853`](https://github.com/pbjustin/Arcanos/actions/runs/31283307853) | Passed, including the canonical-wrapper `Deployment Readiness` job and fail-closed `All Checks Complete` |
| [API Endpoint Tests `31283307807`](https://github.com/pbjustin/Arcanos/actions/runs/31283307807) | Passed |
| [Documentation Audit `31283307816`](https://github.com/pbjustin/Arcanos/actions/runs/31283307816) | Passed with current generated indexes; `docs:check` was the branch-protection-required context |
| [PR CI `31283307810`](https://github.com/pbjustin/Arcanos/actions/runs/31283307810) | Passed |
| [Require Human Approval `31283307111`](https://github.com/pbjustin/Arcanos/actions/runs/31283307111) | Passed |
| Aggregate PR state | All 20 surfaced contexts passed; GitHub reported `CLEAN` and `MERGEABLE`, with zero unresolved review threads |
| Copilot correction | The startup signal race was repaired and its review thread was resolved |
| Final agent-review corrections | Non-finite JSON acceptance and the CI readiness-wrapper bypass were repaired |

The automatic Railway PR preview served exact head
`b59da846b829a9133c3dbb75d64e2d6994f523ab` from environment
`275ef5a6-1c59-4820-9330-40ef34465ec3`. Web deployment
`e915a498-1396-43a0-970e-6786245d84fc` and passive-worker deployment
`1cd8e566-7eee-4d43-9616-3f2f5c5e1356` both succeeded. The bounded native
runner passed 68/68 sequential requests with stable initial/final served-head
identity.

This is automatic contained-preview and served-public-identity evidence. It
proves the no-pin integrity wrapper can hand off to the sealed preview and that
the existing component matrix remains compatible. It does not establish a
configured-pin match count, ordinary provider/database routes, or production
deployment/state.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [CI/CD Pipeline `31284399435`](https://github.com/pbjustin/Arcanos/actions/runs/31284399435) | Passed all 13 jobs, including `Deployment Readiness` and `All Checks Complete` |
| [Documentation Audit `31284399440`](https://github.com/pbjustin/Arcanos/actions/runs/31284399440) | Passed 327/327 maintained-documentation checks |
| [Repository Registration `31284399454`](https://github.com/pbjustin/Arcanos/actions/runs/31284399454) | Workflow passed; its non-critical backend registration request returned HTTP 400 |
| [Analyze Documentation Updates `31284399453`](https://github.com/pbjustin/Arcanos/actions/runs/31284399453) | Failed because the auxiliary startup fixture omitted required `ARCANOS_JOB_READ_CAPABILITY_SECRET`; the maintained Documentation Audit passed |
| [Audit Cycle `31285801521`](https://github.com/pbjustin/Arcanos/actions/runs/31285801521) | Passed |
| [Railway Auto Deploy `31284925830`](https://github.com/pbjustin/Arcanos/actions/runs/31284925830) | Rollout policy passed and production job `93171963381` was skipped under coordinated-writer hold `20260727-dag-snapshot-generation-v1` |
| Railway repository-integration fan-out | The merge started 18 web/worker deployments across nine non-production environments. Commit-status history ended with five successes and 13 failures; a 2026-08-10 provider inventory classified five as removed and 13 as failed. None was a production target |

On 2026-08-10 the #1424 preview environment was absent from Railway project
inventory, and both former preview `/healthz` URLs returned 404. This attests
environment absence and endpoint unavailability, not deletion of every
historical deployment or artifact.

A 2026-08-10 production readback found web deployment
`4865a033-5cbe-4f9d-9ef4-4fad18a7be33` serving Gaming merge
`b270997a356071fdfa63823ca67beabde897b67f`; worker deployment
`12098d15-923e-4c15-91c0-d02225f7fe4d` exposed no commit provenance. Those
later Gaming changes are outside the audit lineage,
and transitive inclusion of the #1424 source tree does not establish an exact
#1424 production rollout. No configured-pin match, database operation,
provider/model call, live-memory mutation, or production credit is recorded
for PR #1424.

## Delivery ledger

| PR | Slice | Merge date | Merge commit | Source state |
| --- | --- | --- | --- | --- |
| [#1408](https://github.com/pbjustin/Arcanos/pull/1408) | Productivity and local-agent capability foundation | 2026-07-25 | `f5c7826e8a31cf03931fd77b7806394d3cde2233` | Merged |
| [#1409](https://github.com/pbjustin/Arcanos/pull/1409) | Repository health, security, runtime, and persistence hardening | 2026-07-28 | `81376790c7b726a2a2f55a66980c460440873386` | Merged |
| [#1410](https://github.com/pbjustin/Arcanos/pull/1410) | Expired dependency-waiver removal | 2026-07-28 EDT / 2026-07-29 UTC | `2c1be145da9faf5e60b811f25bc361a5aaf8d31e` | Merged |
| [#1411](https://github.com/pbjustin/Arcanos/pull/1411) | Memory-plane request containment and native-preview compatibility | 2026-07-29 | `481a1fb3e9f935699a2fcf685841e34edb04012e` | Merged |
| [#1412](https://github.com/pbjustin/Arcanos/pull/1412) | Worker diagnostics, generic-job continuation, and preview cleanup automation | 2026-07-30 | `2cc05f9f22bc88252b1bf7a6c17dd87c49ca1021` | Merged |
| [#1413](https://github.com/pbjustin/Arcanos/pull/1413) | Generic-job cache containment and promotion-gate hardening | 2026-07-31 | `c7ceffd8fbd3f3e944f106e8ba1df0bf34c9ea2d` | Merged |
| [#1414](https://github.com/pbjustin/Arcanos/pull/1414) | Provider admission, DAG dispatch, and GPT metric boundaries | 2026-08-01 | `762322174ee67648bf95dd74d9473915764f7a7e` | Merged |
| [#1415](https://github.com/pbjustin/Arcanos/pull/1415) | Worker-budget accounting and bounded stale recovery | 2026-08-02 | `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8` | Merged and later production-verified in a bounded reconciliation |
| [#1416](https://github.com/pbjustin/Arcanos/pull/1416) | Backstage mutation authorization and admission | 2026-08-03 | `5a5bb92672a06ec330a4a04131cfc3755c0b34a3` | Merged; no production credit |
| [#1417](https://github.com/pbjustin/Arcanos/pull/1417) | Backstage roster containment, atomicity, and adjacent hardening | 2026-08-04 UTC | `277857efed1f9aa41f724558d2f29512b65bf5a1` | Merged; no production credit |
| [#1418](https://github.com/pbjustin/Arcanos/pull/1418) | Research input bounds and deterministic storage | 2026-08-05 | `00bab421a86fcc3c148052595f9717bdc32f467a` | Merged; no production credit |
| [#1419](https://github.com/pbjustin/Arcanos/pull/1419) | Backstage storyline lifecycle | 2026-08-05 UTC | `8c25df850ae5db7b99e3a01afa72e2d0cf1ca752` | Merged; no production credit |
| [#1420](https://github.com/pbjustin/Arcanos/pull/1420) | Research aggregate budget and cancellation | 2026-08-07 UTC | `005938f74878c6ac4f878968e3eb9154c6de6e70` | Merged; no production credit |
| [#1421](https://github.com/pbjustin/Arcanos/pull/1421) | Effective MCP decoded-JSON pre-parser body cap | 2026-08-07 UTC | `e01b0397a31daf2309f5f418018d0b4116564db4` | Merged; no production credit |
| [#1422](https://github.com/pbjustin/Arcanos/pull/1422) | Fail-closed PostgreSQL package commands, aggregate CI truth, and compatible Hono remediation | 2026-08-08 UTC | `7bc83f469e571cd19626dbd2fa9360a8596b38e7` | Merged; no production credit |
| [#1423](https://github.com/pbjustin/Arcanos/pull/1423) | Node/backend `REQUEST_TIMEOUT` truthfulness | 2026-08-08 UTC | `6a3ef8763e3d97ef10e5345d3061268527d87373` | Merged; no production credit |
| [#1424](https://github.com/pbjustin/Arcanos/pull/1424) | Protected-digest tooling and fail-closed startup gate | 2026-08-08 UTC | `4f253ff68bdcea5c1b5fcc9e8525a43b92d291d3` | Merged; no configured-pin match or production credit |
| [#1427](https://github.com/pbjustin/Arcanos/pull/1427) | Successful non-GPT terminal retention | 2026-08-11 UTC | `2db3d41a58d9d34be6ee2119f7da9c0d682ac31e` | Merged and exact web/worker revision production-verified; no live retention stamp or deletion credit |
| [#1428](https://github.com/pbjustin/Arcanos/pull/1428) | Restore serialized automatic paired Railway promotion | 2026-08-11 UTC | `c3763fe9a970503baab5f19f1fb1490b52abb622` | Merged; first automatic run failed closed in readiness preflight before deployment |
| [#1429](https://github.com/pbjustin/Arcanos/pull/1429) | Synchronize the five-check production readiness contract | 2026-08-11 UTC | `8361e37263d6b0a9c32c15b76c1999fd80bf98bb` | Merged; automatic run activated only the worker before bounded observer overflow; no web was enqueued |
| [#1430](https://github.com/pbjustin/Arcanos/pull/1430) | Bound exact-deployment history observation | 2026-08-11 UTC | `98d6ad998e936d4db26b1330b28a9edff1331018` | Merged and automatically promoted as one exact verified worker/web pair |

Gaming PRs #1425/#1426 are deliberately omitted from this audit ledger. They
are present in #1427's base but do not close or modify an audit finding.

## PR #1423 — Node/backend `REQUEST_TIMEOUT` truthfulness

### Exact identity

| Field | Value |
| --- | --- |
| Base | `7bc83f469e571cd19626dbd2fa9360a8596b38e7` |
| Reviewed head | `58754e5632bd4bea4640ba83fc79b3a5f9a551e2` |
| Merge | `6a3ef8763e3d97ef10e5345d3061268527d87373` |
| Reviewed/merged tree | `55fe0200366bf7a06ad9f752b05e6c9e65b54093` |
| Merge time | `2026-08-08T06:57:44Z` |
| Size | 2 commits; 9 files; +80/-8 |

Remote `main` was fetched after merge and pointed directly to the merge commit.
Its parents are the PR #1422 merge and exact reviewed head; the reviewed and
merged trees match.

### Implemented contract and review evidence

The slice removes the parsed-but-unused Node/backend
`config.limits.requestTimeout`, the backend `REQUEST_TIMEOUT=30000` example,
and the corresponding millisecond-valued backend documentation claim. It does
not substitute an HTTP-server property, response-only timeout race, or other
mechanism that would falsely claim cancellation of underlying work.

The Python daemon remains independent. Its `BACKEND_REQUEST_TIMEOUT=15` and
`REQUEST_TIMEOUT=30` controls remain seconds-valued and live at their maintained
consumer seams. Documentation now scopes those consumers to the main backend
API/protocol clients, non-streaming chat, fallback chat streaming, vision,
transcription, and inline agentic confirmed commands; it does not imply a
universal daemon or Node HTTP deadline.

Focused local evidence passed the two-test Node/documentation contract, all six
daemon OpenAI-adapter tests with an exact sentinel timeout assertion, the
311/311 documentation audit with current generated indexes, and
`git diff --check`. Independent Node/runtime, daemon-contract, tests/CI, and
generated-artifact reviews found no blocker. The optional propagation-test
hardening and daemon-consumer wording recommendation were implemented. Copilot
generated no inline comments, and no review thread remained.

### Exact-head GitHub evidence

| Workflow or context | Result |
| --- | --- |
| [CI/CD Pipeline `31240522180`](https://github.com/pbjustin/Arcanos/actions/runs/31240522180) | Passed all 13 jobs, including the fail-closed aggregate |
| [API Endpoint Tests `31240522159`](https://github.com/pbjustin/Arcanos/actions/runs/31240522159) | Passed |
| [Documentation Audit `31240522158`](https://github.com/pbjustin/Arcanos/actions/runs/31240522158) | Passed |
| [PR CI `31240522167`](https://github.com/pbjustin/Arcanos/actions/runs/31240522167) | Passed |
| Codecov patch, approval-policy checks, and Copilot review | Passed |
| Railway web and passive-worker preview contexts | Passed at the exact reviewed head |

### Exact-head contained preview evidence

The native preview environment was
`b9067c39-49b8-49f6-bffe-148e5b2de058`, with web deployment
`9c44bd8b-b4b9-41a2-a8b8-0ab9aa825981` and passive-worker deployment
`b0e2e8fe-1930-4767-bd74-7aad2c011680`.

The bounded live runner passed 68/68 sequential requests with 21,832 aggregate
response bytes. It covered the sealed Research fixtures including cancellation
drain, storyline fixtures, effective MCP body-cap fixture, health/readiness,
deny-by-default behavior, and worker denial. Initial and final web/worker
readiness identities matched the exact reviewed head and remained stable.

This is sealed component and served-public-identity evidence. The checkout was
not Railway-linked, so provider IDs came from the Railway PR comment and status
contexts rather than an independent CLI control-plane attestation. The preview
does not prove a Node request deadline, normal provider/database handlers, or
production rollout.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [Documentation Audit `31245091796`](https://github.com/pbjustin/Arcanos/actions/runs/31245091796) | Passed |
| [Repository Registration `31245091806`](https://github.com/pbjustin/Arcanos/actions/runs/31245091806) | Workflow passed; its non-critical backend registration request returned HTTP 400 |
| [Analyze Documentation Updates `31245091805`](https://github.com/pbjustin/Arcanos/actions/runs/31245091805) | Failed because the auxiliary startup fixture still omitted required `ARCANOS_JOB_READ_CAPABILITY_SECRET`; the maintained Documentation Audit passed |
| [CI/CD Pipeline `31245091797`](https://github.com/pbjustin/Arcanos/actions/runs/31245091797) | Passed all 13 jobs; `All Checks Complete` verified all 11 required results |
| [Railway Auto Deploy `31245615516`](https://github.com/pbjustin/Arcanos/actions/runs/31245615516) | Coordinated-writer hold `20260727-dag-snapshot-generation-v1` passed policy and skipped production job `93073631689` |
| Railway repository-integration status history | The merge separately started 18 web/worker deployments across nine environments marked non-production, ending with six successes and 12 failures; none was the #1423 preview environment, and status history does not prove current lifecycle state or cleanup |

A read-only 2026-08-08 Railway project inventory listed 18 current environments
and did not contain preview environment
`b9067c39-49b8-49f6-bffe-148e5b2de058`. That attests environment absence, not
deletion of every historical deployment or artifact. No production rollout,
database operation, application provider/model call, live-memory mutation, or
provider-configuration change is credited to PR #1423; the other non-production
deployment starts remain a lifecycle-cleanup concern.

## PR #1422 — PostgreSQL command and aggregate CI truth

### Exact identity

| Field | Value |
| --- | --- |
| Base | `e01b0397a31daf2309f5f418018d0b4116564db4` |
| Reviewed head | `ecc8644b1da3476a12d7c895bc4406323d7d8897` |
| Merge | `7bc83f469e571cd19626dbd2fa9360a8596b38e7` |
| Reviewed/merged tree | `7c5437339ae787acf7db733892f7cdba822303a4` |
| Merge time | `2026-08-08T01:22:33Z` |
| Size | 2 commits; 26 files; +746/-189 |

Remote `main` was read back at the exact merge. Its parents are the PR #1421
merge and exact reviewed head; the reviewed and merged trees match.

### Implemented contract and review evidence

One exact `ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1` sentinel now governs all
seven required PostgreSQL suites and rejects every other nonempty value. Each
suite keeps its purpose-specific target, fails before database hooks if
required CI omits it, and accepts only an explicit loopback PostgreSQL URL for
the disposable `arcanos_audit_pg18_20260727` database. Local runs remain
skippable only when the shared sentinel is absent.

`All Checks Complete` now runs under `always()`, receives the exact 11-job
`needs` object, and rejects a missing, unexpected, malformed, skipped,
cancelled, or failed result. The same PR pinned the SDK-scoped Hono dependency
to `4.12.34`, removed obsolete Hono and propagated `@hono/node-server` audit
exceptions, and retained fail-closed dependency-audit policy.

Focused and independent validation passed 27/27 PostgreSQL/aggregate tests,
122/122 audit/MCP transport tests, clean-install and real MCP adapter checks,
type-check, lint, build, documentation, and Railway compatibility. Review found
no remaining P1/P2 issue.

### Exact-head and contained-preview evidence

The exact-head disposable PostgreSQL 18 CI service ran all seven suites and 107
tests successfully. CI/CD run
[`31220350380`](https://github.com/pbjustin/Arcanos/actions/runs/31220350380)
passed all 13 jobs, Security Audit found no actionable issue, and the aggregate
verified all 11 required results. Documentation Audit, PR CI, API tests,
Codecov, Copilot review, and both Railway preview contexts passed. Preview web
and worker readiness returned HTTP 200 with protected effects disabled; that
was contained startup/readiness evidence, while PostgreSQL CI remained
authoritative for database behavior.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [CI/CD Pipeline `31232497743`](https://github.com/pbjustin/Arcanos/actions/runs/31232497743) | Passed all 13 jobs and verified all 11 aggregate dependencies |
| [Documentation Audit `31232497763`](https://github.com/pbjustin/Arcanos/actions/runs/31232497763) | Passed |
| [Repository Registration `31232497741`](https://github.com/pbjustin/Arcanos/actions/runs/31232497741) | Passed |
| [Analyze Documentation Updates `31232497752`](https://github.com/pbjustin/Arcanos/actions/runs/31232497752) | Repeated the known missing-secret auxiliary startup-fixture failure |
| [Railway Auto Deploy `31233063281`](https://github.com/pbjustin/Arcanos/actions/runs/31233063281) | Coordinated-writer hold `20260727-dag-snapshot-generation-v1` passed policy and skipped production job `93040546303` |
| Railway repository-integration status history | The merge separately started 18 web/worker deployments across nine non-production environments; six succeeded and 12 had non-success (failed/stopped) outcomes |

A read-only Railway reconciliation found production still at the 2026-08-02 PR
#1415 generation, with healthy web and paired worker readiness. No #1422
production rollout, database operation, application provider/model call,
live-memory mutation, or provider-configuration change is credited. The
non-production deployment starts remain a lifecycle-cleanup concern.

## PR #1421 — Effective MCP pre-parser body cap

### Exact identity

| Field | Value |
| --- | --- |
| Base | `005938f74878c6ac4f878968e3eb9154c6de6e70` |
| Reviewed head | `b9aa2c30c1bf8881eacdb5a8648f160d92f3e2cb` |
| Merge | `e01b0397a31daf2309f5f418018d0b4116564db4` |
| Reviewed/merged tree | `9fd22faec11bd889882eff8f9e0888cd73b01885` |
| Merge time | `2026-08-07T06:16:36Z` |
| Size | 2 commits; 27 files; +1,542/-39 |

Remote `main` was read back at the exact merge. Its parents are the PR #1420
merge and exact reviewed head; the reviewed and merged trees match.

### Implemented contract and review evidence

The exact `POST /mcp` JSON transport now parses before the broad application
parser and retains the same idempotent parser at the standalone-router seam.
The effective decoded-entity limit is
`min(MCP_HTTP_BODY_LIMIT, JSON_LIMIT, 1,048,576)`. Oversized JSON, including
inflated gzip and chunked bodies without `Content-Length`, returns fixed HTTP
`413` `MCP_REQUEST_TOO_LARGE` JSON with `no-store` and `no-cache` headers before
MCP rate limiting, authentication, transport, or downstream work. Malformed
JSON, non-JSON media, `GET /mcp`, and neighboring routes retain their prior
contracts.

Focused validation passed the 17-test body-cap suite, the separate stricter-
`JSON_LIMIT` assembled-app regression, the four-suite 317-test parser/preview
matrix, all 17 MCP-matching suites with 141 tests, and the 9/9 native-preview
runner contract. Type-check, build, passive Railway validation, lint with zero
errors and 76 existing warnings, and the 306/306 documentation audit passed.
Independent code, test, documentation, and Copilot review found no remaining
P1/P2 issue.

### Exact-head GitHub evidence

| Workflow or context | Result |
| --- | --- |
| [CI/CD Pipeline `31150753631`](https://github.com/pbjustin/Arcanos/actions/runs/31150753631) | Passed all 13 jobs |
| [API Endpoint Tests `31150753599`](https://github.com/pbjustin/Arcanos/actions/runs/31150753599) | Passed |
| [Documentation Audit `31150753604`](https://github.com/pbjustin/Arcanos/actions/runs/31150753604) | Passed |
| [PR CI `31150753653`](https://github.com/pbjustin/Arcanos/actions/runs/31150753653) | Passed |
| Railway web and passive-worker preview contexts | Passed |

### Exact-head contained preview evidence

The native preview environment was
`7eacb652-e52b-486c-bc6d-9a8f4c9c5992`, with web deployment
`30a9e1b8-ff36-4e52-830c-1adb6b0547f3` and passive-worker deployment
`5180f65d-e07d-4335-b326-8120ce90af21`.

The bounded live runner passed 68/68 sequential requests with 21,832 aggregate
response bytes. Its sealed fixture exercised six server-owned, three-chunk
streams without `Content-Length`: exact and one byte over the hard 1 MiB
maximum, a downward 512 KiB MCP setting, and a stricter 256 KiB global JSON
setting. Exact cases reached the synthetic downstream sentinel once; oversized
cases reached it zero times and returned the fixed 413/no-cache contract. Web
and worker readiness hashes remained stable, and the passive worker denied the
fixture route.

This is contained component evidence, not a literal oversized public-wire
upload or proof of normal `/mcp` authentication, compression, slow-upload
handling, or production rollout. Parsing still precedes MCP authentication and
rate limiting; slow-upload timeout handling remains separate.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [Documentation Audit `31153379411`](https://github.com/pbjustin/Arcanos/actions/runs/31153379411) | Passed |
| [Repository Registration `31153379370`](https://github.com/pbjustin/Arcanos/actions/runs/31153379370) | Passed |
| [CI/CD Pipeline `31153379401`](https://github.com/pbjustin/Arcanos/actions/runs/31153379401) | Passed all 13 jobs |
| [Analyze Documentation Updates `31153379354`](https://github.com/pbjustin/Arcanos/actions/runs/31153379354) | Failed because the auxiliary startup fixture omitted required `ARCANOS_JOB_READ_CAPABILITY_SECRET`; the maintained Documentation Audit passed |
| [Railway Auto Deploy `31154244947`](https://github.com/pbjustin/Arcanos/actions/runs/31154244947) | Coordinated-writer hold `20260727-dag-snapshot-generation-v1` passed policy and skipped production job `92790223400` |
| Railway repository-integration status history | The merge independently started 18 service deployments across nine non-production environment IDs, ending with six successes and 12 failures; none targeted the last verified production or #1421 preview environment, and status history does not prove current lifecycle state or cleanup |

No production rollout, database operation, application provider/model call,
live-memory mutation, or provider-configuration change is credited to PR
#1421. The repository-integration deployment starts remain external provider
mutations and a lifecycle-cleanup concern.

## PR #1420 — Research aggregate budget and cancellation

### Exact identity

| Field | Value |
| --- | --- |
| Base | `8c25df850ae5db7b99e3a01afa72e2d0cf1ca752` |
| Reviewed head | `69a817e6e54356b57dfee594385324d5568d7c7f` |
| Merge | `005938f74878c6ac4f878968e3eb9154c6de6e70` |
| Reviewed/merged tree | `1462f37965e92e4aa7a58415ab5306b2c4351cf1` |
| Merge time | `2026-08-07T00:46:28Z` |
| Size | 5 commits; 64 files; +5,781/-324 |

Remote `main` was read back at the exact merge. The merge parents are the PR
#1419 merge and the exact reviewed head; the reviewed and merged trees match.

### Implemented contract

The slice uses one bounded `ResearchWorkflowContext` across every Research
entrypoint and convergence seam. It covers direct commands, SDK, canonical GPT,
dispatch, legacy compatibility, MCP, GPT Access, module/hub execution,
DNS/fetch, each Trinity/provider stage, and deterministic persistence.

Cancellation prevents later-stage admission and optional side effects, removes
cancelled Trinity waiters, recovers permits across admission races, keeps
caller/deadline cancellation breaker-neutral, and waits for admitted
cooperative work to drain before settlement. Real socket-disconnect tests cover
the universal and legacy route boundaries with mocked provider/database seams.
Durable queued jobs retain their own cancellation ownership after admission.

### Local and independent review evidence

- Focused integrated regression: 9 suites, 178/178 tests.
- Randomized breaker/Trinity/ingress regression: five seeds, each 69/69.
- `npm run type-check`, `npm run build`, passive `npm run validate:railway`,
  generated-index checks, and `git diff --check`: passed.
- `npm run lint`: zero errors and 76 inherited warnings.
- `npm run docs:check`: 311/311.
- Full Windows root run: 595 suites and 7,815 tests passed, plus one unchanged,
  explicitly excluded GPT-OSS CRLF-sensitive migration-guard failure.
- Independent code, test, and documentation reviews found no remaining
  actionable issue after the final corrections.

### Exact-head GitHub evidence

After an acknowledged GitHub Actions incident delayed webhook workflows, the PR
was reopened without changing its head to emit genuine `pull_request` events.
The authoritative rerun completed successfully:

| Workflow or context | Result |
| --- | --- |
| [CI/CD Pipeline `31132133985`](https://github.com/pbjustin/Arcanos/actions/runs/31132133985) | All surfaced jobs passed, including security, lint/type, PostgreSQL/concurrency, sandbox, build, unit, integration, Redis, convergence, Python, Railway compatibility, deployment readiness, and aggregate completion |
| [PR CI `31132134182`](https://github.com/pbjustin/Arcanos/actions/runs/31132134182) | Passed |
| [API Endpoint Tests `31132133921`](https://github.com/pbjustin/Arcanos/actions/runs/31132133921) | Passed |
| [Documentation Audit `31132134031`](https://github.com/pbjustin/Arcanos/actions/runs/31132134031) | Passed |
| Approval-policy check (`No approval required for this PR by policy`), worker-diagnostics cleanup, and Codecov patch | Passed |
| Railway web and passive-worker preview contexts | Passed |

Manual-dispatch queue cancellations and event-mode gitleaks output from the
incident window are superseded by these valid PR-context results.

### Exact-head contained preview evidence

The recreated native preview environment was
`6d2727b1-7271-46c3-a168-fcacaa34638b`, with web deployment
`5476776e-1b5c-46d2-8fce-cfb39ed00097` and worker deployment
`21ff3626-9820-4bd2-a23a-d0d439af3a1f`.

The bounded dry run first verified the canonical repository, PR number, clean
matching local head, target hosts, and 66-request plan without network. The
authorized live runner then passed 66/66 requests with exact served-commit
identity and readiness before and after the exercise. The
`research-workflow-cancellation-drain` case returned SHA-256
`31f89d1c6f289dd6a845ef7bd1a5a9043abd9f37fc04cc232ff1bacf8558d63d`.

The fixture is sealed synthetic component proof. Its parent-abort cases are
disconnect-equivalent signal propagation, not literal TCP disconnects. It did
not invoke the normal Research route, confirmation, external DNS, a provider or
model, PostgreSQL, memory, production persistence, or a production effect.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [Documentation Audit `31135804039`](https://github.com/pbjustin/Arcanos/actions/runs/31135804039) | Passed |
| [Repository Registration `31135803968`](https://github.com/pbjustin/Arcanos/actions/runs/31135803968) | Passed |
| [CI/CD Pipeline `31135803979`](https://github.com/pbjustin/Arcanos/actions/runs/31135803979) | Passed all 13 jobs, including the final deployment-readiness and aggregate gates |
| [Analyze Documentation Updates `31135803993`](https://github.com/pbjustin/Arcanos/actions/runs/31135803993) | Failed because the auxiliary production-mode startup fixture omitted required `ARCANOS_JOB_READ_CAPABILITY_SECRET`; this repeats the known workflow-fixture defect |
| [Railway Auto Deploy `31136626908`](https://github.com/pbjustin/Arcanos/actions/runs/31136626908) | Coordinated DAG writer rollout policy passed; `Deploy Production (Railway)` was skipped because hold `20260727-dag-snapshot-generation-v1` remained active |
| Railway repository-integration status history | The merge independently started 18 service deployments across nine environment IDs; final status was six successes and 12 failures. None targeted the last verified production environment `fb583147-6c39-4343-9267-500f357d25ab` or #1420 preview environment `6d2727b1-7271-46c3-a168-fcacaa34638b`; surfaced success names included `arcanos-pr-1320`, `test-probe-delete-me`, `phase2d-validation-20260717`, `gaming-discovery-27071b86`, and `gaming-rag-generic-20260709`. Commit-status history does not establish every environment's name or current provider state |

The coordinated-writer hold governed the workflow-owned production job, not
every Railway repository-connected environment. No deployment to the last
verified production target, database operation, application AI/search-provider
or model call, live-memory mutation, or Railway/provider configuration change
is recorded or credited to PR #1420, but the 18 other service-deployment starts
are external provider mutations and remain a lifecycle-cleanup concern.

## Intermediate delivery evidence

### PR #1414 — provider admission, DAG dispatch, and GPT metric boundaries

| Field | Value |
| --- | --- |
| Base | `c7ceffd8fbd3f3e944f106e8ba1df0bf34c9ea2d` |
| Reviewed head | `b4c1ac2eead277aa7130b55bcac329d5c787bc10` |
| Merge | `762322174ee67648bf95dd74d9473915764f7a7e` |
| Reviewed/merged tree | `8a3120305628460a9f456645b688dee76690d65b` |
| Merge time and size | `2026-08-01T16:51:28Z`; 6 commits; 76 files; +8,725/-307 |

The final full Node run passed 572 suites and 7,224 tests, with five suites and
39 tests skipped; the disposable real-Redis regression passed 14/14. The
exact-head native preview passed 50/50 requests and proved served-head,
web/passive-worker, and credential-empty containment, but did not expose real
provider ingress. Exact-merge
[CI/CD `30709061674`](https://github.com/pbjustin/Arcanos/actions/runs/30709061674)
passed all 13 jobs. Railway rollout run
[`30709586713`](https://github.com/pbjustin/Arcanos/actions/runs/30709586713)
passed policy and skipped its production job under hold
`20260727-dag-snapshot-generation-v1`. Final review was green; no production
credit is inferred. The auxiliary documentation-analysis fixture defect was
already present separately.

### PR #1415 — worker-budget accounting and bounded stale recovery

| Field | Value |
| --- | --- |
| Base | `762322174ee67648bf95dd74d9473915764f7a7e` |
| Reviewed head | `4269ef96343b39db1c96c31c168268af2219f345` |
| Merge | `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8` |
| Reviewed/merged tree | `da760f8f2a23ec45bf21024e766ef070feaa2f50` |
| Merge time and size | `2026-08-02T09:00:56Z`; 5 commits; 34 files; +2,547/-38 |

All 20 surfaced final-head PR contexts passed. The isolated PostgreSQL 18.4
preview at intermediate head `c7bb98bcc2cc869f1bc80c9d0cd2bdb9c376db87`
ran migration phases 1–4 twice, exercised the canonical two-slot worker,
claimed eight jobs while leaving the ninth unclaimed at budget, and proved
bounded stale recovery 2/2/1. It made no provider or GPT-OSS call. Because that
live SQL/worker proof predates the reviewed final head, it is supporting rather
than exact-final-head evidence. Exact-merge
[CI/CD `30740913419`](https://github.com/pbjustin/Arcanos/actions/runs/30740913419)
passed all 13 jobs. Railway rollout run
[`30741382286`](https://github.com/pbjustin/Arcanos/actions/runs/30741382286)
passed policy and skipped its production job under the coordinated-writer hold.

#### 2026-08-02 authorized production reconciliation

| Evidence | Bounded attestation |
| --- | --- |
| Exact target | Railway project `7faf44e5-519c-4e73-8d7a-da9f389e6187`; production environment `fb583147-6c39-4343-9267-500f357d25ab`; web `c4ade025-3f13-4fca-9309-5d0dd81396fe`; worker `1765befb-b805-4051-9af9-28634e986886`; PostgreSQL `6647b5b1-d796-4783-b5f0-b8e356019ca6`; Redis `81e4a1cf-7ae4-48bf-8321-23641bb23c0e` |
| Source | Merge `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8`, tree `da760f8f2a23ec45bf21024e766ef070feaa2f50` |
| Backup | `373deae3-c717-4557-80b2-1930710cffe6`, `pre-8bb0b803-20260802`, created `2026-08-02T19:40:39.209Z`; present at final observation, restore not tested |
| Database | Applied `20260727_job_claim_generation_v1.sql`, `20260727_dag_run_snapshot_generation_v1.sql`, and worker-stats phases 01–04; final catalog, primary role, and restored original HBA policy were verified |
| Final web | Deployment `147279ab-faa7-45a6-8c70-404ed2a1a9c9`, `SUCCESS`, exact commit, image `sha256:b35df38cde98c2ac28ec9ba2f30a1b5ae7a4bf356a8e3450f8b322b6e886b58f` |
| Final worker | Deployment `bdf7cbb8-e5ab-460b-a424-a0204fe6fb23`, `SUCCESS`, exact archived source tree, image `sha256:c19f0ed15378bec0cf4ca1ee69788f2d5cb23d2ee57c1cf4866ab74efa8dbd80`; Railway recorded no worker `commitHash`, so provenance is archive/tree-bounded |
| Credential containment | A database credential exposed in private tool output was rotated; new public-TCP authentication and both fresh application deployments proved the replacement. A negative old-password check was not recorded |
| Final live checks | On 2026-08-02, `/readyz`, `/health`, missing-job status, and missing-job result passed; bounded web/worker logs showed successful database connection and readiness/bootstrap evidence |

This production credit ends at the #1415 generation and only covers the named
target and observed contracts. Backup restorability, lifetime log absence,
unobserved paths, and later source were not proved. The coordinated-writer hold
remained active.

### PR #1416 — Backstage mutation authorization and admission

| Field | Value |
| --- | --- |
| Base | `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8` |
| Reviewed head | `67bcb5b8ec426d6f43c61a368f2c56384c76399e` |
| Merge | `5a5bb92672a06ec330a4a04131cfc3755c0b34a3` |
| Reviewed/merged tree | `92d5b6e82dd9095955d1944bfcb19ea1c85122e8` |
| Merge time and size | `2026-08-03T05:24:11Z`; 4 commits; 35 files; +2,652/-165 |

Focused validation passed 134 tests and both exact-head full suites passed.
Both exact-head Railway preview contexts succeeded, but the contained preview
did not expose live Backstage handlers; it proved deployment, served commit,
readiness, and pre-parser rejection only. Exact-merge
[CI/CD `30787066940`](https://github.com/pbjustin/Arcanos/actions/runs/30787066940)
passed all 13 jobs. Railway rollout run
[`30787707059`](https://github.com/pbjustin/Arcanos/actions/runs/30787707059)
passed policy and skipped its production job under the hold. The auxiliary
documentation-analysis fixture failed for the known missing secret. No
production rollout is credited.

### PR #1417 — Backstage roster containment and atomicity

| Field | Value |
| --- | --- |
| Base | `5a5bb92672a06ec330a4a04131cfc3755c0b34a3` |
| Reviewed head | `01f7c88911f6de0bd8ea0017221b374da2ff880e` |
| Merge | `277857efed1f9aa41f724558d2f29512b65bf5a1` |
| Reviewed/merged tree | `2d7cfcec47f45b19c5bc72b3e0defee2f697c58f` |
| Merge time and size | `2026-08-04T02:00:22Z`; 7 commits; 57 files; +5,923/-249 |

Local review passed 52/52 focused Jest tests, 74/74 pytest tests, 145/145
audit/workflow Jest tests, documentation 311/311, type, lint, build, and
contract checks. The authorized isolated-PostgreSQL preview passed 80 Python
and 17 TypeScript CLI cases plus the real Backstage HTTP/SQL exercise,
including concurrent writers, revision fencing, NUL rejection, and zero-total
behavior. Required native web/worker preview contexts passed; one stale
external deleted-verifier status failed but was nonrequired. Exact-merge
[CI/CD `30870474740`](https://github.com/pbjustin/Arcanos/actions/runs/30870474740)
passed all 13 jobs. Railway rollout run
[`30871096102`](https://github.com/pbjustin/Arcanos/actions/runs/30871096102)
passed policy and skipped its production job under the hold. No production
rollout is credited. This slice introduced the temporary npm-audit exception
that must be re-reviewed by 2026-08-10.

## Recent predecessor evidence

### PR #1418

Reviewed head `15451ed48185cef0d0c40acc706def57f133de65` merged as
`00bab421a86fcc3c148052595f9717bdc32f467a`. It established the shared
pre-normalization Research bounds—topic 500 JavaScript `String.length` units,
10 supplied URL slots, 2,048 `String.length` units per URL, 16,384 aggregate
`String.length` units—and the 97-byte deterministic portable storage component.
Exact-merge
[CI/CD `30978894009`](https://github.com/pbjustin/Arcanos/actions/runs/30978894009)
passed all 13 jobs. Railway rollout policy run
[`30979698973`](https://github.com/pbjustin/Arcanos/actions/runs/30979698973)
enforced the coordinated-writer hold and skipped production deployment.

### PR #1419

Reviewed head `fe80168dbe072f851a7fbd587fb54a9a763026b3` merged as
`8c25df850ae5db7b99e3a01afa72e2d0cf1ca752`. It established 16,384-byte
story beats, newest-100 retention, newest-25 chronological responses, atomic
PostgreSQL sequencing/pruning, mixed-writer fencing, and fail-closed ambiguous
commit handling. Exact-merge
[CI/CD `31057634892`](https://github.com/pbjustin/Arcanos/actions/runs/31057634892)
passed all 13 jobs. Railway rollout policy run
[`31058416025`](https://github.com/pbjustin/Arcanos/actions/runs/31058416025)
enforced the same hold and skipped production deployment.

### Production-verification history

The bounded 2026-08-02 production reconciliation verified the PR #1415 source
generation `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8`, its required database
contracts, healthy web/worker roles, restored database access policy, and
rotated database credential. It did not test backup restoration and cannot be
projected onto audit-scoped PRs #1416–#1424.

The separately authorized 2026-08-11 promotion verified exact #1427 merge
`2db3d41a58d9d34be6ee2119f7da9c0d682ac31e` on both production roles, their
readiness/activation contract, the required DAG fencing schema, zero active
jobs, and protection of 279 legacy-null terminal rows. It did not execute a new
terminal writer or eligible cleanup deletion. Intervening Gaming PRs #1425/#1426
remain outside the audit lineage despite being included in #1427's base.

The later automatic 2026-08-11 acceptance run verified exact #1430 merge
`98d6ad998e936d4db26b1330b28a9edff1331018` as one worker-first pair: worker
`d20a6833-2448-4677-89df-84e46a0d2567` and web
`e59f6a27-2d2a-4e24-b9e8-f9ba5d26dd41` both became the active exact revision,
passed role/readiness and joint active-ID checks, and completed the strict web
watchdog. This is promotion-control evidence; it adds no database, retention,
provider/model, or live-memory behavior credit.

## Historical evidence

The former 4,950-line tracked report is retained unchanged apart from its
archive banner in
[history-through-2026-07-31.md](history-through-2026-07-31.md). It contains
the original capture, intermediate findings, red characterization, superseded
queues, PR #1408–#1413 detail, and the initial PR #1414 composition record.
The compact dossiers above preserve the August #1414–#1424 and #1427–#1430
delivery and production-reconciliation evidence without restoring chronological
sprawl. Historical present-tense claims must not override this ledger.
