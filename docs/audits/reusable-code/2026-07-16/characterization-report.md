# Phase 1 characterization report

All paths and behaviors below refer to source commit `462e279f264372d42be4c9781a98fe72b6f498a5`.

## Audit-safe state matrix

Affected implementations:

- `src/core/persistenceManagerHierarchy.ts`
- `src/services/persistenceManager.ts`
- `src/services/auditSafeToggle.ts`

Direct production consumers:

| Implementation | Direct readers/writers |
|---|---|
| Core hierarchy | `src/core/startup.ts`; `src/platform/runtime/environmentSecurity.ts` |
| Persistence service | `src/services/backstage-booker.ts` |
| Toggle service | `src/services/cef/handlers/auditSafe.handler.ts`; `src/services/commandCenter.ts` |

Cross-module transitions:

| Transition | Core hierarchy reports | Persistence service reports | Toggle reports |
|---|---|---|---|
| Fresh import | `true`, override false | `true`, override false | `true` |
| Set core to `false` | `false`, override false | unchanged `true` | unchanged `true` |
| Set persistence to `passive` | unchanged | `passive`, override false | unchanged |
| Set toggle to `log-only` | unchanged; mode rejected if supplied | unchanged; mode rejected if supplied | `log-only` |
| Enable authorized core override | selected mode, override true | unchanged | unchanged |
| Enable authorized persistence override | unchanged | selected mode, override true | unchanged |
| Repeat a successful set without override | mode retained, override removed | mode retained, override removed | repeated log; same mode |
| Re-import without registry reset | state retained | state retained | state retained |
| Re-import after Jest module reset | default restored | default and memory store restored | default restored |

Failure semantics:

| Scenario | Core hierarchy | Persistence service | Toggle |
|---|---|---|---|
| Mode-change audit/log fails | Promise rejects with critical audit failure; new state remains visible | File append error is logged and swallowed; new state remains visible | Logging exception propagates; new state remains visible |
| Sixth denied override | Logs attempt 6, then throws “Too many” | Same threshold; file audit is best-effort | Not applicable |
| Successful set after denials | Resets local counter | Resets local counter | No counter |
| Strict invalid save | Transaction path rejects, rollback event attempted | Throws and leaves an empty module bucket | Throws |
| Passive invalid save | Warning audit, then persists | Warning file audit, then persists | Warns and returns data |
| Disabled save | Persists without validator | Persists without validator | Returns data without validator |
| `log-only` save | Unsupported | Unsupported | Validator still runs; invalid data is logged and returned |
| Persistence/audit metrics | No metric integration | No metric integration | No metric integration |

Runtime tests independently exhaust the core and persistence-service override counters and interleave updates across all three modules. Each implementation retains its own counter/state; interleaved persistence-service updates do not become visible in the core hierarchy or toggle.

Runtime characterization: `tests/reusable-code-audit-audit-safe.characterization.test.ts`.

## Module-loader report

Affected file: `src/services/moduleLoader.ts`.

| Inventory | Evaluated | Accepted static candidates | Rejected default without actions | Rejected without default |
|---|---:|---:|---:|---:|
| Source `src/services` | 134 | 13 | 14 | 107 |
| Machine-local compiled `dist/services` | 138 | 13 | 14 | 111 |

Compiled-only files:

- `dist/services/gptAccessOperator.js`
- `dist/services/gptAccessOperatorRegistry.js`
- `dist/services/gptIntegrationActions.js`
- `dist/services/persistedSessionService.js`

The compiled row preserves ignored machine-local generated state and is explicitly not source-reproducible. A clean source-derived build is expected to evaluate 134 modules, predict 13 accepted candidates, and contain no compiled-only service files.

Observed loader contract:

- raw `readdir` order is preserved; no explicit sort exists;
- imports are sequential;
- any truthy `default.actions` value is accepted, including empty or malformed values;
- missing default/actions is rejected only after full module evaluation;
- import failures are logged and processing continues unless logging itself throws;
- the returned array is cached by mutable reference;
- cache reset does not clear ESM state or undo side effects;
- concurrent cold loads are not coalesced;
- a stalled top-level import blocks every later file;
- directory discovery failure rejects before per-file handling.

Static real-import side effects include dotenv loading, event-loop monitoring, Prometheus registration, filesystem directory creation/reads, prompt integrity reads, safety-state hydration, singleton creation, and logging/telemetry initialization. Same-process real-import characterization is intentionally blocked because not all effects expose safe reset APIs.

Fixture runtime characterization: `tests/reusable-code-audit-module-loader.characterization.test.ts`.

## Queue waiter matrix

Affected files:

- `src/services/queuedAskCompletionService.ts`
- `src/services/queuedGptCompletionService.ts`

