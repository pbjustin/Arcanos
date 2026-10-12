# Targeted security and self-healing repair

Historical local verification receipt captured on 2026-10-12. This is source,
mocked-dependency and loopback fixture evidence, not production acceptance.
The companion [reproduction manifest](reproduction.json) records canonical
tool versions, base implementation and fixture hashes, observed counts and log
hashes. Full raw fixture logs remain outside Git in the delivered workspace.
Canonical guidance: [configuration](../../../CONFIGURATION.md),
[predictive healing](../../../PREDICTIVE_SELF_HEALING.md), and
[workspace packages](../../../WORKSPACE_PACKAGES.md).

- Repository: `pbjustin/Arcanos`.
- Exact initial current-main base: `3fd305b37ba410cf21684a8fed7619a1ba180b48`.
- Isolated branch: `codex/targeted-security-healing-20261012`.
- The final immutable head SHA is recorded in the draft PR and delivered
  verification report; this committed receipt cannot contain its own commit SHA.
- Toolchain: Node `24.18.1`, npm `11.16.0`, PowerShell `7.4.13`; downloaded
  archives verified against published checksums. Canonical dependencies are
  installed with `CI=true npm ci --no-audit --no-fund` in a fresh verification
  worktree because preloaded dependencies did not match the lockfile. The
  preloaded cache is preserved separately and its results are noncanonical.
- Authorized effects: local source/tests/docs, commits, task-branch publication
  and one draft PR. No production writes, Railway changes, deployments, restarts,
  database mutations, credential changes, feature enablement, merge or auto-merge.

## Characterization before implementation changes

`security.ts` preferred the leftmost `X-Forwarded-For` value over Express's
configured proxy policy. Its compatibility actor resolver preferred caller
sessions, then authenticated metadata, then raw authorization fingerprints.
The generic limiter used that resolver by default and at several sole-admission
route call sites. Opportunistic TTL cleanup removed expired counters, but active
identity cardinality and retained key size had no hard bound. Explicit
session-scoped compatibility helpers also have ownership consumers and are
preserved separately from admission identity.

Production public-provider admission already uses atomic client-plus-global
Redis admission, stable project/environment/service namespaces, hashed keys,
TTL, dependency/readiness fencing and fail-closed unavailability. Generic
middleware counters are process-local. The added replica fixture characterizes
the existing shared provider gate, not a new shared generic limiter.

The app started legacy `controlLoop`; the server separately started canonical
`selfHealingLoop` after preflight, listener binding and dependency activation.
Both could schedule on an eligible daemon/autonomy configuration. Legacy
incident state, mitigation, attempts and verification were separate; its
`getSelfHealingLoopMitigation` has no production consumer. Trinity imports V2
state, which canonical and predictive healing already activate.

Canonical healing owns a process-global runtime singleton, in-flight exclusion,
incident diagnosis/attempt windows, action/controller cooldowns and verification.
Predictive disposition owns its tick when enabled; uncertain/rejected execution
cannot authorize a reactive fallback. A verification rollback ends its tick
before another predictive execution. Approval, server feature gates, freeze,
autonomy and production debug denial remain independent safeguards.
Default canonical bounds are a 30-second cadence (predictive/loop overrides
retain precedence), five-minute signal window, ten-minute incident attempt
window, three attempts per diagnosis, two-minute action cooldown, five-minute
controller cooldown, ten-minute ineffective-action cooldown and 90-second
verification delay. Legacy bounds were ten-second cadence, two-minute lookback
and cooldown, five attempts, 15-second verification grace and ten-minute
mitigation TTL. Local incident/recovery bookkeeping is not live acceptance.

V2 has process-local state for intake, reasoning and final stages. Automatic
failure production required enabled daemon mode, autonomy at least 3 and no
freeze, but omitted the scheduler's web-role suppression. Three qualifying
failures in five minutes select degraded mode for intake/reasoning, or final
bypass followed by degraded mode for final. Each stage permits at most three
attempts; actions expire at ten minutes, three successes verify retention, and
two failures roll back with a two-minute cooldown and failed-action exclusion.
The existing stage-failure path can immediately select a remaining next action
after rollback; outcome-verification rollback simply clears the action and waits.
Mitigation consumption is limited to simple Trinity traffic; complex and
protected Gaming intake policy retain their independent decisions.

