# ARCANOS Credential Verification Contract

> Historical lifecycle note: This is the Phase 2A inventory snapshot for the cited 2026-07-16 commits. Its O-01 through O-20 consumer set is fixed evidence, not an exhaustive inventory of current credential consumers; later boundaries, including ActionPlan execution authentication, fall outside that count. The opaque-comparison and protocol-extraction principles remain normative, but use current source to inventory active consumers.

- Status: Phase 2A authoritative contract
- Scope: opaque credentials, protocol extraction, and credential-safe observability
- Baseline: `codex/reusable-code-audit-phase0-1` at `6cf4a6d12f949e9c96fdd81d844c2ac7076065c5`
- Audit source commit: `462e279f264372d42be4c9781a98fe72b6f498a5`
- Contract date: 2026-07-16

## Purpose

This contract separates two responsibilities that were previously repeated together:

1. A protocol boundary extracts and normalizes a credential according to that protocol.
2. A dependency-light primitive compares two already-extracted opaque secrets without interpreting them.

The comparison primitive is not an authentication framework, Bearer parser, header resolver, token store, password hasher, signature verifier, or JWT verifier. It must not erase intentional protocol differences.

The Phase 1 characterization audit is the behavior baseline. Phase 2A consolidates equality for the seven characterized TypeScript consumers, ten additional TypeScript boundaries protected by decision tests, and three Python boundaries through a language-local mirror. Protocol parsing and non-equality policy remain boundary-owned.

## Normative terms

- **Configured secret**: an opaque, high-entropy credential obtained from an approved configuration source.
- **Provided secret**: an opaque credential extracted from a request, command payload, or other caller-controlled boundary.
- **Extraction**: selecting a header, field, or protocol token.
- **Normalization**: protocol-owned transformations such as trimming, case-insensitive Bearer scheme recognition, or header precedence.
- **Opaque comparison**: exact equality after extraction and normalization are complete.
- **Missing**: `undefined`, `null`, a non-string runtime value, or an empty string at the primitive boundary.
- **Blank**: a non-empty whitespace-only string. The primitive does not trim it; boundary policy must reject or preserve it explicitly.

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative.

## Opaque-secret primitive

### TypeScript contract

The authoritative TypeScript operation is:

```ts
timingSafeEqualOpaqueSecret(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean
```

It MUST implement these semantics:

1. Return `false` when either value is not a JavaScript string.
2. Return `false` when either string is empty.
3. Apply no trimming, Unicode normalization, case folding, prefix removal, scheme parsing, coercion, or fallback selection.
4. Encode the exact JavaScript UTF-16 code-unit sequence as UTF-16LE. This is injective over JavaScript string values, including lone surrogates.
5. Compute a SHA-256 digest of each encoded value.
6. Compare the two fixed-size digests with `crypto.timingSafeEqual`.
7. Return only a boolean. It MUST NOT log, write to stdout/stderr, emit metrics, mutate state, or interpolate either input into an error.
8. Impose no primitive-wide length cap. Boundary-specific limits remain at the boundary. GPT Access and the later worker-helper hardening decision each impose a 4,096-code-unit cap; some other characterized consumers accept at least 5,000-character values.
9. Treat leading and trailing whitespace as significant.
10. Treat case as significant.
11. Treat canonically equivalent but differently encoded Unicode strings as different credentials.
12. Reject `Buffer`, numeric, boolean, object, array, `null`, and `undefined` inputs by returning `false`, not by coercion or exception.
13. Treat distinct lone-surrogate code units as distinct credentials and return a boolean for every JavaScript string.

SHA-256 is used only to create equal-size comparison inputs. It is not password hashing and does not make low-entropy credentials acceptable.

### Python mirror contract

Python boundaries that compare opaque credentials MUST use the same externally visible decisions through a language-local operation:

```py
timing_safe_equal_opaque_secret(provided: object, expected: object) -> bool
```

The Python operation MUST:

1. Return `False` unless both values are strings and both are non-empty.
2. Apply no normalization or coercion.
3. Encode the exact Python code-point sequence as UTF-32LE with surrogate preservation. This is injective over Python string values, including lone surrogates and scalar-versus-surrogate-pair distinctions.
4. Hash both values with `hashlib.sha256(...).digest()`.
5. Compare the fixed-size digests with `hmac.compare_digest`.
6. Have no primitive-wide length cap and no logging, output, mutation, or credential-bearing exceptions.
7. Return a boolean for every Python string, including strings constructed from malformed JSON Unicode escapes.

Python protocol handlers remain responsible for trimming, header parsing, query handling, and configuration capture. The Python mirror does not authorize routing TypeScript and Python requests through one runtime boundary.

### Caller obligations

Every caller MUST perform, in this order:

1. Determine whether authentication is required.
2. Read the configured secret at the boundary's documented capture time.
3. Reject an absent or boundary-invalid configured value.
4. Extract the provided value according to the protocol contract.
5. Apply only that boundary's documented normalization.
6. Apply any boundary-specific length limit.
7. Call the opaque-secret primitive.
8. Convert `false` into the boundary's existing status, error envelope, and sanitized audit event.

The primitive MUST NOT decide whether a missing value is a 401, 403, 500, or 503. It MUST NOT decide header precedence or configuration fallback.

## Opaque-boundary inventory

The repository currently has 26 security-sensitive opaque comparison boundaries. The first seven have complete Phase 1 characterization; O-08 through O-20 received focused Phase 2A decision tests before migration, and O-21 through O-26 were added with focused boundary tests.