| Stored status/value | Ask waiter | GPT waiter |
|---|---|---|
| `completed` | `completed` | `completed` |
| `failed` | `failed` | `failed` |
| `cancelled` | `failed` | `cancelled` |
| `expired` | `pending` | `expired` |
| `pending`, `running`, `queued` | `pending` | `pending` |
| unknown, malformed, or `not_found` status | `pending` | `pending` |
| repository returns `null` | `missing` | `missing` |
| completed with missing result | `completed` unchanged | `completed` unchanged |

Timing and failure behavior:

- Ask default wait: 15,000 ms; GPT default wait: 3,500 ms.
- Both clamp positive waits to 30,000 ms and positive explicit polls to 50–1,000 ms.
- Invalid explicit poll input returns the environment fallback without re-clamping it.
- Explicit zero wait performs zero clock, repository, and sleep calls.
- The deadline comparison is inclusive. Nominal reads are `ceil(wait/poll) + 1`; maximum nominal reads are 601.
- No independent poll-count cap exists; backward or stalled clocks can extend polling.
- Repository, sleep, clock, and dependency-originated `AbortError` failures propagate unchanged.
- An extra or request-scoped abort signal is ignored because neither waiter accepts or reads one.
- Repeated and concurrent waits duplicate repository reads; there is no cache/coalescing.
- Reads are side-effect-free at this layer and preserve the original job object.

Runtime characterization: `tests/reusable-code-audit-queue-waiters.characterization.test.ts`.

## OpenAI conversion parity

Affected converters:

- `src/core/adapters/openai.adapter.ts`
- `src/services/openai/requestBuilders/convert.ts`
- `workers/src/infrastructure/sdk/openai.ts`

| Field/fixture | Core adapter | Service converter | Worker converter |
|---|---|---|---|
| Text/fragments/items/order | Same shared extraction | Same | Same |
| Refusal parts | Text dropped; `refusal: null` | Same | Same |
| Incomplete/max tokens | `finish_reason: length`; metadata flags | Same | `finish_reason: stop`; no flags |
| Content filter | `content_filter`; metadata flag | Same | `stop`; no flag |
| Function/tool item | `tool_calls`, but call payload omitted | Same | `stop`; call payload omitted |
| Responses usage | Normalized | Same | Independently normalized |
| Explicit zero total with nonzero parts | Recomputed sum | Same | Preserves zero total |
| Legacy usage with truthy `total_tokens` | Prompt/completion become zero; total retained | Same | Same |
| Provider metadata/status/incomplete details | Attached | Attached | Dropped |
| Provider-specific unknown fields | Dropped | Dropped | Dropped |
| Missing ID | `legacy_<time>` | Same | `worker_legacy_<time>` |
| Null/undefined root response | Throws `TypeError` | Throws `TypeError` | Throws `TypeError` |

The shared golden suite contains 24 provider payloads plus null and undefined roots. Core and service are equal for ordinary JSON payloads; their only theoretical difference is property-getter evaluation order.

Difference classifications:

| Required classification | Evidence-backed assessment |
|---|---|
| Proven intentional | None. No repository contract or ownership document proves that a converter divergence is intentional. |
| Likely intentional | The worker-specific `worker_legacy_<time>` fallback prefix and metadata-light envelope appear deliberate because they are implemented in the separate worker SDK, but this remains an inference. |
| Unexplained | Explicit zero `total_tokens` is recomputed by core/service and preserved by worker; no supporting contract explains the difference. |
| Potential defect | Worker maps incomplete, truncated, content-filtered, and tool-related Responses output to ordinary `finish_reason: "stop"`; all converters drop refusal text and callable tool/function payloads, while core/service can still emit `tool_calls` as the finish reason. |
| Blocked by insufficient evidence | Whether downstream worker consumers require provider metadata, refusal content, or executable tool-call structure cannot be decided without an authoritative response-schema owner and consumer contract. |

Runtime characterization:

- `tests/fixtures/openai-response-conversion.ts`
- `tests/openai-response-conversion-parity.test.ts`

## Ask/system-state parity

Duplicate builders:

- `src/routes/ask/index.ts`
- `src/services/systemState.ts`

With a fixed clock, shared intent store, safe session ID, and compatible Ask route mode, successful response bodies are field-for-field equal.

Differences retained:

| Surface | Ask `/brain` system-state branch | Direct `/system-state` |
|---|---|---|
| Route availability | Requires Ask compatibility mode; default mode is gone | Direct GET/POST |
| Request mode | Requires `mode: system_state` | No mode required |
| Session ID | Sanitized, max 100 | Trim/nonempty only |
| Expected version | Integer minimum 1 | Any integer before store behavior |
| Invalid request | 400 `{error, details}` | 400 nested `{ok:false,error:{code,message}}` |
| Conflict | 409 raw conflict | 409 nested `SYSTEM_STATE_CONFLICT` envelope |
| Headers/logging | Deprecation/canonical/Link, response bytes, prompt-debug and bounded-response logging | No Ask deprecation or prompt-debug behavior |
| AI metrics | Branch occurs before AI trace start | Not applicable |