Both scheduler start functions suppressed the web-only role, but exported
canonical startup/interval tick calls could bypass that boundary. Manual
commands have a separate scoped owner and retain their existing authorization.
Trinity CLEAR also feeds the self-improvement controller when optional effects
are enabled; that proposal/controller path is distinct from mitigation and is
unchanged. The dedicated Railway worker entrypoint does not start either server
scheduler. No mitigation broadcast across services or replicas exists.

`promptRouteMitigation` is a separate existing process-global route policy,
consumed by `/api/openai/prompt`, with canonical/predictive producers and a
route-local fast-trip producer (default two timeouts in one minute, two-minute
cooldown). Reduced-latency mode changes retry/token/time budgets; degraded mode
returns its bounded local response. It has no automatic TTL; explicit rollback
and canonical post-action verification handle recovery. This repair does not
change or enable that existing authority. Request-local Trinity abort fallback
also remains available independently of persistent mitigation production.

The standalone execution controller ignored the response and returned constant
`0.9` from `extractConfidence`; its default threshold `0.85` always chose one
pass. Only integration fixtures used nondefault thresholds. Existing refinement
was limited to one additional budget-checked pass with untrusted draft framing,
control-character sanitization and a 12,000-character bound. No calibrated
model confidence mechanism exists in this path.

## Reproduction evidence

Regression fixtures were added before their corresponding implementation
changes. Base implementation behavior and failing assertions were captured
locally; all addresses, credentials and outputs below are synthetic fixtures.

| Defect | Before-fix observation | Corrected expectation |
| --- | --- | --- |
| Untrusted forwarding | Header `198.51.100.77` replaced loopback peer | Express policy/peer identity |
| Trusted chain | Spoofed leftmost address won over `203.0.113.21` | First untrusted hop from right |
| Mutable identity | Three rotations admitted with limit 1 | Only first request admitted |
| Established identity | Same actor's second request admitted after session/address change | Same trusted actor remains throttled |
| Cardinality | Third active identity admitted with cap 2 | Deny overflow without eviction |
| Retained key size | A 100,000-character actor retained a 100,008-character key | Fixed 64-character digest |
| Public route bypass | Rotated `/query-finetune` request 31 returned 400 | Request 31 returns 429; no provider call |
| Duplicate startup | App invoked legacy start; explicit legacy start created a timer | Canonical server scheduler alone |
| V2 role bypass | Third web-role stage failure activated degraded mode | Automatic producer remains inactive |
| Canonical tick bypass | Direct nonmanual web-role tick called advisor/metrics | Suppress before observation or effects |
| Invented confidence | Response claims 0 and 1 both selected one pass at 0.85, two at 0.95 | Explicit internal policy owns refinement |

Security pre-fix receipt: 7 failures, 30 passes across three suites. The same
seven failures were reconfirmed at the exact base with fresh locked dependencies
and byte-identical current regression fixtures; the corrected source then passed
37/37 under those dependencies. Base implementation hashes were checked against
Git before and after execution. Healing
baseline: 64 passes across four suites; newly added startup/role regressions
then produced three failures. Those three were independently reconfirmed at the
exact base under locked dependencies (3 failed, 8 passed, 11 total). The
supplemental tick fixture produced one failure alongside three positive passes
before its guard was added, then its single role-negative case was independently
reconfirmed at the exact base under locked dependencies (1 failed, 4 unselected
cases skipped). Confidence policy regression produced two failures and eight
passes, also independently reconfirmed at the exact base under locked dependencies.

The broad sweep exposed stale installed `proxy-addr` version `2.0.7` versus
locked security-patched `2.0.8`. Initial direct-Express observations under that
cache led to incorrect fixture edits; that conclusion is withdrawn and the
original proxy fixtures are restored. The exact locked artifact was independently
downloaded, verified against lockfile SHA-512, and compared: its cross-family
guard rejects IPv4/IPv4-mapped peers for the short mapped IPv6 `/8` and `::/1`
rules that the cached version accepted. No dependency, lockfile or security
policy is changed to accommodate a cached installation.