| ID | Boundary and evidence | Extraction and normalization | Configuration source and capture | Pre-Phase-2A equality | Disposition |
|---|---|---|---|---|---|
| O-01 | MCP HTTP: `src/mcp/auth.ts`; consumer `src/routes/mcp.ts` | Entire raw `Authorization` header is compared with ``Bearer ${token}``; no request trim; scheme and spacing are exact | `MCP_BEARER_TOKEN` through `getEnv`, captured at module import | UTF-8 buffers, byte-length branch, `crypto.timingSafeEqual` | Migrated; equality only |
| O-02 | Custom GPT bridge: `src/services/customGptBridgeService.ts`; route `src/routes/bridge.ts` | Case-insensitive, whitespace-normalizing Bearer extraction; action-secret header fallback; a present Bearer value takes precedence even when invalid | `OPENAI_ACTION_SHARED_SECRET`, read per invocation or injected; expected and action-secret values trimmed | SHA-256 digests plus `timingSafeEqual` | Migrated; parsing and precedence preserved |
| O-03 | Control-plane approval: `src/services/controlPlane/approval.ts`; executor `src/services/controlPlane/executor.ts` | `request.approvalToken`; supplied and configured values trimmed | `ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN`, read per call or injected | UTF-8 buffers, byte-length branch, `crypto.timingSafeEqual` | Migrated; decision statuses preserved |
| O-04 | GPT Access: `src/services/gptAccessGateway.ts`; mount `src/routes/gpt-access.ts` | Case-insensitive Bearer parser; application-level leading scheme whitespace rejected; extracted token trimmed | `ARCANOS_GPT_ACCESS_TOKEN`, read per request; raw configured value retained after a trim-only presence check | SHA-256 digests, `timingSafeEqual`, JS-length equality, 4,096-code-unit cap | Migrated; cap and application-level whitespace asymmetry retained |
| O-05 | GPT DAG bridge: `src/services/gptDagBridge.ts`; consumer `src/routes/gptRouter.ts` | Case-insensitive, whitespace-normalizing Bearer extraction | `GPT_DAG_BRIDGE_BEARER_TOKEN`, otherwise `OPENAI_ACTION_SHARED_SECRET`, read per request and trimmed; whitespace-only primary suppresses fallback | UTF-8 buffers, byte-length check, `crypto.timingSafeEqual` | Migrated; fallback suppression preserved |
| O-06 | Worker helper authentication: `src/transport/http/middleware/workerHelperPrivilegedAuth.ts`; consumers `src/routes/worker-helper.ts` and `src/routes/workers.ts`; mount `src/routes/register.ts` | Exactly one non-empty carrier: exact custom header or case-insensitive `Bearer <token>` with one separator; empty custom header remains absent for Bearer fallback; duplicate headers, simultaneous carriers, whitespace, and values outside 32–4096 characters fail closed | `ARCANOS_WORKER_HELPER_TOKEN`, read per request as an exact 32–4096 character non-placeholder value with no whitespace; reuse of another canonical purpose-bound credential fails closed | SHA-256 digests and `crypto.timingSafeEqual` through the shared opaque-secret primitive | Hardened; generic 401 retained; existing worker-helper role/context alternatives preserved; direct worker run and heal exclude daemon markers and operator audit labels, then apply confirmation; heal entry points share a principal budget |
| O-07 | Root deep diagnostics: `src/services/rootDeepDiagnosticsBridge.ts` | Entire raw `Authorization` header versus ``Bearer ${token}``; exact scheme/spacing | `ARCANOS_ADMIN_TOKEN`, read per call without trimming | UTF-8 buffers, byte-length branch, `crypto.timingSafeEqual` | Migrated; still no production consumer found |
| O-08 | Metrics: `src/platform/observability/appMetrics.ts`; consumer `src/app.ts` | Trims custom header; Authorization removes a Bearer prefix only if present, so a bare Authorization value is accepted | `METRICS_AUTH_TOKEN`, read per request and trimmed; absent means public endpoint | Ordinary `===` | Migrated after Bearer/bare/custom-header decisions; public-unconfigured policy preserved |
| O-09 | Debug confirmation: `src/routes/debug-confirmation.ts`; mount `src/routes/register.ts` | Configured custom header; provided value is not application-trimmed, while Node removes transport OWS | `ARCANOS_AUTOMATION_SECRET` read per request by `getAutomationAuth`; expected trimmed | Ordinary `!==` | Migrated after route and no-disclosure decisions |
| O-10 | Capability-gate bypass: `src/transport/http/middleware/capabilityGate.ts` | Configured custom header; provided value not trimmed; successful match plus capability bypasses agent lookup | `ARCANOS_AUTOMATION_SECRET`, read per request and trimmed | Ordinary `===` | Migrated after bypass decision test |
| O-11 | Confirm-gate bypass: `src/transport/http/middleware/confirmGate.ts` | Configured custom header; provided value not trimmed | `ARCANOS_AUTOMATION_SECRET` and header name captured at module import | Ordinary `===` | Migrated; import-time capture preserved and tested |
| O-12 | Bridge WebSocket: `src/services/bridgeSocket.ts` | Custom automation header after Node parsing; wrong/missing value falls back to one-time-token consumption | `ARCANOS_AUTOMATION_SECRET`, read per upgrade and trimmed | Ordinary `===` | Migrated through the production upgrade verifier; runtime ownership remains unresolved |
| O-13 | Debug watchdog: `src/routes/register.ts` | Raw `x-debug-key` after Node parsing; exact comparison; no alternate carrier | `DEBUG_WATCHDOG_KEY`, read per request through strict purpose-bound configuration; missing, invalid, placeholder-like, padded, or colliding configuration is unavailable | Ordinary `!==` | Hardened by DW-01; enabled-but-unavailable configuration returns generic 503 and never exposes watchdog data |
| O-14 | Core root override: `src/core/persistenceManagerHierarchy.ts` | Raw function token; requires explicit flag, admin role, and non-empty values | `ROOT_OVERRIDE_TOKEN`, read per call through `getEnv` | Ordinary `!==` | Migrated; state implementation remains independent |
| O-15 | Service root override: `src/services/persistenceManager.ts` | Raw function token; requires explicit flag and admin role; `getEnv` normalizes blank config to missing | `ROOT_OVERRIDE_TOKEN`, read per call | Ordinary `===` | Migrated; state implementation remains independent |
| O-16 | Daemon heartbeat store partition: `src/routes/api-daemon.ts` | No credential comparison; resolves a route-local historical partition or the canonical non-secret `anonymous-daemon` marker after transport auth | Runtime daemon store; historical values are compatibility-only and never attached to request context | Not applicable | Superseded by DAEMON-01; partition resolution/registration completes before heartbeat mutation and never persists the transport credential |
| O-17 | Pending daemon-action partition binding: `src/routes/daemonStore.ts`; adapter `src/routes/api-daemon/pending.ts` | Stored instance partition versus route-local partition after confirmation-token and instance checks | Runtime daemon store | `timingSafeEqualOpaqueSecret` | Preserved for compatibility; DAEMON-01 requires successful heartbeat registration before route-level confirmation consumption |
| O-18 | Python local CLI bridge: `daemon-python/arcanos/cli/local_bridge.py` | Exact `x-arcanos-cli-bridge-token` header; health is unauthenticated | `ARCANOS_CLI_BRIDGE_TOKEN`, trimmed and captured when `LocalBridge` is constructed | Truthiness guards plus direct `hmac.compare_digest` | Migrated to the Python mirror; Unicode follows exact Python string identity |
| O-19 | Python debug server: `daemon-python/arcanos/debug_server.py` | Raw automation header; case-sensitive `Bearer ` with trimmed token; trimmed `X-Debug-Token`; optional raw query token | Automation secret read per request and trimmed; `Config.DEBUG_SERVER_TOKEN` captured with class config | Ordinary `==` across four transports | Migrated; extraction preserved and query-path disclosure removed |
| O-20 | Python CLI debug command: `daemon-python/arcanos/cli_runner.py` | JSON token coerced to string and trimmed | `ARCANOS_DEBUG_CMD_TOKEN` trimmed once from one environment read, or a generated one-time token delivered only to a terminal-attached console | Ordinary `!=` | Migrated; token-derived filename replaced with credential-independent randomness and redirected output now requires configured authentication |
| O-21 | HTTP control-plane authentication: `src/services/controlPlane/httpAuth.ts`; consumers `src/routes/control-plane.ts`, `src/routes/api-control-plane.ts`, `src/routes/api-codebase.ts`, `src/routes/api-prompt-debug.ts`, `src/routes/api-ai-routing-debug.ts`, the idempotent diagnostic-execution and legacy-operator boundaries in `src/services/controlPlane/diagnosticExecutionHttpBoundary.ts` and `src/services/controlPlane/legacyOperatorHttpBoundary.ts`, and the self-healing control boundary in `src/services/controlPlane/selfHealingControlHttpBoundary.ts`, `src/routes/self-heal.ts`, `src/routes/self-improve.ts`, and `src/routes/safety.ts` | Exactly one case-sensitive `Bearer <opaque-value>` header; no application trimming; duplicate headers rejected; visible ASCII without whitespace; 4,096-code-unit cap | `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN`, read per request with a 32-character minimum, the same visible-ASCII carrier grammar, and purpose-bound credential isolation | `timingSafeEqualOpaqueSecret` | Extended by SH-01 through SH-03, diagnostic-read and trace containment, DX-01 execution containment, and LO-01 legacy-operator containment with operator/scoped authorization, bounded limiting, no-store responses, and control-before-writing-plane composition tests |
| O-22 | Memory/session-plane HTTP authentication: `src/transport/http/middleware/memoryPlaneAuth.ts`; production API mounts `src/app.ts` and `src/routes/api/index.ts`; GPT consumer `src/routes/gptRouter.ts` | Exactly one case-sensitive `x-arcanos-memory-token`; no Bearer/query/body/cookie fallback; duplicate, non-string, whitespace-bearing, and values outside 32–4096 characters rejected | `ARCANOS_MEMORY_ACCESS_TOKEN`, read per request with purpose-bound credential isolation | SHA-256 digests and `crypto.timingSafeEqual` through the shared opaque-secret primitive | Added with fail-closed configuration/request decisions, pre-parser `/api/memory*`, `/api/save-conversation*`, and `/api/sessions*` containment, non-storable authenticated responses, composition tests, exact GPT interception, and defensive dispatcher authorization |
| O-23 | Daemon-plane HTTP authentication: `src/transport/http/middleware/daemonPlaneAuth.ts`; router `src/routes/api-daemon.ts`; Python client `daemon-python/arcanos/backend_client/__init__.py` | Exactly one case-sensitive `x-arcanos-daemon-token`; no Bearer, GPT-ID, cookie, query, or body fallback; duplicate, non-string, whitespace-bearing, and values outside 32–4096 characters rejected | `ARCANOS_DAEMON_ACCESS_TOKEN`, read per backend request with purpose-bound credential isolation and loaded independently by the Python daemon with no generic-token fallback | SHA-256 digests and `crypto.timingSafeEqual` through the TypeScript shared opaque-secret primitive | Added by DAEMON-01 with fail-closed server and client configuration, control-plane composition, custom-header-only Python transport, and no generic auth refresh |
| O-24 | Standalone AI runtime HTTP authentication: `arcanos-ai-runtime/src/auth/runtimeHttpAuth.ts`; app factory `arcanos-ai-runtime/src/app.ts` | Exactly one case-sensitive `Bearer <opaque-value>` header; duplicate Authorization headers and every alternate carrier are rejected; visible ASCII without whitespace; 32–4096-character bounds | `ARCANOS_AI_RUNTIME_ACCESS_TOKEN`, read with a bounded principal ID that rejects the reserved historical owner `anonymous` and the exact `runtime:enqueue`/`runtime:read` scope set once at request ingress; the token is part of the canonical application credential registry | SHA-256 digests and `crypto.timingSafeEqual` | Added by RT-01; authentication and endpoint scope precede parsing, job ownership is server-owned, absent/legacy/cross-principal reads share one 404, and import-safe mock-queue tests initialize neither Redis nor OpenAI |
| O-25 | Gaming source lifecycle HTTP authentication: `src/services/gamingSourceAccessAuth.ts`; pre-parser boundary `src/services/gamingSourceHttpBoundary.ts`; leaf-route defense in `src/routes/gpt-access.ts` | At most one `Authorization` header; an accepted value is exactly case-sensitive `Bearer <opaque-value>` with a visible-ASCII, no-whitespace token no longer than 4,096 characters. Duplicate, missing, malformed, and incorrect credentials fail closed; no query, cookie, body, bridge, or generic GPT Access fallback exists. | Optional web-service-only `ARCANOS_GAMING_SOURCE_ACCESS_TOKEN`, read per request as an exact 32–4096-character visible-ASCII non-placeholder value with no whitespace and purpose-bound credential isolation. It is configured only on the web service and in the Arcanos Gaming Custom GPT Action; workers do not receive it. | `timingSafeEqualOpaqueSecret` | Added as a dedicated fixed-surface boundary for only source ingestion, refresh, and status. Invalid or colliding configuration returns a generic `503`; generic GPT Access credentials and scopes are rejected on this surface, and the dedicated credential cannot authenticate other `/gpt-access/*` routes. |
| O-26 | Backstage Booker canon Action authentication: `src/services/backstageBookerAccessAuth.ts`; pre-parser boundary `src/services/backstageBookerHttpBoundary.ts`; leaf-route defense in `src/routes/gpt-access.ts` | Exactly one `Authorization` header containing case-sensitive `Bearer <opaque-value>` with one space and a 32–4096-character visible-ASCII, no-whitespace token. Duplicate, missing, malformed, and incorrect credentials fail closed; the dedicated match exists only for exact `POST /gpt-access/capabilities/v1/backstage-booker/run` with no trailing-slash alias. | Optional web-service-only `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN`, resolved per request as a trimmed, non-placeholder purpose-bound credential with registry collision protection. It is configured only on the web service and in the Backstage Booker Custom GPT Action; workers do not receive it. | `timingSafeEqualOpaqueSecret` | Added as a dedicated fixed-surface boundary for only `upsertStoryline` and `appendCanonBeat`. It applies the shared GPT rate limit, a strict 256 KiB UTF-8 JSON body limit, and no-store policy before broad parsing, may bypass generic `capabilities.run` scope authorization, and still requires preflight, `MCP_ALLOW_MODULE_ACTIONS`, and service checks. Parser failures use bounded 400, 413, or 415 envelopes. Other actions fail with fixed `403 BACKSTAGE_BOOKER_ACCESS_ACTION_DENIED`; the credential cannot authorize another GPT Access route, while a generic bearer follows its unchanged scope and confirmation path. |

