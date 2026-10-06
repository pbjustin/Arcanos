# PR 1528 simplification audit

Phase 1 completed against `pbjustin/Arcanos`, draft PR
[1528](https://github.com/pbjustin/Arcanos/pull/1528), branch
`codex/persistent-live-validation`, starting SHA
`9a511dd41f4fd7ce8412400c2b3b1dec8970cb08`, before implementation edits.
The reviewed original PR had 22 commits and 74 changed files. The original diff,
callers and focused tests were reviewed; the table below covers every originally
changed file and all its additions. Mixed hunks list the retained control and the
removed coupling separately. New additive commits preserve that audit history.

## Decision

The original design deployed a candidate runtime and an independently trusted
supervisor with custom mTLS/CA certificates, leaf pins, signed admission, scoped
broker sessions, a persistent quota ledger and a private verifier route. The
required goal is narrower: exact PR SHA → real isolated Railway application →
real public acquisition → real Trinity → mandatory answer audit → positive and
negative acceptance evidence.

The final facility uses one **ARCANOS V2 Validation** service in `live-validation`,
a dedicated validation OpenAI key, controller-generated deployment bearer,
normal Railway HTTPS, existing source guards, transient v2 Gaming, local bounded
provider admission and exact source/build/deployment/readiness proof. It attaches
no production Postgres, Redis, player persistence or production traffic.

`KEEP` retains useful independent controls. `MODIFY` retains those controls while
removing old topology coupling. `REMOVE` removes the final critical path.
`REMOVE / DEFER` records independently useful infrastructure as future work;
it does not leave that infrastructure as a prerequisite.

## Original file and hunk classification

| # | Original changed path | Decision | Addition/hunk rationale and transfer |
| --- | --- | --- | --- |
| 1 | `.env.example` | MODIFY | Retain dedicated validation-key documentation; replace supervisor-only binding and signed admission with one-service key/test-bearer configuration. |
| 2 | `.github/workflows/ci-cd.yml` | KEEP | Keep the added offline security-contract step; its named scripts adapt to retained verifier and single-service tests. |
| 3 | `.github/workflows/live-pr-acceptance.yml` | MODIFY | Preserve manual authorization, exact head, credential-free gates, source/build proof, budgets and sanitized artifacts; remove signer/CA/mTLS/self-hosted supervisor dependencies and use Railway HTTPS. |
| 4 | `.github/workflows/pr-ci.yml` | KEEP | Keep added offline validation contracts; update their referenced suite contents after topology removal. |
| 5 | `.gitleaksignore` | KEEP | Keep only the precise reviewed synthetic idempotency fingerprint; no new broad ignore or reduced global scanning. |
| 6 | `backend-index.json` | MODIFY | Regenerate source/test entries after structural removals; retain indexes only for final active files. |
| 7 | `cli-agent-index.json` | MODIFY | Regenerate with the other three indexes; original addition is timestamp churn only. |
| 8 | `docs/API.md` | MODIFY | Preserve separate authenticated validation API and sanitized evidence; replace signed module/session endpoint with one-service readiness/run/acceptance/usage/stop routes. |
| 9 | `docs/BACKEND_INDEX.md` | MODIFY | Regenerate retained source/test navigation together with JSON indexes. |
| 10 | `docs/CLI_AGENT_INDEX.md` | MODIFY | Regenerate timestamp and rendering consistently with index generator. |
| 11 | `docs/CONFIGURATION.md` | MODIFY | Keep default-off isolation and dedicated provider credential; remove supervisor-only access and private broker handoff. |
| 12 | `docs/LIVE_PR_PREVIEW.md` | REMOVE / DEFER | Transfer acquisition/audit/evidence/budget guidance into one-service runbook; defer independent supervisor threat model, generalized modules and eight-case live suite. |
| 13 | `docs/LIVE_VALIDATION.md` | MODIFY | Preserve operation, exact SHA, isolation, profiles, telemetry, costs and honest limits; replace two services, TLS hierarchy, signed admission, durable ledger and private verifier bootstrap. |
| 14 | `docs/RAILWAY_DEPLOYMENT.md` | MODIFY | Retain validation companion guidance; describe one isolated service using normal Railway HTTPS and application acquisition guards. |
| 15 | `docs/README.md` | MODIFY | Consolidate active runbook entry and add original-diff audit; remove obsolete supervisor runbook entry. |
| 16 | `examples/live-pr-preview/README.md` | REMOVE / DEFER | Transfer generic evidence cautions; defer secondary Stardew/eight-case workflow requiring old supervisor sessions. |
| 17 | `examples/live-pr-preview/gaming-public-sources.json` | REMOVE / DEFER | Secondary legacy manifest is outside the required two-profile facility; broader game/source profiles remain follow-up work. |
| 18 | `examples/live-validation/README.md` | MODIFY | Keep transient v2, source and stage evidence guidance; remove obsolete transport/session instructions and record measured response construction. |
| 19 | `examples/live-validation/fixture-profiles.json` | KEEP | Retain reproducible positive and wrong-game offline source profiles, explicitly separate from real public acquisition. |
| 20 | `examples/live-validation/profiles.json` | KEEP | Retain real public Elden Ring Samurai and wrong-game Sekiro profiles, transient inputs and preserved semantic expectations. |
| 21 | `infra/live-validation/runtime.Dockerfile` | MODIFY | Preserve shallow exact-SHA fetch, pinned toolchain, compiled manifest, read-only runtime and Git-free final layers; remove two-role/TLS assumptions. |
| 22 | `infra/live-validation/runtime.railway.json` | MODIFY | Preserve one replica, NEVER restart and dedicated startup/health; use ordinary single-service HTTP behind Railway HTTPS. |
| 23 | `infra/live-validation/supervisor.Dockerfile` | REMOVE / DEFER | Only builds separate trusted provider supervisor; defer independent broker security architecture. |
| 24 | `infra/live-validation/supervisor.railway.json` | REMOVE / DEFER | Only deploys supervisor and its durable quota volume; no second service is needed. |
| 25 | `infra/live-validation/target.example.json` | MODIFY | Keep fixed project/environment/service denial, models, prices and hard limits; remove supervisor ID/revision, private peer map and certificate pins. |
| 26 | `package.json` | MODIFY | Keep offline suite commands; remove dependencies on deleted policy/broker/run/start/E2E tests and retain pure evidence verifier. |
| 27 | `scripts/live-pr-preview-broker.mjs` | REMOVE / DEFER | Legacy scoped broker/session transport; transfer provider request restrictions/reservations to local guarded provider and defer separate broker. |
| 28 | `scripts/live-pr-preview-broker.test.mjs` | REMOVE / DEFER | Legacy broker-specific tests; transfer bounds/security cases into local provider tests. |
| 29 | `scripts/live-pr-preview-e2e.mjs` | REMOVE | Legacy approval/session live runner; transfer pure sanitized evidence projection to retained verifier/controller. |
| 30 | `scripts/live-pr-preview-e2e.test.mjs` | REMOVE | Tests obsolete approval/session runner; retain sanitizer coverage with verifier and new controller contracts. |
| 31 | `scripts/live-pr-preview-policy.mjs` | REMOVE / DEFER | Custom signed approval/attestation trust and environment contract; replace required identity checks with one-service target/deployment proof. |
| 32 | `scripts/live-pr-preview-policy.test.mjs` | REMOVE / DEFER | Custom signer/attestation tests; transfer production denial/exact identity cases to single-service target/controller tests. |
| 33 | `scripts/live-pr-preview-run.mjs` | REMOVE / DEFER | Independent supervisor checkout, durable claims and secret/session handoff; transfer safe operator input handling where still needed. |
| 34 | `scripts/live-pr-preview-run.test.mjs` | REMOVE / DEFER | Independent supervisor admission tests; transfer required no-secret-before-admission and ownership cases to new controller/runtime tests. |
| 35 | `scripts/live-pr-preview-verifier.d.mts` | KEEP | Typed pure sanitized evidence/verifier contract remains independent of service topology. |
| 36 | `scripts/live-pr-preview-verifier.mjs` | KEEP | Keep grounded-source/citation/mandatory-audit checks and sanitized evidence; accept transferred pure sanitizer without network/broker execution. |
| 37 | `scripts/live-pr-preview-verifier.test.mjs` | KEEP | Retain evidence acceptance/rejection and sanitization regressions. |
| 38 | `scripts/live-validation-bootstrap.mjs` | MODIFY | Preserve source/tree/artifact identity and fail-closed startup; remove supervisor-role and TLS identity assumptions. |
| 39 | `scripts/live-validation-bootstrap.test.mjs` | MODIFY | Preserve exact SHA, compiled digest and startup denial tests; adapt role/settings to one service. |
| 40 | `scripts/live-validation-broker.mjs` | REMOVE / DEFER | Separate supervisor model broker; transfer quota/stage/provider restrictions to local guarded provider. |
| 41 | `scripts/live-validation-broker.test.mjs` | REMOVE / DEFER | Separate broker/session tests; preserve essential budget/retry/provider cases with local provider tests. |
| 42 | `scripts/live-validation-budget.mjs` | MODIFY | Preserve conservative cost/request/token/time/concurrency reservations and no refunds for uncertain calls; remove supervisor-specific durable accounting/locks/volume. |
| 43 | `scripts/live-validation-budget.test.mjs` | MODIFY | Keep paid-call hard caps, zero retries, concurrent denial, expiry and failed-call reservation tests; replace durable supervisor ledger tests with process-local guard tests. |
| 44 | `scripts/live-validation-build.mjs` | KEEP | Keep exact clean source/build compiled manifest; limit the artifact role to the retained runtime. |
| 45 | `scripts/live-validation-controller.mjs` | MODIFY | Keep exact PR head, isolated inventory, observed deployment/readiness, sanitized profile evidence and owned cleanup; remove supervisor deployment, handshake, signer/mTLS/session choreography. |
| 46 | `scripts/live-validation-controller.test.mjs` | MODIFY | Keep moved head, mismatched SHA/build, isolation, bounded admission, evidence and cleanup regressions; replace supervisor orchestration mocks with single-service API. |
| 47 | `scripts/live-validation-egress.mjs` | MODIFY | Preserve fixed provider endpoints and public-source containment; remove private supervisor origin allowance. Application controls are not a platform firewall. |
| 48 | `scripts/live-validation-egress.test.mjs` | MODIFY | Keep HTTPS/private-network/production/provider endpoint and bounded request denials; remove supervisor peer cases. |
| 49 | `scripts/live-validation-policy.mjs` | REMOVE / DEFER | Ed25519 signed supervisor plan and peer/session binding; required profile/identity limits move to authenticated single-service admission. |
| 50 | `scripts/live-validation-policy.test.mjs` | REMOVE / DEFER | Signature/supervisor-plan tests; required shape, identity and bounded admission cases move to target/runtime/controller tests. |
| 51 | `scripts/live-validation-services.test.mjs` | MODIFY | Keep fail-closed startup, auth-before-input, exact identity, real adapter, sanitized timing and no production imports; replace paired supervisor/mTLS tests with one-service routes. |
| 52 | `scripts/live-validation-target.mjs` | MODIFY | Keep production denylists, exact isolated inventory, model/pricing limits and closed variables; require one service/origin and no volume/DB/Redis. |
| 53 | `scripts/live-validation-target.test.mjs` | MODIFY | Keep wrong target/production/shared credentials/DB/Redis and model/limit denials; replace two-service/TLS inventory fixtures. |
| 54 | `scripts/live-validation-transport.mjs` | REMOVE / DEFER | Custom CA, mTLS, DNS/SNI peer roles and fingerprint pin transport; normal Railway HTTPS handles this single-service path. |
| 55 | `scripts/live-validation-transport.test.mjs` | REMOVE / DEFER | Only validates removed custom TLS identity infrastructure; preserve normal HTTPS/no redirect/retry/bounded request checks with controller/provider tests. |
| 56 | `scripts/live-validation-workflow.test.mjs` | MODIFY | Preserve manual gating, immutable checkout/image SHA, secret-safe hosted job, quotas and artifacts; remove trusted supervisor runner and signer/TLS secret dependencies. |
| 57 | `scripts/start-live-pr-preview.mjs` | REMOVE | Legacy broker-scoped private runtime launcher replaced by dedicated one-service launcher. |
| 58 | `scripts/start-live-pr-preview.test.mjs` | REMOVE | Legacy child/session launcher tests; transfer auth/import/isolation coverage to retained runtime tests. |
| 59 | `scripts/start-live-validation-runtime.mjs` | MODIFY | Keep dedicated real Gaming path, closed env, transient effects, SHA/build proof and sanitized stages; directly use local guarded provider behind authenticated normal HTTP. |
| 60 | `scripts/start-live-validation-supervisor.mjs` | REMOVE / DEFER | Separate supervisor TLS/provider/session/ledger service; no longer a bootstrap or runtime dependency. |
| 61 | `src/core/logic/trinity.ts` | KEEP | Keep bounded live Gaming execution, zero-retry behavior and actual generation/audit telemetry; mandatory final audit remains required. |
| 62 | `src/core/logic/trinityTypes.ts` | KEEP | Keep server-only execution/observation options used for transient bounded Gaming. |
| 63 | `src/livePrPreviewApplication.ts` | REMOVE | Legacy v1 module-registry/broker app; transfer required auth and response timing behavior to single runtime service. |
| 64 | `src/livePrPreviewGamingAdapter.ts` | REMOVE | Legacy v1 Gaming adapter superseded by real transient v2 validation adapter; retain necessary fixtures/coverage independently. |
| 65 | `src/liveValidationGamingAdapter.ts` | MODIFY | Keep real v2 acquisition/selection/Trinity/audit, transient-only behavior and diagnostics; change only local provider/one-service interface coupling. |
| 66 | `src/services/gamingPipeline.ts` | KEEP | Keep genuine stage observation hooks and transient bounded execution without weakening existing source/audit/citation checks. |
| 67 | `src/shared/gaming/liveValidationObservation.ts` | KEEP | Keep sanitized stage/count/audit observations with measured timings and no hidden reasoning. |
| 68 | `src/shared/webFetcher.ts` | KEEP | Keep validation source guard in real DNS/IP-pinned fetch transport; preserve SSRF/redirect/HTTPS/byte/security behavior. |
| 69 | `tests/gaming-live-runtime.test.ts` | KEEP | Keep actual Gaming pipeline/transient/source/audit regressions independently of removed v1 adapter. |
| 70 | `tests/live-pr-preview-application.test.ts` | REMOVE | Legacy app tests; transfer mandatory authentication, wrong identity and response timing coverage to one-service tests. |
| 71 | `tests/live-validation-gaming-adapter.test.ts` | MODIFY | Keep real v2 offline fixture acceptance/conflict/transient/audit/timing checks; adapt only removed legacy app/provider interfaces. |
| 72 | `tests/live-validation-source-guard.test.ts` | KEEP | Keep acquisition-path containment regressions independent of topology. |
| 73 | `tests/trinity-gaming-intake.test.ts` | KEEP | Keep zero-retry/model-call bounds and real intake policy regressions. |
| 74 | `tests/trinity-integrity-recovery.test.ts` | KEEP | Keep mandatory audit without validation regeneration/integrity-repair retry; existing ordinary application behavior stays protected. |

## Deferred follow-up work

- A separately trusted model broker/supervisor that protects provider credentials
  and quotas from arbitrary malicious candidate code.
- Custom CA issuance, mTLS, peer certificate pins, signed broker admission and
  scoped supervisor sessions for an actual multi-service threat model.
- Durable quota state across process replacement. This facility admits one run
  per deployment process, with one replica and `NEVER` automatic restart; manual
  restart/redeployment does not authorize an exhausted run again.
- Broader acquisition, insufficient-evidence, real timeout, exhausted-budget and
  unauthorized-identity live profiles, plus generalized non-Gaming modules.
- Stable typed semantic-gap policy, trusted overlays for pre-harness historical
  commits and separately enforceable network policy. No native Railway domain
  egress filtering is claimed.

Removing validation-only supervisor boundaries does not change mandatory Gaming
source acquisition, SSRF/private-network/redirect/HTTPS/byte controls,
prompt-injection filtering, compatibility/currentness, mandatory CLEAR answer
auditing or citation integrity. Useful stage telemetry and final-answer audit
binding stay in the real pipeline. None of the deferred items is needed before
one positive and one negative run can begin after actual isolated provisioning,
exact-SHA proof and dedicated key binding.

## Historical secret-scan triage

Pinned Gitleaks `8.24.3` scanned all Git history with the existing `.gitleaksignore`
and 100% redaction at the starting SHA. Its pinned release archive SHA256 matched
`9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c`.
The scanner returned exit 1 with 22 historical findings: 21 `generic-api-key`,
one `github-pat`. Classification: **real credential 0; revoked/obsolete
credential 0; synthetic/test fixture 13; false positive 9**. No matching value,
secret hash, live credential probe or production variable read was used in the
published triage. Safe metadata below records the exact finding locations.

The two historical `.env:17` automation-secret hits are constructed alternating
alphanumeric placeholders. Commit
`886e6c2cf6967e7c66bdc5f611be06fe6f81e0be` explicitly says “remove committed
secret placeholder”, removes that same value and adds an explicit replacement
placeholder. Commit `70bbe2a61d1977eca573fa04f35975c39c646532` later removes `.env`
from Git. This evidence supports **synthetic placeholder**, not a claim that a
real credential was revoked. No real unrevoked exposure was identified.

| Historical path:line | Finding commit | Classification | Safe evidence |
| --- | --- | --- | --- |
| `scripts/gate-r2-volume-disposition.js:44` (generic-api-key) | `bf9a379c7d025652cbcef4d1eb3c99961be4ad5e` | false positive | Application error-code string in SAFE_FAILURES; no authentication capability. |
| `scripts/gate-r2-service-instance-retirement.js:45` (generic-api-key) | `bf9a379c7d025652cbcef4d1eb3c99961be4ad5e` | false positive | Application error-code string in SAFE_FAILURES; no authentication capability. |
| `tests/action-plan-execution-ownership.characterization.test.ts:81` (generic-api-key) | `d3d4be855b1bd8299bd825ca04a7afb469a2417f` | synthetic/test fixture | Static mocked action idempotency key. |
| `tests/gptoss-private-serving-auth.test.ts:201` (generic-api-key) | `bc30ee877842b6712a44478b2f749c048428f6c9` | synthetic/test fixture | Locally configured signing fixture in isolated private-serving tests. |
| `tests/gptoss-private-serving-scaffold.test.ts:375` (generic-api-key) | `bc30ee877842b6712a44478b2f749c048428f6c9` | synthetic/test fixture | Locally configured signing fixture in isolated private-serving tests. |
| `tests/gptoss-private-serving-scaffold.test.ts:344` (generic-api-key) | `2714750be9451db0054f73ca97875195d194a53e` | synthetic/test fixture | Invalid legacy local signing fixture expected to be rejected. |
| `tests/exactLiteralPromptShortcut.test.ts:8` (generic-api-key) | `8a6da895e4ed15d8248b3626b114e00fb900c881` | false positive | Literal echo prompt text; no credential-bearing operation. |
| `tests/trinity.test.ts:61` (generic-api-key) | `8a6da895e4ed15d8248b3626b114e00fb900c881` | false positive | Literal echo prompt text; no credential-bearing operation. |
| `tests/ask-async-route.test.ts:153` (generic-api-key) | `8a6da895e4ed15d8248b3626b114e00fb900c881` | false positive | Literal echo prompt text; no credential-bearing operation. |
| `tests/ask-async-route.test.ts:158` (generic-api-key) | `8a6da895e4ed15d8248b3626b114e00fb900c881` | false positive | Literal echo prompt text; no credential-bearing operation. |
| `daemon-python/tests/test_telemetry_sanitization.py:15` (generic-api-key) | `ac47b4d8fb3878980f7d493b5dc03afcfe1e150d` | synthetic/test fixture | Deterministic synthetic log-redaction fixture. |
| `tests/structured-logging-sanitization.test.ts:22` (generic-api-key) | `ac47b4d8fb3878980f7d493b5dc03afcfe1e150d` | synthetic/test fixture | Deterministic synthetic log-redaction fixture. |
| `.env:17` (generic-api-key) | `e30c261931041bd5a2e3ae7ba0cc430b59dfce33` | synthetic/test fixture | Constructed alternating alphanumeric placeholder; removal commit 886e6c2cf6967e7c66bdc5f611be06fe6f81e0be explicitly removes committed secret placeholder and substitutes replace placeholder. |
| `.env:17` (generic-api-key) | `169170091ef512cb9c83b20058fb48c466abec41` | synthetic/test fixture | Same constructed placeholder as finding 12; .env later removed by 70bbe2a61d1977eca573fa04f35975c39c646532. |
| `SECURITY.md:64` (generic-api-key) | `f7269ef36761ad6496450ed1afca87f3b17eadb9` | false positive | Ellipsis placeholder in security documentation. |
| `SECURITY.md:66` (generic-api-key) | `18b483b87923586a6935d86f6cde43346bfca0c3` | false positive | Ellipsis placeholder in security documentation. |
| `tests/test-security-compliance.ts:49` (github-pat) | `5f67f25762f9c9a613ef5e2f49c7462fddb0d8f2` | synthetic/test fixture | Deterministic fake credential literal in credential-redaction test input. |
| `tests/test-security-compliance.ts:45` (generic-api-key) | `5f67f25762f9c9a613ef5e2f49c7462fddb0d8f2` | synthetic/test fixture | Deterministic fake credential literal in credential-redaction test input. |
| `tests/test-security-compliance.ts:49` (generic-api-key) | `5f67f25762f9c9a613ef5e2f49c7462fddb0d8f2` | synthetic/test fixture | Same synthetic scanner test credential as finding 16 under second rule. |
| `tests/test-security-compliance.ts:111` (generic-api-key) | `5f67f25762f9c9a613ef5e2f49c7462fddb0d8f2` | synthetic/test fixture | Deterministic fake credential literal in input-validation scanner fixture. |
| `tests/test-pr-assistant.test.ts:52` (generic-api-key) | `5f67f25762f9c9a613ef5e2f49c7462fddb0d8f2` | synthetic/test fixture | Deterministic fake credential inside mock PR diff fixture. |
| `SECURITY.md:66` (generic-api-key) | `6f8830cb961e32e6100f7b32f095a36e90749dc7` | false positive | Same ellipsis documentation placeholder as finding 15. |

The existing full-history CI scanner remains enabled and its current findings
are not reported as a clean scan. No global allowlist/rule weakening is introduced;
the original PR's one exact synthetic idempotency fingerprint stays unchanged.
Scoped candidate additions, compiled output and final image must be scanned
separately. Historical cleanup does not block this authorized simplification
unless a real live credential exposure is discovered.

## Reviewable outcome and limitations

The retained runbook is [LIVE_VALIDATION.md](LIVE_VALIDATION.md). Runtime/build,
controller, provider budget, containment, offline Gaming profiles, workflow and
evidence contracts receive focused tests. Final evidence reports actual check
counts and live status separately; this audit itself does not claim a Railway
deployment, successful key binding, paid request or live profile result.

Environment isolation is a Railway configuration assumption verified through
inventory readback, not a custom network firewall. Local provider caps rely on
reviewed candidate application behavior and conservative model pricing. A manual
process replacement can reset local budget state; durable adversarial accounting
is deferred. The test path proves transient backend Gaming behavior, not normal
OAuth, installed ChatGPT plugin acceptance, durable source storage or production
readiness. Production changes, merging and production deployments are excluded.