## File-level rationale

| Files | Rationale |
| --- | --- |
| `src/platform/runtime/security.ts` | Use Express trust resolution and existing established-actor utility for admission; cap counters at 10,000, optionally lower; hash bucket/actor tuple; deny overflow without evicting active counters; recover at exact expiry. Preserve compatibility ownership resolver. |
| `src/routes/queryFinetune.ts` | Replace sole mutable admission key with trusted admission resolver; preserve path and budget. |
| `src/routes/ask/index.ts` | Use trusted resolver; preserve route policy and response compatibility. |
| `src/routes/api-arcanos.ts` | Use trusted resolver for the existing ask budget. |
| `src/routes/api-arcanos-verification.ts` | Use trusted resolver for verification-control budget; preserve separate authenticated DAG write/status/inspection principal policies. |
| `src/services/gptAccessRateLimit.ts` | Preserve client budget through shared address resolver, including absent Express IP fallback. |
| `src/app.ts` | Remove legacy scheduler startup; retain server readiness ownership. |
| `src/services/selfImprove/controlLoop.ts` | Retain inspection/export compatibility while permanently disabling the orphaned competing scheduler, including explicit start calls. |
| `src/services/selfImprove/selfHealingLoop.ts` | Apply existing service-role policy at nonmanual tick entrypoints before observation/effects; preserve manual gates. |
| `src/services/selfImprove/selfHealingV2.ts` | Apply existing service-role policy to automatic failure producer; preserve explicit commands, consumption, expiry and rollback. |
| `arcanos-ai-runtime/src/runtime/executionController.ts` | Replace fabricated confidence with `secondPassPolicy: never \| if_budget_available`, default `never`; retain budget and draft safeguards. |
| `tests/security-rate-limit.test.ts` | Positive trusted chains/established actors; negative spoofing/rotation; cap, no-eviction, exact expiry and bounded-key fixtures; explicit compatibility policy preserved. |
| `tests/query-finetune-rate-limit.test.ts` | Real router rejects rotated metadata at existing ceiling; invalid bodies prevent provider execution. |
| `tests/public-provider-rate-limit-store.test.ts` | Concurrent atomic-store model shares ceiling across two replicas and replacement replica: 10 admitted, 14 denied, replacement denied. |
| `tests/api-arcanos.route.test.ts`, `tests/api-arcanos-compatibility.test.ts`, `tests/api-arcanos-honesty.e2e.test.ts` | Synchronize explicit security export mocks with new helper. |
| `tests/app-runtime-worker-startup.test.ts` | App starts workers once and does not start retired healing owner. |
| `tests/self-heal-control-loop-startup.test.ts` | Explicit legacy opt-in creates neither timer nor probes/effects. |
| `tests/self-healing-v2.test.ts` | Automatic web-role denial, explicit manual activation, duplicate action idempotence, exact expiry and complex-tier exclusion. |
| `tests/self-healing-trinity.integration.test.ts` | Real coordinator, V2, Trinity facade, SDK and guarded loopback transport prove mitigation production/consumption/decision/expiry/rollback; concurrent tick and legacy duplication denied; predictive rejection fails closed; automatic role denied and manual owner preserved. Database, memory, controller and worker effects throw; telemetry effects are mocked; transport admits only the fixture loopback origin. |
| `arcanos-ai-runtime/tests/runtime_integration.test.js` | Explicit policy, default/never/unknown negatives, claimed-confidence independence, at-most-once refinement, budget, sanitization and truncation. |
| `scripts/check-native-pr-preview-imports.mjs` | Update only reviewed security source semantic pin; unchanged graph/ambient/binding guards and tamper denial. Independent review found no new imports or ambient effects. |
| `docs/CONFIGURATION.md`, `docs/PREDICTIVE_SELF_HEALING.md`, `docs/WORKSPACE_PACKAGES.md` | Record admission semantics, healing ownership/boundaries and internal refinement policy. |
| `backend-index.json`, `cli-agent-index.json`, `docs/BACKEND_INDEX.md`, `docs/CLI_AGENT_INDEX.md` | Regenerate all four repository indexes together for the added integration fixture. |
| This receipt and `reproduction.json` | Record reproduction, hashes, scope, verification and limitations. |