## Locked behavior for the original seven

Migration of O-01 through O-07 MUST preserve the following Phase 1 observations unless a later boundary-specific decision below explicitly supersedes a cell. Decision WH-01 supersedes the worker-helper normalization, cap, and configuration cells while retaining its scheme, capture time, alternatives, and generic failure mapping.

| Behavior | MCP | Custom bridge | Control plane | GPT Access | DAG bridge | Worker helper | Root diagnostics |
|---|---|---|---|---|---|---|---|
| Comparison input | Full header | Extracted secret | Body token | Extracted Bearer token | Extracted Bearer token | Custom/Bearer token | Full header |
| Scheme handling | Exact `Bearer` | Case-insensitive | N/A | Case-insensitive | Case-insensitive | Case-insensitive Bearer fallback | Exact `Bearer` |
| Application-level request whitespace | Significant | Normalized during extraction | Trimmed | Token trimmed; leading scheme whitespace rejected | Normalized | Values trimmed; whitespace-only custom header blocks fallback | Significant |
| Config whitespace | Preserved inside full header after `getEnv` nonblank check | Trimmed | Trimmed | Preserved after presence check | Trimmed | Trimmed | Preserved |
| Secret case | Significant | Significant | Significant | Significant | Significant | Significant | Significant |
| Boundary cap | None | None | None | 4,096 JS code units | None | None | None |
| Missing config | 500 | 503 | `unconfigured` | 500 | 503 when auth required | Auth alternative fails | `admin_token_missing` |
| Missing/invalid input | 401 | 401 | `missing`/`invalid` | Distinct sanitized 401 messages | 401 | Generic 401 unless another auth alternative succeeds | `authorization_missing`/`authorization_mismatch` |
| Config capture | Module import | Per call/injected | Per call/injected | Per request | Per request | Per request | Per call |

Characterization evidence is in `tests/reusable-code-audit-timing-safe-auth.characterization.test.ts`. Route-level evidence also exists in the custom bridge, GPT Access, DAG bridge, and worker-helper suites.

The table describes application-visible protocol behavior. Node's HTTP and WebSocket parsers can remove outer optional whitespace before application code runs; mocked request-object tests describe the value received by middleware, not necessarily a byte-for-byte wire contract.

The Phase 2A shared-primitive migration changed only the equality step and did not itself authorize changing any cell in this table. Its one explicit security correction was that the former UTF-8 Buffer/digest implementations could encode distinct ill-formed JavaScript strings as the same replacement bytes. The primitive now preserves exact UTF-16 code-unit identity, so distinct lone-surrogate values fail comparison. Normal HTTP header values are unaffected, and the decision is protected by primitive tests. DW-01 and WH-01 are later, separately recorded boundary corrections.

### Decision DW-01: fail-closed debug watchdog authentication

- Decision date: 2026-07-25
- Scope: conditional `GET /debug/watchdog` registration and its `DEBUG_WATCHDOG_KEY`
- Status: intentional security hardening; independently reversible from the shared opaque-secret primitive

DW-01 makes these decisions:

1. `DEBUG_WATCHDOG=true` remains a registration-time feature switch. When it is
   false or unset, the route is absent. Misconfiguration of this optional route
   does not fail application startup or global readiness.
2. When the route is mounted, `DEBUG_WATCHDOG_KEY` is resolved on every request
   through the canonical purpose-bound credential policy. The value must contain
   32–4,096 JavaScript code units, have no surrounding whitespace or placeholder
   form, and not equal another canonical application credential.
3. Missing, invalid, or colliding server configuration returns generic
   `503 Service Unavailable` with `Cache-Control: no-store` and no watchdog
   fields or configuration detail. A valid configuration with a missing or
   incorrect request credential preserves generic `403 Forbidden`.
4. The sole carrier is the exact `x-debug-key` value received after Node header
   parsing. Authorization, query parameters, cookies, and request bodies never
   authorize this route. Transport removal of optional header whitespace remains
   subject to the Node parsing caveat above.
5. Exact success remains `200` and is also no-store. Because configuration is
   read per request, replacement, revocation, invalidation, and a newly
   introduced credential collision take effect without rebuilding the Express
   app; changing `DEBUG_WATCHDOG` itself still requires route re-registration.

Compatibility impact is deliberate: an enabled route that previously exposed
watchdog data without a key now returns 503, and short, oversized, padded,
placeholder-like, or reused keys must be rotated. Exact valid custom-header
access and Node's existing header normalization behavior remain supported.

Regression evidence is in `tests/debug-watchdog-auth.test.ts` and
`tests/purpose-bound-credential.test.ts`.

### Decision WH-01: purpose-bound worker-control credentials

- Decision date: 2026-07-25
- Scope: `ARCANOS_WORKER_HELPER_TOKEN` verification shared by privileged
  `/worker-helper/*` routes, `POST /workers/heal`, and
  `POST /workers/run/:workerId`
- Status: intentional security hardening, independently reversible from the opaque-secret primitive

The Phase 1 behavior accepted short and placeholder-like configuration, normalized surrounding whitespace, had no boundary cap, permitted custom-header precedence over a simultaneous Authorization credential, and did not prevent reuse of another administrative credential. That combination made configuration mistakes and ambiguous carrier handling part of an execution-capable worker-control boundary.

WH-01 makes these decisions:

1. The configured value is read per request and MUST contain 32–4,096 JavaScript code units, MUST be exact with no whitespace, MUST NOT match the placeholder forms enforced by `purposeBoundCredential.ts`, and MUST NOT equal any other credential in that canonical ARCANOS application-auth registry after surrounding-whitespace normalization of the peer value. Provider, infrastructure, and script-only test credentials are outside this registry.
2. A token-authenticated request MUST provide one non-empty carrier: either the exact `x-arcanos-worker-helper-token` value or a case-insensitive `Bearer <token>` Authorization value with one ASCII separator. Duplicate instances of either header, simultaneous non-empty carriers, malformed Bearer syntax, request-token whitespace, runtime non-strings, and values outside 32–4,096 code units fail closed.
3. An empty application-level custom-header value remains absent so Bearer fallback remains compatible. HTTP parser removal of wire-level optional whitespace remains subject to the transport caveat above.
4. Authentication still uses the generic 401 response and emits no credential or colliding-variable detail. `operator-light` denial remains first. The existing worker-helper daemon, full-role, and established-actor alternatives remain unchanged; direct worker run and heal remain token or full-role only and still require separate confirmation.
5. The canonical configuration resolver owns validation and collision checking atomically. Express parsing, carrier precedence, roles, principals, response status, and final opaque comparison remain boundary-owned.