The shared system-state intent store has no reset export. Characterization uses unique deterministic session IDs to avoid cross-test collisions, but cannot remove inserted entries from the module-scoped map. A test-only reset seam is a documented later-phase prerequisite; none was added in this phase.

## CLEAR recheck parity

Duplicate builders:

- `src/routes/plans.ts`
- `src/mcp/server/helpers.ts`

Both currently produce:

```text
actions[{action_id,agent_id,capability,params,timeout_ms}]
origin
confidence
hasRollbacks
capabilitiesKnown=true
agentsRegistered=true
```

They preserve action order and duplicates, forward params by reference, generate no identifiers, and treat any non-null rollback value as a rollback. Security-looking values in params are forwarded unchanged. Runtime characterization through the actual HTTP handler and `createMcpServer` → `plans.execute` confirms the recheck payloads are equal; HTTP and MCP execution envelopes remain intentionally separate.

| Runtime scenario | HTTP plans surface | MCP `plans.execute` surface |
|---|---|---|
| Capability gate rejects | Stops before CLEAR or persistence; HTTP error envelope | Stops before CLEAR or persistence; MCP error envelope |
| CLEAR decision blocks | Calls `blockPlan`, returns HTTP 403 | Calls `blockPlan`, returns `ERR_GATED` |
| CLEAR allows, stored `clearScore` is `null` | Persists `clearDecision: "block"` | Persists `clearDecision: "block"` |
| `blockPlan` throws | Generic HTTP 500 response | `ERR_INTERNAL` includes the thrown message |

The null-score persistence result is a potential correctness defect, and MCP inclusion of the thrown message is a potential disclosure. Both are preserved, not corrected.

## Route-collision report

| Method/path | Earlier registration | Later registration | Current consequence |
|---|---|---|---|
| POST `/api/reusables` | `register.ts` → `apiRouter` → `api/index.ts` → reusable router, with memory consistency gate | Direct reusable router mount | First terminating handler wins; second is normally shadowed |
| GET `/api/reusables/health` | Same nested chain | Same direct mount | First terminating handler wins; middleware stacks differ |
| POST `/audit` | Legacy AI endpoints, when enabled | Reinforcement router | Legacy handler shadows reinforcement handler when enabled |
| POST `/api/update` | Public API update router | Daemon router | Public handler shadows daemon handler |
| GET `/health` | Health group health router | Status router, then reinforcement router | First health handler shadows later handlers |

The duplicate reusable-code mount is detected but not removed. Runtime composition confirms the consequence for `GET /api/reusables/health`: `apiRouter` followed by the direct reusable router executes the memory consistency gate and terminates before the direct mount; reversing those two mounts lets the direct router terminate first and bypasses that gate.

## Timing-safe credential comparison matrix

| Implementation | Comparison form | Input normalization/quirks |
|---|---|---|
| `src/mcp/auth.ts` | Raw UTF-8 buffer, length guard | Exact whole `Bearer <token>` header; case/space-sensitive; token captured at import |
| `src/routes/worker-helper.ts` | Raw UTF-8 buffer, length guard | Config/header/Bearer trimmed; an empty helper header falls back to Bearer, while a whitespace-only helper header trims to empty and blocks that fallback |
| `src/services/controlPlane/approval.ts` | Raw UTF-8 buffer, length guard | Both values trimmed |
| `src/services/gptDagBridge.ts` | Raw UTF-8 buffer, length guard | Bearer parsed case-insensitively; whitespace-only primary env suppresses fallback |
| `src/services/rootDeepDiagnosticsBridge.ts` | Raw UTF-8 buffer, length guard | Exact full Authorization header; exported authorizer has no static consumer |
| `src/services/customGptBridgeService.ts` | SHA-256 digests | Config/provided values trimmed; parsed Bearer takes precedence over action secret |
| `src/services/gptAccessGateway.ts` | SHA-256 digests plus JS-length equality | 4,096-code-unit cap; provided token trimmed, configured value not trimmed |

All are case-sensitive for token content and perform no Unicode normalization. Tests verify behavior and non-disclosure; they do not attempt to benchmark constant-time guarantees.

## Coverage clarity