## Verification commands and outcomes

Commands run at a repository root with the pinned toolchain. The broad root
sweep uses a disposable detached canonical verification worktree at source head
`74ab1c5826e3ac8f90f6869012788d2fb86019fc`, with a fresh locked installation
and independently built artifacts. Earlier cached-dependency diagnostic sweeps
used a separate worktree. Local test persistence is confined to those disposable
checkouts. Logs are held outside the checkouts under `/workspace`; the delivered
verification report records final aggregate outcomes and exact final head.

Final canonical root sweep: **896 suites passed, 13 suites skipped; 17,485 tests
passed, 167 cases skipped, zero failures** (17,652 total, 506.357 seconds).
This includes the relevant security, healing, Trinity, runtime/startup,
approval/kill-switch, containment, route compatibility and mocked integration
fixtures. Focused security passed 37/37; healing's five suites passed 73/73;
confidence passed 10/10; standalone runtime integration passed 79/79 with no
skips; source containment/tamper tests passed 410/410 in the canonical sweep.

| Command | Outcome |
| --- | --- |
| `node scripts/run-jest.mjs --runTestsByPath tests/security-rate-limit.test.ts tests/query-finetune-rate-limit.test.ts tests/public-provider-rate-limit-store.test.ts --runInBand --coverage=false` | Canonical exact-base: 7 failed/30 passed; canonical repaired: 37 passed. |
| `node scripts/run-jest.mjs --runTestsByPath tests/app-runtime-worker-startup.test.ts tests/self-heal-control-loop-startup.test.ts tests/self-healing-v2.test.ts --runInBand --coverage=false` | Canonical exact-base: 3 failed/8 passed. |
| `node scripts/run-jest.mjs --runTestsByPath tests/self-healing-trinity.integration.test.ts --testNamePattern='suppresses automatic startup and interval entrypoints' --runInBand --coverage=false` | Canonical exact-base: 1 expected failure/4 unselected cases skipped; no model requests. |
| `node scripts/run-jest.mjs --runTestsByPath tests/self-healing-trinity.integration.test.ts tests/self-healing-v2.test.ts tests/self-heal-control-loop-startup.test.ts tests/self-healing-loop.test.ts tests/app-runtime-worker-startup.test.ts --runInBand --coverage=false` | 73 passed after fixture telemetry isolation. |
| `node --test arcanos-ai-runtime/tests/runtime_integration.test.js` | Before: 2 failed/8 passed; after: 10 passed. |
| `npm run test:runtime-integration` | 79 passed, no skips; shared/runtime builds and seven node:test suites. |
| `node --test arcanos-ai-runtime/tests/smoke.test.js` | 1 trivial harness test passed; no product behavior proof. |
| `node scripts/run-jest.mjs --runTestsByPath tests/native-pr-preview-import-boundary.test.js --coverage=false --runInBand` | 410 passed, including semantic tamper denial. |
| `CI=true npm ci --no-audit --no-fund` | Passed in fresh canonical worktree; installed proxy-addr 2.0.8 matches lock. Original cache retained. |
| `npm run type-check` | Canonical passed; initial security digest mismatch led to independently reviewed pin update, with no guard bypass. |
| `npm run lint` | Canonical passed: 0 errors, 77 warnings. Focused final healing/runtime lint also passed. |
| `npm run build` | Canonical passed, including boundary, shared/worker/root compiler, source/compiled preview containment and alias gates. |
| `npm run validate:railway` | Passed, local static compatibility only. |
| `npm run docs:check` | 943 checks passed; generated-index check passed after four-artifact regeneration. Final receipt checks passed before commit. |
| `npm run docs:links -- --local-only` | 714 local targets passed; 109 external URLs discovered, network checks skipped. Final receipt links passed before commit. |
| `npm run reindex` and `npm run reindex:check` | Regeneration/check passed for the added integration fixture. |
| `npm run guard:commit`, `git diff --check` | Passed for each source commit. Initial guard rejected an ambiguous synthetic bearer fixture; it was explicitly labeled `test` without weakening the guard. |
| `npm test -- --coverage=false --maxWorkers=2 --workerIdleMemoryLimit=768MB` | Canonical passed: 896 suites, 17,485 cases; 13 suites/167 cases skipped; zero failures. Coverage collection intentionally disabled; assertions retained. |
| `node --test arcanos-ai-runtime/tests/admission_redis.integration.test.js` | Blocked before connection: disposable loopback Redis confirmation required. Real Redis cases not executed; no authorization flag supplied. |