Compatibility impact is deliberate: deployments using values shorter than 32, longer than 4,096, padded with whitespace, placeholder-like, or reused by another canonical credential lose token authentication until configuration is rotated. Requests using simultaneous non-empty carriers or application-visible whitespace are rejected. Lowercase Bearer schemes, exact custom headers, exact Bearer tokens, empty-custom Bearer fallback, per-request environment reads, and alternate role/context authorization remain supported.

Regression evidence is in `tests/purpose-bound-credential.test.ts`, `tests/worker-helper-auth.test.ts`, `tests/reusable-code-audit-timing-safe-auth.characterization.test.ts`, `tests/worker-helper-route.test.ts`, `tests/workers-route-security.test.ts`, and `tests/workers-heal-route-security.test.ts`. Rollback restores only the former worker-helper configuration/extraction policy and its characterization expectations; doing so reopens weak configuration, credential-reuse, unbounded-input, and carrier-ambiguity risks.

### Decision WH-02: authenticated outbound worker-helper callers

- Decision date: 2026-07-25
- Scope: `scripts/worker-helper.mjs` protected commands and the remote worker repair actuator in `src/services/selfImprove/workerRepairActuator.ts`
- Status: outbound containment and fail-closed availability layered on WH-01

WH-02 makes these decisions:

1. The helper script's public `status` command remains credential-free even when `ARCANOS_WORKER_HELPER_TOKEN` is configured. Every protected script command requires the strict WH-01 token in its environment and fails before fetch when the token is missing, invalid, placeholder-like, or collides with another canonical credential.
2. The environment is the only script credential source. Token, worker-helper-token, and Authorization CLI flags are rejected. Protected script and actuator requests send exactly one `x-arcanos-worker-helper-token` carrier and never create an outbound Authorization carrier.
3. The calling process and target service MUST hold the identical worker-helper token. The remote actuator re-resolves the credential when reporting availability and again immediately before fetch so rotation, invalidation, and new credential collisions fail closed without storing the secret in status or result objects.
4. Credentialed destinations MUST be explicit exact HTTPS origins without user information, a non-root path, query, or fragment. Exact HTTP origins are accepted only for loopback CLI or actuator use. The actuator treats any invalid URL alias or multiple aliases that normalize to different origins as configured-but-unavailable.
5. Credentialed fetches reject redirects and verify that the final request path remains on the configured origin. Transport failures, non-success response bodies, and redirect bodies do not become actuator output.
6. The script reads no more than 1 MiB of JSON and redacts exact credential reflections before output. The actuator reads no more than 64 KiB of JSON and accepts only a matching `requestedForce` plus boolean `restart.started`, `restart.alreadyRunning`, and `restart.runWorkers` values and a bounded non-empty `restart.message`.
7. Remote actuator output is projected to the validated booleans plus a locally generated message. The target-controlled message and arbitrary fields are discarded so remote text, reflected credentials, and unrelated secrets cannot enter actuator results, logs, or persisted self-heal telemetry.

Compatibility impact is deliberate: protected script commands that previously
reached the server without a credential now fail locally, token CLI flags cannot
be introduced as a compatibility path, non-loopback HTTP and non-origin URLs
are rejected, and a URL-only remote actuator is no longer reported available.
Public worker-helper status remains unchanged and token-free.

Regression evidence is in `tests/worker-helper-script.test.js`,
`tests/worker-repair-actuator.test.ts`, and
`tests/self-healing-loop.test.ts`.

### Decision WH-03: authenticated and bounded worker-heal actuators

- Decision date: 2026-07-25
- Scope: `POST /workers/heal` and `POST /worker-helper/heal`
- Status: anonymous direct actuation and endpoint-switching rate bypass closed

WH-03 makes these decisions:

1. Direct `/workers/heal` uses the strict direct-worker WH-01 boundary: only the
   configured worker-helper credential or an established full
   `admin`/`operator`/`owner` identity can proceed. Legacy daemon markers,
   operator audit labels, and `operator-light` do not authorize it.
2. Authentication runs before rate limiting, confirmation, request planning,
   filesystem inventory, or `healWorkerRuntime`. Confirmation, trusted GPT
   context, and automation credentials remain action confirmation only and
   cannot replace worker authentication.
3. Direct and worker-helper heal share one 10-per-15-minute budget. Full
   authenticated users key by server-established numeric user ID; trusted
   internal alternatives and the one configured credential use fixed
   server-owned identities. Credential values and caller labels never enter
   rate keys.
4. Existing direct confirmation semantics and worker-helper internal-context
   alternatives remain unchanged after authentication. Plan-only requests also
   consume the shared budget because they perform worker inventory and planning.
5. Direct heal failures return one stable response and bounded request-scoped
   logging instead of exposing raw dependency messages.

Regression evidence is in `tests/workers-heal-route-security.test.ts`,
`tests/workers-route-security.test.ts`, and
`tests/worker-helper-route.test.ts`.

### Decision MEM-01: deployment-wide memory-plane containment

- Decision date: 2026-07-25
- Scope: production `/api/memory/*`, `/api/save-conversation*`, and `/api/sessions*` mounts plus the exact natural-language memory interception in `POST /gpt/:gptId`
- Status: intentional security hardening; tenant isolation remains separate work

MEM-01 makes these decisions:

1. `ARCANOS_MEMORY_ACCESS_TOKEN` is a distinct, purpose-bound credential. It is read per request, MUST contain 32–4,096 JavaScript code units, MUST contain no whitespace or placeholder form, and MUST NOT equal another canonical purpose-bound application credential.
2. The sole request carrier is exactly one `x-arcanos-memory-token` value. Authorization, cookies, query parameters, body fields, and payload fields never establish memory authority. An unrelated Authorization header may coexist with the valid custom header.
3. Missing or invalid server configuration returns `503 MEMORY_AUTH_UNAVAILABLE`. Missing, malformed, duplicate, or incorrect request credentials return `401 MEMORY_AUTH_REQUIRED`. Denials are credential-free and omit `WWW-Authenticate`; authenticated memory-plane responses and denials use `Cache-Control: no-store`.
4. Production authentication for `/api/memory*`, `/api/save-conversation*`, and `/api/sessions*` runs before the broad JSON/form parsers, writing-plane consistency, confirmation, and route/database handling. The individual leaf routers remain independently mountable for focused handler-contract tests and are not the production security seam.
5. The GPT router evaluates the same pure classifier as the dispatcher. Only requests that would enter the existing memory branch are authenticated. Authorized interceptions are non-storable, are forced to synchronous dispatcher execution, and bypass fast-path and job creation, including for async or idempotent requests.
6. The dispatcher independently requires a server-owned `memoryPlaneAuthorized: true` input immediately before memory execution. Identically named body or payload fields have no authority, and background/internal callers fail closed.
7. The token proves possession of one deployment-wide credential only. It does not establish a tenant principal, bind caller-selected `sessionId`, or restrict the global memory schema. The legacy `/brain` compatibility shortcut and MCP memory tools retain their separate boundaries.

Compatibility impact is deliberate: deployments must configure the new token
and update direct memory clients before the protected routes work. Simple
browser navigation cannot attach the header to `/api/memory/table`. Explicit
`query` and `query_and_wait` GPT requests already bypass memory interception
and remain unchanged; ordinary non-memory GPT requests do not require the
token.

Regression evidence is in `tests/purpose-bound-credential.test.ts`,
`tests/memory-plane-http-auth.test.ts`,
`tests/api-memory-auth-composition.test.ts`,
`tests/api-sessions-auth-composition.test.ts`,
`tests/memory-dispatch-interception.test.ts`,
`tests/gpt-dispatch.mcp.test.ts`, and
`tests/gpt-async-idempotency.route.test.ts`.

### Decision DAEMON-01: deployment-wide daemon transport containment

- Decision date: 2026-07-25
- Scope: all backend `/api/daemon/*` routes and the bundled Python daemon client
- Status: anonymous transport access closed; per-instance identity remains separate work

DAEMON-01 makes these decisions:

1. `ARCANOS_DAEMON_ACCESS_TOKEN` is a distinct, purpose-bound credential. The backend reads it per request; it MUST contain 32–4,096 JavaScript code units, MUST contain no whitespace or placeholder form, and MUST NOT equal another canonical purpose-bound application credential.
2. The sole request carrier is exactly one `x-arcanos-daemon-token`. Authorization, `x-gpt-id`, cookies, query parameters, and body fields never establish daemon authority. An unrelated Authorization header may coexist but is ignored by the backend.
3. Missing or invalid backend configuration returns `503 DAEMON_AUTH_UNAVAILABLE`. Missing, malformed, duplicate, or incorrect request credentials return `401 DAEMON_AUTH_REQUIRED`. Responses contain no credential material, use `Cache-Control: no-store`, and omit `WWW-Authenticate`.
4. The daemon router scopes security headers, rate limiting, and authentication to `/api/daemon`, in that order. It mounts before writing-plane consistency and terminates authenticated unknown daemon paths with 404 so daemon control traffic cannot fall through to GPT rerouting.
5. The Python client loads `ARCANOS_DAEMON_ACCESS_TOKEN` without `BACKEND_TOKEN`, `ARCANOS_API_KEY`, or `ADMIN_KEY` fallback. Exact daemon namespace paths send only the custom header and suppress generic Bearer and GPT-ID carriers. Missing or malformed client configuration prevents network access, and daemon 401 responses do not trigger generic backend credential bootstrap.
6. The transport credential is never assigned to `req.daemonToken`, used as a store key, logged, returned, hashed into an actor identity, or persisted. New instances use the non-secret `anonymous-daemon` partition.
7. Historical store values can contain former Bearer credentials. They remain opaque, route-local compatibility partitions so existing command queues and results keep working. They are never treated as authority, attached to request context, or rewritten merely because transport auth changed.
8. The credential is deployment-wide, not per-instance identity. Any holder can address a known `instanceId`, including polling, acknowledging, submitting results, and consuming a valid confirmation for that instance. Enrollment, instance-bound rotation, revocation, and historical-partition scrubbing require a separate protocol.
9. `/api/update` remains a separate public validation route. Its unreachable duplicate in the daemon router is removed rather than brought under daemon authority.

Compatibility impact is deliberate: configure the same dedicated credential on
the backend and Python daemon before registry, heartbeat, polling, result, or
confirmation traffic can succeed. The Python process must restart after its
token changes; backend rotation is visible on the next request.

Regression evidence is in `tests/daemon-plane-http-auth.test.ts`,
`tests/api-daemon-credential-contract.test.ts`,
`tests/api-daemon-auth-composition.test.ts`,
`tests/daemon-store-credential-contract.test.ts`,
`tests/worker-helper-script.test.js`, and
`daemon-python/tests/test_daemon_transport_auth.py`.

### Decision SH-01: authenticated direct self-heal control plane

- Decision date: 2026-07-25
- Scope: the complete direct backend `/api/self-heal/*` namespace
- Status: anonymous inspection, provider probing, and predictive decision access closed

SH-01 makes these decisions:

1. Direct self-heal HTTP traffic reuses the strict O-21 control-plane bearer
   principal. No new credential or alternate carrier is added.
2. An idempotent prefix boundary applies security/no-store headers and a
   connection-derived client bucket before the broad JSON parser, then
   authenticates the operator principal. Rotating invalid Authorization values
   cannot create new pre-authentication buckets.
3. Runtime, event, inspection, and passive provider-health reads require
   `arcanos:read`. Active provider probes require both `arcanos:read` and
   `self-heal:probe`. Decisions require `self-heal:decide`; a parsed request with
   `execute: true` additionally requires `self-heal:execute`.
4. Predictive decisions and active provider probes use separate, tighter
   post-authentication rate-limit buckets keyed by the server-owned principal
   ID, never by the bearer value.
5. `capabilityGate('self_improve_admin')` remains after bearer and scope
   authorization as a secondary compatibility prerequisite. Its caller-selected
   agent ID is not identity-bound authorization and never substitutes for HTTP
   authentication. The compatibility `source` field remains a descriptive
   label, not principal identity.
6. The self-heal router mounts before the broad API writing-plane consistency
   gate and terminates authenticated unknown namespace paths with the standard
   API 404. Internal service-level runtime inspection remains direct and does
   not loop through HTTP.
7. Existing O-21 error behavior is preserved: invalid or missing server
   configuration returns no-store 503; invalid or missing bearer authentication
   returns no-store 401 with the control-plane challenge; missing scopes return a
   generic no-store 403 without listing grants.
8. SH-02 below closes the previously deferred detailed safety-status and
   self-improve compatibility surfaces. SH-03 later allowlists the compact
   public `/status/safety` health summary and protects quarantine recovery.

Regression evidence is in `tests/self-heal-http-boundary.test.ts`,
`tests/self-heal-auth-composition.test.ts`,
`tests/self-heal.runtime.route.test.ts`, and
`tests/predictive-self-heal.route.test.ts`.

### Decision SH-02: contained self-improve and detailed safety compatibility

- Decision date: 2026-07-25
- Scope: `/api/self-improve/*` and `GET|HEAD /status/safety/self-heal`
- Status: capability-only mutation and anonymous detailed-status access closed

SH-02 makes these decisions:

1. The SH-01 boundary is generalized once and reused at the application and
   router levels. All three self-healing control prefixes share one pre-auth
   ingress bucket and terminate authenticated unknown paths.
2. Detailed safety status and self-improve status require `arcanos:read`.
   Manual self-improve runs require both `self-heal:decide` and
   `self-heal:execute`; freeze, unfreeze, and autonomy changes require
   `self-improve:control`.
3. Manual self-improve runs share the predictive decision principal bucket.
   Kill-switch/autonomy mutations share a separate 10-per-15-minute principal
   bucket. Bearer values never enter rate keys or logs.
4. Existing `self_improve_admin` capability checks remain secondary
   compatibility prerequisites, not identity-bound authorization.
   Caller-selected agent identity and automation credentials do not replace the
   bearer principal.
5. Only freeze bypasses the global unsafe-state mutation block because it is
   restrictive. Run, unfreeze, and autonomy remain blocked while unsafe.
   Autonomy accepts exact integer levels 0–3 and control reasons are bounded.
6. The shipped CLI reads the exact control-plane token from its environment for
   `inspect self-heal`; it has no GPT Access or generic-token fallback.
7. Internal failures return stable error codes and log only bounded,
   request-scoped metadata rather than raw dependency messages or query values.
8. Authenticated mutation JSON is capped at 256 KiB and body-bearing requests
   require a JSON media type. Self-improve control schemas reject unknown
   fields. Simulation requires explicit dry-run without execution, and HTTP
   live execution cannot override disabled or server-enforced dry-run
   configuration.
9. The shipped CLI sends the bearer only to explicit HTTPS or exact HTTP
   loopback origins, rejects redirects, and rejects configured credentials that
   cannot use the server's visible-ASCII Bearer grammar.

Regression evidence is in `tests/self-heal-http-boundary.test.ts`,
`tests/self-improve-auth-composition.test.ts`,
`tests/routes-self-improve.test.ts`, `tests/safety-self-heal-status.test.ts`,
`tests/safety-self-heal.route.test.ts`,
`tests/transport-unsafe-execution-gate.test.ts`, and
`packages/cli/__tests__/cli.test.ts`.

### Decision SH-03: authenticated integrity-quarantine recovery

- Decision date: 2026-07-25
- Scope: public safety output, unsafe responses, and
  `POST /status/safety/quarantine/:quarantineId/release`
- Status: public identifier disclosure and anonymous safety release closed

SH-03 makes these decisions:

1. Public `GET /status/safety` keeps only allowlisted condition/quarantine
   classifications, counts, aggregate counters, and compact self-healing
   summaries. It omits IDs, reasons, metadata, notes, actors, and entity keys.
2. Raw active conditions, quarantines, and counters are exposed additively under
   `safetyState` in authenticated `GET /status/safety/self-heal`; trusted hashes
   remain omitted.
3. Generic unsafe-to-proceed responses contain condition codes and a quarantine
   count, never release-capable quarantine IDs.
4. Integrity release reuses O-21 authentication, the operator role,
   `self-improve:control`, and the shared 10-per-15-minute control bucket before
   deterministic confirmation. The server-owned principal is the release/audit
   actor; legacy admin headers or confirmation do not establish identity.
5. The global unsafe gate exempts only an exact `POST` after the pre-parser
   boundary has established a control-plane operator principal. The exemption
   provides recovery reachability, not authorization.
6. Release IDs and optional notes are bounded and URL/body allowlisted. Unknown
   fields, non-JSON bodies, malformed IDs, and nested paths fail closed.

Regression evidence is in
`tests/safety-control-auth-composition.test.ts`,
`tests/operator-auth-diagnostics.test.ts`,
`tests/safety-self-heal.route.test.ts`,
`tests/self-heal-http-boundary.test.ts`,
`tests/unsafe-execution-gate.test.ts`,
`tests/transport-unsafe-execution-gate.test.ts`, and
`tests/memory-consistency-gate.test.ts`.

### Decision DX-01: authenticated diagnostic execution

- Decision date: 2026-07-25
- Scope: `POST /devops/self-test`, `POST /devops/daily-summary`, and
  `POST /api/pr-analysis/analyze`
- Status: anonymous model, state-writing, outbound-request, and subprocess
  execution closed

DX-01 makes these decisions:

1. All three execution leaves reuse O-21's exact control-plane bearer and
   server-owned operator principal. DevOps execution requires
   `diagnostics:execute`; direct repository verification requires the existing
   `repo:verify` scope.
2. An idempotent exact-path boundary applies security/no-store headers, a
   connection-derived pre-authentication client bucket, authentication,
   operator and scope authorization, per-principal limits, and process-local
   single-flight locks before the broad JSON parser. Self-test and
   daily-summary share one lock and budget; PR analysis uses a separate lock
   and two-starts-per-30-minutes budget.
3. Authenticated bodies are strict JSON capped at 2 MiB. DevOps accepts only an
   absent body or `{}` and derives both target and attribution from server
   state. Callers cannot supply `baseUrl` or `triggeredBy`.
4. Self-test fetches reject redirects, time out after 30 seconds per prompt,
   read at most 256 KiB of JSON, and persist no raw model-response preview. Its
   memory probe requests availability only and explicitly forbids quoting
   stored content. Daily-summary sources pass through centralized credential
   redaction before model submission or persistence.
5. PR analysis accepts at most 1,500,000 UTF-8 diff bytes and 500 unique,
   normalized repository-relative paths. Lexical traversal, absolute/drive/UNC
   forms, control characters, escaping symlinks, and non-regular files fail
   closed. Line counting streams only until the configured threshold.
6. Fixed subprocess commands continue to run without a shell. Combined output
   capture is capped at 1 MiB and public validation/route failures contain only
   stable phase information, never raw stderr or internal exceptions.
7. PR verification mounts before the writing-plane consistency gate. Its
   health, schema, and inert webhook contracts remain public, while the
   execution leaf is independently protected when mounted outside the
   production application.

Regression evidence is in
`tests/diagnostic-execution-http-boundary.test.ts`,
`tests/diagnostic-execution-routes.test.ts`,
`tests/self-test-pipeline-transport.test.ts`,
`tests/pr-assistant-file-access.test.ts`,
`tests/pr-assistant-command-utils.test.ts`, and
`tests/test-pr-assistant.test.ts`.

### Decision LO-01: authenticated legacy operator surfaces

- Decision date: 2026-07-25
- Scope: `/sdk/*` and `/orchestration/reset|purge|status`
- Status: confirmation-only mutation and anonymous operational reads closed

LO-01 makes these decisions:

1. The complete SDK namespace and the three orchestration leaves reuse O-21's
   strict bearer and server-owned operator principal. SDK/orchestration reads
   require `arcanos:read`; SDK mutations and orchestration reset/purge require
   the existing `mcp:invoke` execution scope.
2. Confirmation remains required for mutations, but it runs only after
   authentication, operator-role authorization, server-owned scope checks,
   and principal limiting. `x-confirmed`, a confirmation challenge, and
   caller-supplied `agentId` or `sessionId` never establish identity.
3. An idempotent pre-parser boundary applies security/no-store headers, a
   connection-derived client budget, path-specific principal budgets, and
   process-local single-flight locks. Reset and purge share one lock and
   two-starts-per-15-minutes bucket; all SDK mutations share a separate lock
   and ten-starts-per-15-minutes bucket. SDK/status reads use a higher read-only
   budget.
4. Mutation bodies require JSON and are capped at 1 MiB before the global
   parser. Orchestration identifiers and snapshot tags are trimmed-exact,
   control-character-free, and bounded.
5. Authenticated unknown SDK subpaths terminate with the standard JSON 404.
   SDK and orchestration internal failures return fixed public errors; SDK
   audit metadata passes through centralized redaction, worker error objects
   are not reflected as AI responses, and degraded init diagnostics use a
   stable status.

Regression evidence is in
`tests/legacy-operator-http-boundary.test.ts`,
`tests/orchestration-route-security.test.ts`, and
`tests/sdk-route-security.test.ts`.

### Decision RT-01: standalone runtime job ownership

- Decision date: 2026-07-25
- Scope: `arcanos-ai-runtime` `POST /jobs` and `GET|HEAD /jobs/:id`
- Status: anonymous enqueue/read regression closed

RT-01 makes these decisions:

1. Every job request requires exactly one purpose-bound Bearer credential,
   the bounded server-owned principal ID, and an explicit endpoint scope.
   `runtime:enqueue` admits creation and `runtime:read` admits both GET and
   Express's HEAD handling. The former `x-api-key` carrier is not restored.
2. Configuration is resolved and snapshotted once at request ingress so token
   rotation is immediate without mixing principal or scope values inside one
   request. Missing, malformed, placeholder, or incomplete configuration
   returns generic no-store 503; missing, duplicate, malformed, or incorrect
   request credentials return generic no-store 401.
3. Authentication and scope authorization run before the route-local 256 KiB
   JSON parser. Caller bodies cannot supply ownership; the configured principal
   is written into every queued payload.
4. The configured principal cannot use the reserved historical owner ID
   `anonymous`. Read authorization also denies that owner defensively and
   compares every other stored principal before queue-state lookup or response
   construction. Absent jobs, historical `anonymous`/unowned jobs, and
   cross-principal jobs return the exact same 404.
5. Failed jobs expose only fixed public text. The HTTP boundary disables
   Express fingerprinting, applies no-store and API security headers, and uses
   stable JSON parser, not-found, and internal-error responses.
6. `createRuntimeApp` depends on a narrow injected queue port. Executable
   listener and concrete BullMQ construction remain in `server.ts`, allowing
   route security tests to prove import and request behavior without Redis,
   provider credentials, workers, or external network access.
7. This contract supports one configured trust domain. Keep the principal ID
   stable across replicas and token rotations. Existing anonymous jobs are not
   granted a fallback; any discovered deployment must drain or expire them
   through separately approved operations before rollout.

Tracked Railway startup does not launch this workspace, so application-layer
behavior is confirmed while current public exposure remains unverified.
Regression evidence is in
`arcanos-ai-runtime/tests/http_security.test.js`,
`tests/purpose-bound-credential.test.ts`, and
`tests/worker-helper-script.test.js`.

### Decision PDBG-01: prompt and routing trace content containment

- Decision date: 2026-07-25
- Scope: prompt-debug storage, AI-routing debug storage, their read routes, and
  self-heal trace consumption
- Status: default raw capture, unbounded append, and alternate anonymous read
  closed

PDBG-01 makes these decisions:

1. `PROMPT_DEBUG_TRACE_MODE` accepts exact `off`, `metadata`, or `full`.
   Unset/blank defaults to bounded `metadata`; invalid non-empty values fail
   closed to `off`. Metadata retains allowlisted routing categories and derived
   constraint/intent signals, never prompt text, executor payloads, responses,
   session values, or raw failure reasons.
2. `full` is an explicit sensitive-debug mode. Content is depth, collection,
   property, and string bounded before storage; recognized credential keys and
   values are redacted. GPT Access suppression independently removes executor,
   response, and failure content even under `full`.
3. Prompt-debug persistence defaults off. Exact enablement additionally
   requires an explicit 1 KiB–100 MiB file cap. Individual events and the
   pending buffer have smaller fixed byte caps; new complete events are dropped
   at capacity. Hydration refuses oversized files. The service never rotates,
   truncates, or deletes historical storage automatically.
4. A runtime downgrade to metadata projects retained in-memory records through
   the metadata allowlist; `off` clears collection and returns no records.
   Existing disk files remain operator-managed sensitive artifacts.
5. AI-routing debug capture follows the same content mode. Its read namespace
   now applies O-21 authentication, operator identity, `arcanos:read`, bounded
   limiting, no-store/security headers, and terminal 404 handling before the
   writing-plane gate.
6. Self-heal uses allowlisted intent tags, detected intent, tool selections,
   and runtime endpoints. It no longer scans stored raw prompt text.

Regression evidence is in
`tests/prompt-debug.trace-service.test.ts`,
`tests/prompt-debug.route.test.ts`,
`tests/ai-routing-debug.route.test.ts`,
`tests/api-control-plane-composition.test.ts`,
`tests/reusable-code-audit-system-state-parity.characterization.test.ts`,
`tests/runtime-inspection-routing.test.ts`, and
`tests/self-healing-loop.test.ts`.

## Intentional protocol differences

The following differences are boundary policy and MUST remain outside the primitive:

- Full-header comparison versus extracted-token comparison.
- Exact versus case-insensitive Bearer scheme recognition.
- Whether header whitespace is significant.
- Whether configured values are trimmed.
- Custom-header versus Bearer precedence.
- Whether a whitespace-only primary header or environment value suppresses fallback.
- Import-time versus per-request configuration capture.
- GPT Access's 4,096-code-unit cap.
- Missing-configuration status and error envelope.
- Alternate authorization paths such as operator roles, daemon context, one-time tokens, and allowlists.
- Whether an endpoint is intentionally public when no token is configured, as currently observed for metrics.

These differences are preserved because no single parsing contract is proven correct for every protocol. Future changes require a boundary-specific decision record and regression tests.

