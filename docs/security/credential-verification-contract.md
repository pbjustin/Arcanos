# ARCANOS Credential Verification Contract

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
8. Impose no primitive-wide length cap. Boundary-specific limits remain at the boundary. GPT Access retains its existing 4,096-code-unit cap; other characterized consumers currently accept at least 5,000-character values.
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

The repository currently has 20 security-sensitive opaque comparison boundaries. The first seven have complete Phase 1 characterization; O-08 through O-20 received focused Phase 2A decision tests before migration.

| ID | Boundary and evidence | Extraction and normalization | Configuration source and capture | Pre-Phase-2A equality | Disposition |
|---|---|---|---|---|---|
| O-01 | MCP HTTP: `src/mcp/auth.ts`; consumer `src/routes/mcp.ts` | Entire raw `Authorization` header is compared with ``Bearer ${token}``; no request trim; scheme and spacing are exact | `MCP_BEARER_TOKEN` through `getEnv`, captured at module import | UTF-8 buffers, byte-length branch, `crypto.timingSafeEqual` | Migrated; equality only |
| O-02 | Custom GPT bridge: `src/services/customGptBridgeService.ts`; route `src/routes/bridge.ts` | Case-insensitive, whitespace-normalizing Bearer extraction; action-secret header fallback; a present Bearer value takes precedence even when invalid | `OPENAI_ACTION_SHARED_SECRET`, read per invocation or injected; expected and action-secret values trimmed | SHA-256 digests plus `timingSafeEqual` | Migrated; parsing and precedence preserved |
| O-03 | Control-plane approval: `src/services/controlPlane/approval.ts`; executor `src/services/controlPlane/executor.ts` | `request.approvalToken`; supplied and configured values trimmed | `ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN`, read per call or injected | UTF-8 buffers, byte-length branch, `crypto.timingSafeEqual` | Migrated; decision statuses preserved |
| O-04 | GPT Access: `src/services/gptAccessGateway.ts`; mount `src/routes/gpt-access.ts` | Case-insensitive Bearer parser; application-level leading scheme whitespace rejected; extracted token trimmed | `ARCANOS_GPT_ACCESS_TOKEN`, read per request; raw configured value retained after a trim-only presence check | SHA-256 digests, `timingSafeEqual`, JS-length equality, 4,096-code-unit cap | Migrated; cap and application-level whitespace asymmetry retained |
| O-05 | GPT DAG bridge: `src/services/gptDagBridge.ts`; consumer `src/routes/gptRouter.ts` | Case-insensitive, whitespace-normalizing Bearer extraction | `GPT_DAG_BRIDGE_BEARER_TOKEN`, otherwise `OPENAI_ACTION_SHARED_SECRET`, read per request and trimmed; whitespace-only primary suppresses fallback | UTF-8 buffers, byte-length check, `crypto.timingSafeEqual` | Migrated; fallback suppression preserved |
| O-06 | Worker helper: `src/routes/worker-helper.ts`; mount `src/routes/register.ts` | Trimmed custom header first, then case-insensitive Bearer fallback; an application-supplied whitespace-only custom value blocks fallback | `ARCANOS_WORKER_HELPER_TOKEN`, read per request and trimmed | UTF-8 buffers, byte-length check, `crypto.timingSafeEqual` | Migrated; alternate auth paths preserved |
| O-07 | Root deep diagnostics: `src/services/rootDeepDiagnosticsBridge.ts` | Entire raw `Authorization` header versus ``Bearer ${token}``; exact scheme/spacing | `ARCANOS_ADMIN_TOKEN`, read per call without trimming | UTF-8 buffers, byte-length branch, `crypto.timingSafeEqual` | Migrated; still no production consumer found |
| O-08 | Metrics: `src/platform/observability/appMetrics.ts`; consumer `src/app.ts` | Trims custom header; Authorization removes a Bearer prefix only if present, so a bare Authorization value is accepted | `METRICS_AUTH_TOKEN`, read per request and trimmed; absent means public endpoint | Ordinary `===` | Migrated after Bearer/bare/custom-header decisions; public-unconfigured policy preserved |
| O-09 | Debug confirmation: `src/routes/debug-confirmation.ts`; mount `src/routes/register.ts` | Configured custom header; provided value is not application-trimmed, while Node removes transport OWS | `ARCANOS_AUTOMATION_SECRET` read per request by `getAutomationAuth`; expected trimmed | Ordinary `!==` | Migrated after route and no-disclosure decisions |
| O-10 | Capability-gate bypass: `src/transport/http/middleware/capabilityGate.ts` | Configured custom header; provided value not trimmed; successful match plus capability bypasses agent lookup | `ARCANOS_AUTOMATION_SECRET`, read per request and trimmed | Ordinary `===` | Migrated after bypass decision test |
| O-11 | Confirm-gate bypass: `src/transport/http/middleware/confirmGate.ts` | Configured custom header; provided value not trimmed | `ARCANOS_AUTOMATION_SECRET` and header name captured at module import | Ordinary `===` | Migrated; import-time capture preserved and tested |
| O-12 | Bridge WebSocket: `src/services/bridgeSocket.ts` | Custom automation header after Node parsing; wrong/missing value falls back to one-time-token consumption | `ARCANOS_AUTOMATION_SECRET`, read per upgrade and trimmed | Ordinary `===` | Migrated through the production upgrade verifier; runtime ownership remains unresolved |
| O-13 | Debug watchdog: `src/routes/register.ts` | Raw `x-debug-key` after Node parsing; exact comparison | `DEBUG_WATCHDOG_KEY`, read per request; missing key leaves enabled route unauthenticated | Ordinary `!==` | Migrated; key-optional policy explicitly preserved and tested |
| O-14 | Core root override: `src/core/persistenceManagerHierarchy.ts` | Raw function token; requires explicit flag, admin role, and non-empty values | `ROOT_OVERRIDE_TOKEN`, read per call through `getEnv` | Ordinary `!==` | Migrated; state implementation remains independent |
| O-15 | Service root override: `src/services/persistenceManager.ts` | Raw function token; requires explicit flag and admin role; `getEnv` normalizes blank config to missing | `ROOT_OVERRIDE_TOKEN`, read per call | Ordinary `===` | Migrated; state implementation remains independent |
| O-16 | Daemon heartbeat instance binding: `src/routes/api-daemon.ts` | Stored instance token versus `req.daemonToken` | Runtime daemon store; HTTP middleware currently assigns the constant `anonymous-daemon` | Ordinary `!==` | Migrated; exact, mismatch, first-registration, persistence, and record-before-check ordering are runtime-tested; this does not establish real daemon authentication |
| O-17 | Pending daemon-action binding: `src/routes/daemonStore.ts`; adapter `src/routes/api-daemon/pending.ts` | Stored instance token versus supplied daemon token after confirmation-token and instance checks | Runtime daemon store | Ordinary `!==` | Migrated with mismatch/non-consumption/exact-match decisions |
| O-18 | Python local CLI bridge: `daemon-python/arcanos/cli/local_bridge.py` | Exact `x-arcanos-cli-bridge-token` header; health is unauthenticated | `ARCANOS_CLI_BRIDGE_TOKEN`, trimmed and captured when `LocalBridge` is constructed | Truthiness guards plus direct `hmac.compare_digest` | Migrated to the Python mirror; Unicode follows exact Python string identity |
| O-19 | Python debug server: `daemon-python/arcanos/debug_server.py` | Raw automation header; case-sensitive `Bearer ` with trimmed token; trimmed `X-Debug-Token`; optional raw query token | Automation secret read per request and trimmed; `Config.DEBUG_SERVER_TOKEN` captured with class config | Ordinary `==` across four transports | Migrated; extraction preserved and query-path disclosure removed |
| O-20 | Python CLI debug command: `daemon-python/arcanos/cli_runner.py` | JSON token coerced to string and trimmed | `ARCANOS_DEBUG_CMD_TOKEN` trimmed once from one environment read, or a generated one-time token delivered only to a terminal-attached console | Ordinary `!=` | Migrated; token-derived filename replaced with credential-independent randomness and redirected output now requires configured authentication |