The first broad root attempt with
four workers and no explicit recycling limit
was stopped before completion for resource control and is excluded from pass
totals. Its contained-application timeout passed in the bounded diagnostic
sweep. The cached-dependency broad diagnostic also exposed the locked-proxy
guard failure and missing PowerShell; neither is treated as a passing canonical
run. The canonical sweep passed all executed cases, including the original
proxy guards and PowerShell fixtures. No failed check was replaced with a live
probe or authorization override.

Skipped/unavailable evidence: guarded real PostgreSQL and root Redis integration
cases were not enabled; the standalone real Redis suite explicitly refused
execution without disposable-loopback confirmation. No database target was
provisioned or mutated. Windows-only projector stop/ack cases were skipped on
Linux. Other suite-owned opt-in/platform cases remain within the root's reported
167 skips. Full Python daemon pytest, iOS hardware, live-provider, live Railway,
production requests and cross-service mitigation acceptance were not run.

## Remaining risks and deployment compatibility

- Generic budgets remain process-local and reset on restart. Shared production
  provider admission remains Redis-owned and fail-closed. The atomic model does
  not prove real Redis Lua concurrency or production readiness.
- Anonymous NAT/proxy users share trustworthy ingress budgets. The unchanged
  default Express trust policy can aggregate Railway ingress users. Capacity
  exhaustion deliberately denies new legitimate identities until expiry cleanup.
  Explicitly misconfigured broad proxy trust still grants broad trust.
- Existing MCP/ActionPlan secondary credential tiers retain session-first
  compatibility keys behind independent client and authenticated-principal
  limits. No overall bypass was reproduced there; this remains a policy gap.
- V2 state and canonical ownership exclusion are local to one process. This
  change does not deliver a Worker mitigation to a separate V2 service or prove
  distributed recovery. Dedicated Worker startup remains unchanged; no healing
  feature is enabled. Missing production logs prove no successful mitigation.
- Existing prompt-route mitigation has no TTL, and Trinity CLEAR remains a
  separate optional controller/proposal trigger. Multiple simultaneous V2
  stage actions can also make snapshot/outcome attribution ambiguous. These
  existing behaviors are characterized, with no new distributed owner or
  speculative correction introduced.
- Default standalone runtime behavior remains one pass. External source callers
  using removed internal `secondPassThreshold` must intentionally migrate;
  HTTP/queued-job shapes are unchanged.
- No schema, migration, dependency, lockfile, credential, environment variable,
  Railway build/start role, readiness, route path or public response-shape change.
  Future deployment must retain existing protected digests and approval gates.
  A separately authorized rollback can revert these focused commits; normal
  mitigation expiry/rollback remains bounded and covered locally.
- Supplied production evidence remains diagnostic: successful V2/Worker
  deployments, zero reported failed deployments in the 24-hour check, repeated
  V2 role-disable logs, unverified configuration values, no live mitigation
  proof, and tracing disabled on both services. None authorizes feature changes.
- Original Gaming incident remains open until separate live acceptance. No live
  provider, production request, deployed end-to-end or cross-service acceptance
  was attempted.

The PR remains draft and is not merge-ready pending remote required checks and
human/security review. Remote main currently advertises `docs:check` and
`All Checks Complete`; full branch-protection approval settings returned HTTP
403 to the connected integration and are unknown. Local fixtures cannot
establish production acceptance.