## Compatible, deferred, and excluded systems

### Phase 2A migration set

At Phase 2A completion, O-01 through O-17 called the TypeScript primitive after retaining their existing extraction, normalization, caps, error mapping, and configuration capture. O-18 through O-20 called the Python mirror without crossing the TypeScript/Python boundary. The original seven protocol expectations were unchanged except for the explicit ill-formed-Unicode fail-closed correction. WH-01 later superseded the recorded worker-helper configuration and extraction policy without changing the primitive; WH-03 applied that strict boundary and a shared principal budget to worker-heal entry points. DAEMON-01 later separated transport authentication from compatibility-only daemon store partitions. SH-01 extended O-21's existing control-plane principal to direct self-heal HTTP traffic without changing Bearer extraction or equality.

### Deferred policy changes

The equality migration did not authorize changing metrics' bare-Authorization compatibility, confirm-gate import capture, bridge runtime ownership, one-time capability lookup semantics, or any JWT/signature protocol. These remain separately reversible future decisions. DW-01 later superseded the watchdog's former key-optional policy without changing the shared equality primitive. DAEMON-01 closes anonymous daemon transport access but deliberately defers per-instance identity. SH-01 composes the existing O-21 principal with self-heal scopes while retaining the capability gate as a separate, still-deferred identity model.

### Excluded protocol systems

The following systems MUST NOT use `timingSafeEqualOpaqueSecret` as their verifier:

| System | Evidence | Reason for exclusion |
|---|---|---|
| One-time confirmation tokens | `src/lib/tokenStore.ts:51-94` | Stateful UUID lookup, expiry, and single-use consumption |
| Confirmation challenges | `src/transport/http/middleware/confirmationChallengeStore.ts:124-187` | Stateful lookup bound to method, path, request fingerprint, expiry, and consumption |
| Daemon pending confirmation token | `src/routes/daemonStore.ts:272-312` | Map lookup and consumption semantics precede the separate daemon-secret comparison |
| GPT-OSS private-serving signatures | `scripts/gptoss/private-serving/private-serving-signing.mjs:76-177`; auth consumer `private-serving-auth.mjs:146-185` | HMAC canonical-envelope protocol with audience, timestamp, nonce, identity, and replay checks |
| TypeScript trust JWT | `src/services/safety/v2/trustVerify.ts:33-123` | EdDSA/JWKS signature, issuer/claim validation, and Redis replay prevention |
| Python backend JWT | `daemon-python/arcanos/credential_bootstrap/jwt_utils.py:77-184` | HS256/RS256/JWKS signature and claim verification |

Password verification, if introduced later, MUST use an approved password-hashing scheme rather than this primitive.

## Credential disclosure contract

### Prohibited output

Neither a configured nor a provided credential may appear in:

- application logs or structured log metadata;
- audit events, metrics labels, or traces;
- HTTP or MCP error bodies and headers;
- thrown error messages or stacks created by credential verification;
- snapshots, fixture snapshots, coverage artifacts, or test-runner output;
- temporary paths, filenames, process titles, command arguments, or outbound/observable URLs;
- encoded, hashed, truncated, prefixed, suffixed, base64, hexadecimal, or URL-encoded form.

Authentication logs may contain only bounded metadata such as boundary name, sanitized route, decision category, status code, and non-secret actor identifiers.

Tests MUST use synthetic credentials, intercept all relevant log/output sinks, and assert that raw and common encoded representations are absent. Tests MUST NOT read ambient production credentials.

### Query and path findings

1. Python debug-server query authentication is disabled by default but can be enabled by `DEBUG_SERVER_ALLOW_QUERY_TOKEN`. That legacy inbound credential carrier is preserved in Phase 2A; it is an explicit exception to the prohibition on introducing new query transports. Phase 2A confirmed that the raw request target could reach stdlib stderr and structured request metadata. `DebugAPIHandler.log_message` now preserves the access log with a sanitized path, and debug middleware strips the query before logs, exception metadata, metrics, or audit output.
2. Python CLI debug mode previously derived the default command filename from the first 12 characters of the credential, then printed and logged that path. Phase 2A replaced the suffix with credential-independent cryptographic randomness while preserving explicitly configured paths. Token value and provenance are resolved from one environment read so an environment change cannot reclassify a configured credential as generated output.
3. No new credential transport may use a query parameter or credential-derived path.
4. Disclosure hardening is isolated to `daemon-python/arcanos/debug_server.py`, `daemon-python/arcanos/debug/middleware.py`, and `daemon-python/arcanos/cli_runner.py`. The local-bridge edit is equality-only, and `daemon-python/arcanos/credential_verification.py` is the new primitive.

### Allowed interactive generated-token delivery

One narrow exception is allowed: when local Python CLI debug mode generates a new one-time credential because `ARCANOS_DEBUG_CMD_TOKEN` is not configured, it may deliver the complete credential once to the directly attached interactive operator console.

This exception is allowed only when all of the following hold:

- the token was generated for the current local interactive session;
- delivery is necessary for the operator to submit the first authenticated command;
- the value is written to the interactive console, not a structured logger, telemetry sink, file, snapshot, or remote response;
- an environment-provided credential is never printed;
- subsequent logs do not repeat the value or a prefix/suffix/hash of it;
- tests use a synthetic deterministic marker and capture the console output.
- when the console is redirected or not terminal-attached, startup fails closed unless `ARCANOS_DEBUG_CMD_TOKEN` is configured.

This exception does not authorize credential-derived filenames or log entries; Phase 2A removed both.

## Evidence-backed risks

The dispositions in the boundary inventory are scope classifications. The implementation recommendations are enumerated below with the audit's required review labels.