- Configured scope: 94 files.
- Fresh deterministic summary: 3,313/3,313 statements, 3,313/3,313 lines, 62/62 functions, 212/212 branches.
- Root-backend executable TypeScript denominator: 717 files.
- Root-backend file representation: 94/717, or 13.1102%.
- Monorepo production-root denominator: 803 files across `src/`, four package `src/` roots, `workers/src/`, and `arcanos-ai-runtime/src/`.
- Monorepo production-root representation: 94/803, or 11.7061%.
- Root-backend exclusions: three tracked declaration files; the monorepo context additionally excludes tests, fixtures, tooling, and files outside the seven explicit production roots.
- The configured 100% result is not repository-wide 100%.

## Worker/runtime ownership

| Runtime model | Entrypoint or control surface | Queue/execution model | Repository evidence |
|---|---|---|---|
| Web API | `src/start-server.ts` through `scripts/start-railway-service.mjs` | Enqueues PostgreSQL jobs; direct worker calls can execute synchronously | Canonical Railway `ARCANOS_PROCESS_KIND=web` process |
| Dedicated async worker | `src/workers/jobRunner.ts` through `scripts/start-railway-service.mjs` | Claims `ask`, `dag-node`, and `gpt` jobs from PostgreSQL | Canonical Railway `ARCANOS_PROCESS_KIND=worker` process |
| In-process worker runtime | `src/platform/runtime/workerConfig.ts` | EventEmitter dispatch with four listeners by default | Direct-dispatch runtime; also transitively evaluated by the dedicated worker |
| Dynamic scheduled worker boot | `src/platform/runtime/workerBoot.ts` | Dynamic worker imports plus `node-cron` | Exported and test-referenced; no production invocation was found |
| `workers/` workspace | `workers/src/workers/*.ts` | In-memory typed EventEmitter queue and one environment-provided job | Built by the root build, but no canonical Railway launcher was found |
| `arcanos-ai-runtime/` | `arcanos-ai-runtime/src/server.ts` and `worker.ts` | BullMQ/Redis `ai-jobs` queue | Independently testable; no root build/start or Railway wiring was found |
| Autoscaling scaffolds | `src/workers/{manager,queueService,scaler,metricsAgent,autoscalingLoop}.ts` | In-memory architectural model | No inbound root production edge was found |

The highest-risk ownership path is statically confirmed:

```text
src/workers/jobRunner.ts
  -> src/routes/_core/gptDispatch.ts
  -> src/routes/modules.ts (top-level loadModuleDefinitions)
  -> src/services/moduleLoader.ts (evaluates every top-level service)
  -> src/services/workerControlService.ts (rejected only after evaluation)
  -> src/platform/runtime/workerConfig.ts (import-time startWorkers)
```

Consequently, the authoritative PostgreSQL poller process also registers the separate in-process listeners when worker mode is enabled. Those listeners do not claim database jobs, but their lifecycle, logs, status, and direct-dispatch semantics coexist with the poller. This is statically observed and corroborated by the deterministic loader inventory; no live Railway process was started. Alternative `npm start`, `npm run start:worker`, and `Procfile` entrypoints do not enforce the launcher as strictly, and actual external deployment ownership remains unverified.

## Remaining characterization risks

- Real source-wide module-loader imports remain blocked because rejected modules can register irreversible or unresettable process state. The accepted list is an AST prediction, not proof that every module imports successfully in every environment.
- A safe dedicated-worker import test remains blocked pending complete database, OpenAI, listener, timer, signal-handler, and module-loader isolation. The transitive in-process worker startup is therefore statically, not runtime, observed.
- `workers/`, `arcanos-ai-runtime/`, dynamic worker boot, and autoscaling scaffolds have no repository-declared canonical production owner; unpublished external consumers were not discoverable without querying external systems.
- The ignored `dist/services` inventory is machine-local and cannot be reconstructed from the source commit; a clean source build is expected to contain 134 evaluated modules and no compiled-only files.
- The system-state intent store has no reset export; unique session IDs isolate tests but leave in-process entries until Jest tears down the module.
- Queue waiters accept no abort signal and can continue after outer request cancellation.
- CLEAR allow decisions with a stored null score persist as `block`, and MCP internal errors can include a dependency-thrown message.
- Coverage branch instrumentation produced one pre-change 213-versus-212 inconsistency even though all configured metrics remained 100%.

## Determinism and cleanup

The new tests:

- restore `process.env`;
- restore real/fake timers and fixed system time;
- reset Jest module registries where stateful imports are involved;
- restore spies and mock implementations;
- reset OpenAI adapter singletons;
- remove fixture event listeners and timers;
- use injected repositories, clocks, sleeps, filesystem, audit stores, and OpenAI clients;
- make no real database, Redis, OpenAI, network, worker, scheduler, or Railway call;
- do not start servers;
- write no workspace file outside the dated audit directory;
- contain no secret values, random IDs, developer-specific snapshot paths, or uncontrolled timestamps.

Metrics and logger registries are marked not applicable where the characterized production modules do not import them; no fake reset API was invented.