## Locked behavior for the original seven

Migration of O-01 through O-07 MUST preserve the following Phase 1 observations.

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

The shared primitive changes only the equality step. It does not authorize changing any cell in this table. One explicit security correction is recorded: the former UTF-8 Buffer/digest implementations could encode distinct ill-formed JavaScript strings as the same replacement bytes. The primitive now preserves exact UTF-16 code-unit identity, so distinct lone-surrogate values fail comparison. Normal HTTP header values are unaffected, and the decision is protected by primitive tests.

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

O-01 through O-17 call the TypeScript primitive after retaining their existing extraction, normalization, caps, error mapping, and configuration capture. O-18 through O-20 call the Python mirror without crossing the TypeScript/Python boundary. The original seven protocol expectations remain unchanged except for the explicit ill-formed-Unicode fail-closed correction above. Focused decisions cover the additional consumers, including the daemon heartbeat route.

### Deferred policy changes

The equality migration does not authorize changing metrics' bare-Authorization compatibility, confirm-gate import capture, the watchdog's key-optional policy, daemon identity ownership, bridge runtime ownership, one-time capability lookup semantics, or any JWT/signature protocol. These remain separately reversible future decisions.

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
| Debug watchdog may be unauthenticated when its key is absent | `src/routes/register.ts` and `tests/debug-watchdog-auth.test.ts` | The guard enforces equality only when `expectedDebugKey` is truthy | An enabled watchdog route with no configured key returns 200; this is now runtime-characterized | High | High | Static and runtime | A fail-closed policy needs a dedicated misconfiguration/status decision | Dedicated fail-closed security phase | Revert only the policy change while retaining its decisions | Yes |
| Daemon routes do not extract a real request credential | `src/routes/api-daemon.ts`, `src/routes/daemonStore.ts`, `src/routes/api-daemon/pending.ts` | `api-daemon.ts` assigns the constant `anonymous-daemon`; heartbeat records data before checking existing instance ownership | Equality is timing-safe, but heartbeat and pending-action paths still lack strong external daemon authentication; mismatch denial retains the observed record-before-check side effect | High | High | Static and runtime | Daemon ownership, registration, heartbeat, hijack, record-order, and pending-action tests | Daemon identity/protocol phase | Revert only future identity extraction/order changes while retaining the Phase 2A matrices | Yes |
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

For each migrated boundary, run its pre-existing characterization without rewriting expectations. Add only decision tests required to prove that extraction and normalization remain unchanged.

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