| Finding | Affected files | Evidence | Observed behavior | Confidence | Risk | Observation basis | Required prerequisite tests | Suggested phase | Rollback approach | Production deployment required |
|---|---|---|---|---|---|---|---|---|---|---|
| Metrics accepts a bare Authorization value | `src/platform/observability/appMetrics.ts` | The parser removes a Bearer prefix only when one is present | The remaining bare header value is compared as the credential; Phase 2A preserved and tested it | High | Medium | Static and runtime | Any decision to require Bearer needs an explicit compatibility matrix | Later boundary-hardening phase | Restore the optional-prefix parser and rerun the metrics auth matrix | Yes |
| Confirm-gate captures automation auth at import | `src/transport/http/middleware/confirmGate.ts` | Lines 92-93 initialize module-level authentication constants | Environment changes after import are not visible until the module is reloaded | High | Medium | Static | Module reset/re-import and environment-rotation matrix | Later boundary-hardening phase if rotation is required | Restore module-level capture and rerun import/reset decisions | Yes |
| Confirmation challenge capability was logged | `src/transport/http/middleware/confirmGate.ts`, `src/transport/http/middleware/confirmationChallengeStore.ts` | The challenge UUID is the stateful verification token and was interpolated into the denial log | Phase 2A retains response delivery but logs only `Challenge: issued`; a decision test captures logs, verifies no issued ID appears, and consumes test challenges | High | High | Static and runtime | Keep confirmation-log non-disclosure and challenge-cleanup decisions | Completed in Phase 2A | Revert only the sanitized log text if protocol debugging requires it; never restore credential output without a separate security approval | Yes |
| UTF-8 replacement encoding conflated ill-formed JavaScript strings | `src/shared/security/opaqueSecret.ts`, former local comparators in O-01 through O-07 | Distinct lone surrogates can encode to the same UTF-8 replacement bytes | Phase 2A hashes exact JavaScript UTF-16 code units; Python uses injective UTF-32LE code-point encoding with surrogate preservation | High | Medium | Static and runtime | Keep lone-surrogate and Python scalar-versus-surrogate-pair decisions | Completed in Phase 2A | Restore the former encoder only with an explicit decision accepting equivalence of distinct runtime strings | Yes |
| Bridge WebSocket verifier is not production-wired | `src/services/bridgeSocket.ts` and `tests/bridge-socket-credential-contract.test.ts` | Repository import search found no caller of `setupBridgeSocket`; Phase 2A now executes its actual upgrade verifier on loopback | Equality and cleanup are runtime-observed, but production ownership is still absent | High | Medium | Static and runtime | Ownership evidence before adding a production caller | Ownership/route-wiring investigation | Remove future wiring; the equality migration can be reverted independently | Yes if production wiring changes |
| Debug watchdog may be unauthenticated when its key is absent | `src/routes/register.ts` and `tests/debug-watchdog-auth.test.ts` | DW-01 resolves strict purpose-bound configuration before comparing the exact custom header | An enabled route now returns generic no-store 503 without watchdog data when configuration is missing, invalid, or colliding; missing/wrong request keys remain 403 | High | High | Static and runtime | Keep disabled, misconfiguration, isolation, alternate-carrier, rotation, and no-disclosure tests | Completed in DW-01 | Revert only DW-01 while retaining timing-safe equality; doing so reopens unauthenticated debug data | Yes |
| Daemon routes did not extract a real request credential | `src/transport/http/middleware/daemonPlaneAuth.ts`, `src/routes/api-daemon.ts`, `daemon-python/arcanos/backend_client/__init__.py` | DAEMON-01 requires one isolated custom-header credential before all daemon handlers, moves the namespace outside writing-plane rerouting, and sends no generic auth carrier from Python | Anonymous transport access is closed; credential/configuration failures are generic and no-store; the credential never reaches request context or persistence. One deployment-wide holder can still act across instances, so per-instance identity remains deferred | High | High | Static and runtime | Keep server parsing/composition/store-order/no-disclosure and Python path/carrier/no-refresh tests | Completed in DAEMON-01; instance identity remains a later protocol phase | Revert DAEMON-01 as one backend/Python rollout unit; doing so reopens anonymous transport access | Yes |
| Direct self-healing routes allowed anonymous inspection, provider probes, capability-only mutations, detailed status, and quarantine release | `src/services/controlPlane/selfHealingControlHttpBoundary.ts`, `src/routes/self-heal.ts`, `src/routes/self-improve.ts`, `src/routes/safety.ts`, and `src/routes/register.ts` | SH-01 through SH-03 apply the existing O-21 operator principal before parsing, use server-owned read/probe/decision/execute/control scopes, retain capability checks only as compatibility prerequisites, sanitize public safety output, and mount before writing-plane consistency | Anonymous runtime detail and provider-cost triggers are closed; self-improve and quarantine mutations require explicit scopes; release IDs are absent from public/unsafe responses; active probes, decisions, and control changes use principal buckets; the CLI supplies the same bearer for detailed inspection | High | High | Static and runtime | Keep pre-parser, scope, HEAD, capability-composition, terminal-404, CLI, safety-release, disclosure, and route-order tests | Completed in SH-01 through SH-03 | Revert each SH decision as its matched route/auth/client/docs unit; reverting SH-03 reopens anonymous release and public identifier disclosure | Yes |
| Debug query token reached request logging | `daemon-python/arcanos/debug_server.py`, `daemon-python/arcanos/debug/middleware.py` | Runtime tests exercise valid/invalid query credentials and exception paths | Phase 2A removes query strings from stderr, logs, exception metadata, and metrics | High | High | Static and runtime | Keep `test_debug_server.py` disclosure decisions | Completed in Phase 2A | Revert the two Python logging changes together; query transport may be disabled as emergency mitigation | Yes |
| CLI token prefix appeared in path output and logs | `daemon-python/arcanos/cli_runner.py` | The old default filename used a 12-character credential prefix | Phase 2A uses a token-independent random suffix and tests console/log/path sinks | High | Medium | Static and runtime | Keep `test_cli_runner_debug_auth.py` | Completed in Phase 2A | Revert the private path helper independently only if compatibility requires it | Yes for packaged/runtime code |
| CLI-generated token delivery can reach redirected output | `daemon-python/arcanos/cli_runner.py` | The pre-change debug runner printed a generated credential without checking whether its console was terminal-attached | A locally generated credential is delivered once only to a terminal-attached operator; redirected/non-terminal mode now fails closed unless a token is configured | High | High | Static and runtime | Keep interactive, redirected, configured, path, logger, and output-sink decisions | Completed in Phase 2A; reassess the remaining local-console exception during CLI hardening | Revert the terminal gate independently without restoring token-derived filenames; doing so reopens the disclosure risk | Yes |
| CLI token provenance was read non-atomically | `daemon-python/arcanos/cli_runner.py`, `daemon-python/tests/test_cli_runner_debug_auth.py` | Separate configuration-presence and token-value reads allowed an environment change between reads to classify a configured credential as generated | Phase 2A resolves token value and provenance from one environment read; a side-effecting environment-reader decision proves no second read or disclosure | High | High | Static and runtime | Keep the one-read provenance and observable-output regression test | Completed in Phase 2A | Restore the single-read resolver; do not reintroduce independent presence/value reads | Yes |
| Root diagnostics comparator has no production caller | `src/services/rootDeepDiagnosticsBridge.ts` and `tests/reusable-code-audit-timing-safe-auth.characterization.test.ts` | Repository import search found only characterization-test use | Equality behavior is characterized, but no production route ownership is established | High | Low | Static | Route-ownership test before enabling the feature | Phase 2A equality-only migration is allowed; feature enablement is a separate phase | Restore the local comparator; do not add or alter a route | Yes only if a production route is later enabled |
| Python bootstrap can accept unverified JWT expiry when no verification key is configured | `daemon-python/arcanos/credential_bootstrap/__init__.py` and JWT helpers | Lines 206-227 inspect expiry without first establishing a configured signature-verification path | A token can reach expiry-based acceptance without verified authenticity in the no-key configuration | High | High | Static | HS256, RS256, JWKS, no-key, expiry, malformed-token, and no-leak matrix | JWT-specific security phase; excluded from opaque-secret consolidation | Revert the JWT-specific decision change independently and retain signature/claim tests | Yes |

## Validation plan

### Primitive tests

The TypeScript primitive suite MUST cover:

- equal ASCII and Unicode;
- unequal same-length and different-length values;
- case sensitivity;
- significant leading/trailing whitespace;
- canonical Unicode non-equivalence;
- exact decisions for lone surrogates and other ill-formed runtime strings;
- empty, missing, and runtime non-string values;
- at least 5,000 characters without a shared cap;
- no console, stdout, stderr, logging, mutation, or thrown-error side effects;
- absence of raw, hexadecimal, base64, URL-encoded, hashed, prefixed, and suffixed credential markers in observed output.

The Python mirror receives the same externally visible decisions in `daemon-python/tests/test_credential_verification.py`, plus a Python-specific scalar-versus-explicit-surrogate-pair vector.

### Consumer decision tests

For each migrated boundary, run its pre-existing characterization without rewriting expectations unless an explicit later boundary decision records the change and rollback. Add decision tests required to prove the retained behavior and the approved correction.

At minimum validate:

```text
node scripts/run-jest.mjs --testPathPatterns="(opaque-secret-contract|reusable-code-audit-timing-safe-auth)" --coverage=false --runInBand --detectOpenHandles
npm run type-check
npm run lint
npm test
```

For the Python migration, run the focused security suites and `python -m pytest -q` from `daemon-python`. No validation may contact a real external network, database, Redis, OpenAI, Railway, or secret store; the WebSocket decision test uses only an isolated loopback server and closes it deterministically.

### Review checks

Before each commit:

1. Review the complete diff and confirm TypeScript authentication edits are limited to the primitive import/call sites plus removal of the confirmed challenge-token log disclosure.
2. Confirm parsers, error envelopes, config reads, feature flags, and route registration are unchanged; separately review the narrow Python query/path, generated-token delivery, and filename disclosure fixes.
3. Search changed files and test output for synthetic credential markers and common encodings.
4. Confirm no lockfile, environment file, generated output, cache, or build artifact is included.
5. Confirm all tests restore environment, module cache, spies, loggers, listeners, and timers.

Ordinary unit tests do not prove constant-time execution and MUST NOT claim to benchmark it.

## Rollout, rollback, and deployment

### Rollout

1. Add and validate both language-local primitive contract tests.
2. Migrate the seven characterized TypeScript call sites without changing extraction logic.
3. Add decisions, then migrate the ten additional compatible TypeScript boundaries.
4. Add Python transport/disclosure decisions, migrate the three Python boundaries, and apply the isolated query/path fixes.
5. Run focused characterization with open-handle detection, then type-check, lint, full TypeScript tests, and full Python tests.
6. Record any pre-existing failure separately from regression and stop without deploying.

### Rollback

Each consumer migration MUST be independently reversible:

1. Restore that file's local equality helper or direct comparison.
2. Remove its primitive import.
3. Re-run the unchanged characterization or decision test for that boundary.

For Python disclosure rollback, restore `debug_server.py` and `debug/middleware.py` together, or independently restore the private CLI filename/terminal-delivery decisions. Restoring redirected generated-token output or challenge-token logging reopens a documented high-risk disclosure and requires separate approval. Do not roll back the no-disclosure tests when reverting implementation.

If every consumer is rolled back, the unused primitive and its contract test may be removed in a separate revert. Do not use a destructive reset. Do not combine rollback with parser, route, environment, or error-envelope changes.

### Deployment

Phase 2A validation does not authorize deployment, Railway mutation, secret rotation, or external calls. No deployment is required to produce this contract or local test evidence. A later production deployment would be required for migrated runtime code to take effect, and must follow the repository release process under separate operator authorization.

## Change-control rule

A future boundary may adopt the primitive only after its protocol extraction, normalization, configuration capture, failure mapping, and no-leak behavior are documented and protected by tests. A future proposal to change those behaviors is a protocol change, not a comparison refactor, and requires a separate security decision and rollback plan.
