# Phase 2 engineering report

Date: 2026-09-11. Scope: secure iPhone connectivity; implementation and local validation.

## Repository inspected

The implementation starts at merged PR #1495, commit `5116b268`, containing the
Phase 1 Swift package, iOS app, generated contracts and synthetic preview proof.
The full base SHA is `5116b26896eabf0c9f723db960651ba9c7aae628`.
Work is isolated in `C:\pbjustin\Arcanos-ios-phase2`, branch
`feat/ios-secure-connectivity-phase2-20260911`. The original main checkout had
unrelated changes and was preserved. This report records the Phase 2 implementation
and local validation on that base, prepared for publication as an authorized draft
PR. No merge, deployment, production credential rotation or production
configuration change was performed.

Inspection traced the actual Gateway Bearer middleware and global scopes,
capability registry and MCP action allowlist, strict Local Agent confirmation,
queued GPT/Local Agent provenance, generic job-read capabilities, database
transactions, Swift HTTPS transport and Keychain seam before implementation.
The existing session repository stores conversation data; it is not an
authentication session store. Existing confirmation tokens are process-local
action approvals and are not suitable device credentials.

## Authentication architecture and pairing protocol

The existing operator/server credential remains valid under its existing scope
policy. A paired device is an additional principal class with a stable random
server UUID, configured operator principal/workspace context, explicit scopes,
capability actions, approved GPT IDs and origin. Device credentials cannot enter
operator, control-plane, Gaming/Backstage dedicated, or Python executor lanes.

1. A trusted operator calls `POST /gpt-access/devices/pairing` using its existing
   Gateway authentication. The server supplies principal/workspace and the exact
   configured `ARCANOS_GPT_ACCESS_DEVICE_ORIGIN`; those fields cannot be supplied
   by the caller. Requested grants must fit the fixed device policy and current
   Gateway scopes. Default capability access is only `git.status`.
2. The server returns a five-minute `agp1.` challenge with 32 random bytes encoded
   as base64url. Only its SHA-256 digest is persisted. It is shared privately with
   the intended phone; the operator credential is never part of that transfer.
3. The phone generates a random UUID installation identity in Keychain and
   submits it with the challenge to `POST /gpt-access/devices/pair`, over HTTPS
   with the exact origin header. The UUID is a local label, never authentication.
4. A PostgreSQL transaction locks the challenge, verifies expiry/origin and unused
   state, inserts the device, and consumes the challenge. Expiry while waiting
   for a lock rolls registration back. Concurrent consumption has one winner.
5. The response contains a device session. Only the phone receives the raw device
   credential; the database stores its digest. Replayed/expired challenges fail.
   Old challenge hashes are pruned after 24 hours on subsequent challenge creation;
   raw challenges are never stored. A new trusted pairing creates a new server
   device record, rather than letting a client identity replace another device.

The device namespace uses the existing rate budget and a 4 KiB JSON ceiling,
without compressed-body inflation. Operator/device authentication precedes
parsing except on the public challenge-consumption route. Error bodies and
audit events omit raw input and secrets. Responses are marked `no-store`.

## Credential format, lifetime and Keychain integration

Access credentials are opaque `agd1.` plus 43 base64url characters (256 random
bits). They are not JWTs and need no signing/master key. Audience is
`gpt-access-device-v1`; lifetime is one hour. Renewal requires the current,
unexpired, unrevoked credential and replaces its digest transactionally. The
absolute renewal deadline is 720 hours after pairing. Missing an access expiry
or the absolute deadline requires a fresh trusted pairing; there is no separate
long-lived refresh token. Rotation has one winner and removes the old digest.

Every protected device operation validates the server record without a cache.
The configured origin, stored origin and `X-Arcanos-Device-Origin` must agree.
The origin header is an audience check; the credential supplies authentication.
Revocation takes effect on subsequent authenticated operations even when the
phone retains its old Keychain item. It does not cancel already accepted work.

Swift stores one complete session record atomically in Keychain using a
device-only accessibility class. The storage backend is injectable in tests.
Installation identity and session material never go in UserDefaults. Pairing
material is transient. A fail-closed replacement marker prevents an interrupted
rotation or failed Keychain replacement from reusing the old credential.
There is no automatic replay of a failed action. Credential errors update only
the corresponding current token, so a delayed rejection cannot poison a newer
session. States distinguish unpaired, paired, expired, revoked, renewal required
and authentication failure, with separate unavailable-storage/connectivity errors.
Origin-scoped store leases and expected-token checks serialize pairing, renewal
and revocation across client instances sharing the store. Late or stale lease
completions cannot overwrite a newer credential. Credential removal and demo
mode changes are guarded during these operations.

Local routing remains independent of credentials. Local-capable requests still
use Foundation Models when available; remote-required requests report a clear
authentication/connectivity state. Accepted job handles survive subsequent
polling authentication errors and do not become false successes.

## Server authorization, jobs, capabilities and confirmation

Device scopes are a subset of `jobs.create`, `jobs.result`, `capabilities.read`
and `capabilities.run`, intersected with the existing deployment scope policy.
AI jobs are limited to canonical `arcanos-core`. Capability invocations are
limited to `ARCANOS:LOCAL_AGENT` and explicitly granted actions from `git.status`,
`tests.run`, `patch.preview`, `patch.apply`, intersected with the existing MCP
allowlist and Local Agent workspace/executor policy. Discovery filters actions,
metadata and defaults. There is no new shell or arbitrary-command capability.

Both AI and Local Agent jobs persist `gptAccessDeviceOwner` with version, device,
principal and workspace. All device job reads require an exact owner match,
including pending/running, completed, failed and expired states. Unauthorized
and nonexistent IDs receive the same existing `not_found` envelope and no result.
The operator's existing Gateway read behavior is preserved. Local Agent target
device identity remains the Python executor; requester identity is an additional
field and participates in idempotency scope/fingerprint isolation. Credential
rotation retains the requester device ID and therefore owned-job access.

The generic `x-arcanos-job-read-token` path still excludes Gateway jobs. Adding
that header or supplying another device's ID does not bypass Gateway ownership.

Pairing never confirms an action. Existing confirmation middleware still binds
the challenge to method, path, action/payload and authenticated actor/context.
Paired privileged requests require its one-use challenge; manual `yes`, trusted
GPT or automation bypasses cannot substitute. The Swift coordinator preserves
the frozen request, requires explicit approval, adds only the confirmation token,
retries once and stops on a second challenge or failure. Server tests exercise
`tests.run` and `patch.apply`, successful exact retry, replay and payload mutation.

Audit events cover pairing issuance, device registration, credential rotation,
revocation, job enqueue/denial, capability request and confirmation required/
completed. Logs use safe identifiers; new opaque credential patterns are also
covered by shared redaction. Secrets, pairing/confirmation tokens, authorization
headers and raw request bodies are excluded from these events.

## Contracts and compatibility

The canonical Gateway OpenAPI builder remains authoritative. It now defines
pairing, consume, inspect, renew and revoke operations, device Bearer plus origin
header security, DTOs and error/status contracts. The Phase 1 AST generator now
derives 22 schemas and 10 operations, including security metadata in its drift
snapshot. Swift DTOs are generated, with redacted descriptions for secret-bearing
responses. No new top-level command protocol or Python authorization flow was
introduced.

Persistence is additive: two device tables, runtime schema definitions, Prisma
representations, idempotent SQL and a rollback migration. Existing jobs need no
backfill: old operator jobs remain readable by operators and are not implicitly
granted to devices. See [database migration guidance](../../docs/DATABASE_MIGRATIONS.md).
Rollback destroys device registrations and requires re-pairing. The existing
confirmation store remains process-local: a retry routed to another process can
receive a second challenge, which the client must stop rather than replay.

## Validation and evidence limits

Validation uses exact Node 24.18.1 / npm 11.16.0, Swift 6.2 on Linux, and a new
loopback-only disposable PostgreSQL 18.6 cluster. No production credentials are
needed for CI or the proofs.

| Check actually executed | Result |
| --- | --- |
| Final focused Jest regressions | 31 suites, 731 tests passed; includes Gateway, 20 new credential-core cases, OpenAPI, capability execution, confirmation, jobs/read capabilities, Local Agent, Phase 1 preview, shared protocol and redaction |
| PostgreSQL 18.6 device-auth integration | 8 passed: concurrent consume/rotate, origin rejection, lock-wait expiry, revoke race, SQL constraints and reversible/idempotent migration |
| Existing PostgreSQL Local Agent integration | 6 passed |
| Bounded synthetic HTTP proof runner | 12 named assertions passed, real Express/auth/confirmation with synthetic storage/execution |
| Swift 6.2 package tests | 18 XCTest tests and 72 Swift Testing functions passed, including 24 new Phase 2 functions and parameterized negative cases |
| Swift release build | Passed on Linux |
| Host app Swift syntax parse | All 6 files passed; this is not an iOS SDK build |
| Canonical contract derivation/drift | Passed: 22 schemas and 10 operations; actual credential-service responses validated against canonical schemas |
| Root type-check and full build | Passed, including shared packages, worker compilation, routing/CEF/preview boundaries and emitted alias/import checks |
| Root lint | Passed with 0 errors and 76 existing warnings; focused changed-file checks clean |
| Backend/CLI contract and Python offline checks | Passed |
| Synchronization check | 0 errors, 0 warnings, 5 advisory information items; no automatic repair applied |
| Railway static compatibility | Passed; no deployment or live probe |
| Prisma 5.22 schema validation | Passed |
| Documentation audit and indexes | 454 checks passed after staging; all four generated indexes regenerated and verified |
| Local documentation links | 290 targets passed; external network link checks skipped |
| Gitleaks 8.30.1 changed-file snapshot | No leaks found; release archive checksum verified before use |
| Diff whitespace check | Passed under repository Git line-ending configuration |

Final regression evidence is in ignored local `phase2-regressions-final.log`;
type/build/docs/lint logs use the same `phase2-` prefix. Swift evidence is in
`local_artifacts/ios-phase2/`, SQL evidence in
`local_artifacts/phase2-device-auth-evidence.md`, and the finite HTTP proof report
in `local_artifacts/phase2-gateway-proof.json`. The disposable PostgreSQL cluster
was stopped, its listener was absent afterward, and generated schemas were removed.
No configured database was reused. Earlier test iterations found and corrected
a confirmation-envelope assertion, a queued-owner TypeScript declaration, and
the shared-store renewal race; the final checks above passed.

Security-negative coverage includes missing/malformed/forged credentials, wrong
audience/origin/scope, expired/revoked sessions, renewal deadline, pairing expiry/
replay/concurrent consume, authorization before parsing, oversized/malformed/
empty JSON, unauthorized administrative and capability operations, ownership in
all job states, spoofed device/read-token headers, cross-workspace revocation,
confirmation replay and payload mutation, and atomic Keychain failure/cancellation/
stale-response handling. Existing Swift second-challenge and exact-retry tests
remain passing.

Run the bounded HTTP synthetic proof with:

```sh
node scripts/validate-ios-device-gateway.mjs
```

It emits a finite JSON assertion report for actual Express/auth/confirmation
handlers with synthetic device/job storage and capability execution. It proves
pairing -> authenticated creation -> owned polling/result, cross-device denial,
rotation/revocation, narrow authorization, parser bounds and exact confirmation
retry. It does not invoke a provider or Python executor. The separate PostgreSQL
suite tests real transactions, concurrency, lock-wait expiry and SQL constraints.

Windows cannot perform an Xcode/iOS SDK build. Linux Swift tests do not exercise
Apple Keychain, Foundation Models, App Intents, Siri or system approval UI. The
new macOS CI job selects Xcode 26.3 and builds the unsigned simulator app; it has
not run remotely during local validation. No physical iPhone or live
Gateway/provider/Local Agent round trip is claimed.
The complete repository-wide test suite, deployed migration and multi-replica
live behavior were not exercised; the focused and SQL suites are the evidence
reported here. TLS/Keychain APIs require the hardware acceptance sequence below.

## PR review and integrated E2E follow-up

PR #1496 now includes a required, disposable PostgreSQL 18 fixture that runs the
compiled Swift `ArcanosDeviceE2E` client through real URLSession requests, the
Gateway HTTP boundary/router, production device repositories, queued GPT worker
execution and fenced terminal persistence. It also executes the explicit Local
Agent confirmation/retry path and persists a synthetic executor result through
the production repository. Eleven Swift observations and eleven independent
backend assertions must all pass; skipped execution or unverified cleanup fails
the runner. The required PostgreSQL CI job retains a sanitized report bound to
the checked-out commit (GitHub's test merge commit for pull requests).

The fixture reproduced a real requester-device idempotency collision: two phones
using the same explicit key for the same executor/action conflicted in the SQL
binding despite distinct request fingerprints. Device requests now include their
requester identity in the key hash. Real PostgreSQL coverage verifies separate
jobs across devices and stable deduplication within one device; focused unit
coverage preserves the previous operator key hash exactly.

Local validation of the follow-up passed with Node 24.18.1, Swift 6.2 and
PostgreSQL 18.6, including both integrated tests, all eleven backend assertions,
77 focused JavaScript/TypeScript regressions, and 18 XCTest tests plus 77 Swift
Testing functions. Type checking passed; lint had zero errors and 76 existing
warnings. The owned schema was removed, HTTP server closed, and temporary local
PostgreSQL server stopped with no remaining listener.

The transport adapter maps one logical HTTPS origin onto loopback HTTP. Keychain
item storage, local inference, provider responses, and executor registration and
output are synthetic. This proves the integrated client/backend flow within
those fixture boundaries; it does not establish TLS trust, physical iPhone/Siri/
Foundation Models behavior, system Keychain persistence, live provider quality,
the Python executor, full production startup, or deployed migrations. The
[repeatable fixture instructions](README.md#device-gateway-and-postgresql-end-to-end-fixture)
describe its guards, execution command and evidence format. The physical-device
acceptance procedure remains necessary before claiming live iPhone readiness.

## Railway preview fixture follow-up

The sealed preview now executes the production-shared device grant schema,
credential state validation, owned-job predicate, and requester-idempotency helper
under `ios-device-policy/v1`. Failed assertions prevent web readiness and withhold
the proof header. The exact-head native verifier checks that header within its
unchanged 138-request matrix; the Swift HTTPS runner validates the fixed policy
response before and after its Gateway flow and requires passive-worker denial.
The actual Swift client exposed a preview admission mismatch for its mandatory
device-origin header. The synthetic routes now accept only the exact matching
PR HTTPS origin with the public fixture bearer and selector; negative cases cover
duplicate, mismatched and additional credential headers.

Local validation passed 743 focused Jest tests, 16 native-verifier tests, 18
XCTest tests and 80 Swift Testing functions, full build/type checking, and lint
with zero errors and 76 existing warnings. The real PostgreSQL/Swift integrated
fixture still passed all eleven backend assertions after policy extraction.
These local results are prerequisites for the maintained preview lifecycle;
executed Railway results must independently identify the tested commit, trusted
controller, owned deployments, both verifier reports, and teardown. The preview
uses synthetic data and a passive worker; it does not supply durable pairing,
database, provider, active-worker or physical-device evidence.

## Physical iPhone live-test procedure

This procedure requires a separately authorized non-production deployment of the
reviewed web/worker code and migration; none was performed by this task.

1. On the trusted backend, configure the exact HTTPS device origin and existing
   Gateway principal/workspace. Explicitly enable the four required Gateway
   scopes. Enable only reviewed Local Agent actions in the existing MCP
   allowlist and retain the existing executor/workspace registration policy.
   Verify the device tables exist and Gateway TLS validates normally.
2. On a Mac with Xcode 26 selected, run `swift test --package-path
   clients/ios/ArcanosKit`. Open the checked-in ArcanosVoice project, choose a
   signing team and a compatible physical iPhone running iOS 26, build/install,
   launch once, and enable Apple Intelligence/Siri where supported.
3. From the existing trusted operator tool/terminal, send JSON to
   `POST /gpt-access/devices/pairing` with its normal operator authentication.
   For confirmation testing explicitly request `capabilityActions` containing
   `git.status` and `tests.run`; include `patch.apply` only when a reviewed test
   patch is intended. Privately transfer only the resulting short-lived
   `pairingToken` to the phone. Do not copy the operator header/token to iOS.
4. In ArcanosVoice Settings, enter the exact Gateway HTTPS origin and pairing
   token and pair within five minutes. Inspect the session and verify the paired
   device ID/state. Relaunch and verify Keychain restoration. Confirm the same
   challenge cannot register another device.
5. Invoke the installed ARCANOS App Shortcut through Siri, or assign the desired
   “Hey Arcanos” shortcut phrase using Apple's supported Siri/Shortcuts setup.
   This app does not install a custom wake-word listener. Ask a request that
   Phase 1 deterministically routes remotely. Verify App Intent -> ArcanosKit ->
   authenticated Gateway job -> owned result -> Siri/system spoken response.
   Record only safe device/job identifiers, timestamps and observed results.
6. Invoke Run Tests on the registered test workspace. Verify
   `CONFIRMATION_REQUIRED`, cancel once and confirm no execution; invoke again,
   approve explicitly and verify one exact retry and one accepted job. Verify
   actual Python executor completion and spoken result separately.
7. Pair a second test phone/isolated client. Using its device credential in a
   trusted test harness, request the first device's job ID. Expect `not_found`
   with no result. Verify the owner can read it. Do not export production phone
   secrets for this check; use isolated test principals/credentials.
8. Renew before expiry; verify a new credential, same device ID and owned-job
   access, and rejection of the old test credential. Revoke from the operator
   context and verify further phone polling fails even after relaunch. Test an
   expired isolated session and confirm clear re-pairing guidance without success.
9. Disable networking on the phone. Invoke a local-capable request and verify
   Foundation Models output continues on supported hardware. Invoke a remote-
   required request and verify unavailable/authentication guidance rather than
   success. Re-enable networking and verify authorized remote operation resumes
   only with a current, unrevoked credential.
10. Revoke test devices and remove transient pairing material from the transfer
    surface. Keep evidence free of headers, credentials and confirmation tokens.

## Recommended Phase 3

Perform the hardware/live acceptance matrix above and address measured failures.
Then consider protected durable job-handle continuity across app termination,
reviewed voice-parameter extraction, and resilience of explicit confirmation
across multiple web replicas. Preserve the existing capability and confirmation
boundaries; richer UI, additional platforms and memory redesign are separate work.

<!-- PHASE2_FILE_INVENTORY -->
## File inventory

Added (29):

- `.github/workflows/ios-client.yml`
- `clients/ios/ArcanosKit/Sources/ArcanosDeviceE2E/Configuration.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosDeviceE2E/DeviceProof.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosDeviceE2E/LoopbackTransport.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Gateway/DevicePairingClient.swift`
- `clients/ios/ArcanosKit/Tests/ArcanosDeviceE2ETests/ConfigurationTests.swift`
- `clients/ios/ArcanosKit/Tests/ArcanosKitTests/DeviceAuthenticationTests.swift`
- `clients/ios/PHASE2_ENGINEERING_REPORT.md`
- `migrations/20260911_gpt_access_devices_v1.rollback.sql`
- `migrations/20260911_gpt_access_devices_v1.sql`
- `scripts/validate-ios-device-gateway-e2e.mjs`
- `scripts/validate-ios-device-gateway.mjs`
- `src/core/db/gptAccessDeviceSchema.ts`
- `src/core/db/repositories/gptAccessDeviceRepository.ts`
- `src/routes/gpt-access-devices.ts`
- `src/services/gptAccessDeviceAuth.ts`
- `src/services/gptAccessDeviceCredentials.ts`
- `src/services/gptAccessDeviceHttpBoundary.ts`
- `src/shared/ios/iosDevicePreviewFixture.ts`
- `src/shared/security/gptAccessDevice.ts`
- `src/shared/security/gptAccessDevicePolicyCore.ts`
- `tests/gpt-access-device-credentials.test.ts`
- `tests/gpt-access-device-openapi-contract.test.ts`
- `tests/helpers/gptAccessDeviceRepository.ts`
- `tests/integration/gpt-access-device-auth.pg18.integration.test.ts`
- `tests/integration/ios-device-gateway.e2e.integration.test.ts`
- `tests/ios-device-e2e-runner.test.js`
- `tests/ios-device-preview-application.test.ts`
- `tests/ios-device-preview-fixture.test.ts`

Modified (59):

- `.env.example`
- `.github/workflows/ci-cd.yml`
- `.gitleaksignore`
- `backend-index.json`
- `cli-agent-index.json`
- `clients/ios/ArcanosKit/Package.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/AI/RemoteAI.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Gateway/GatewayClient.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Gateway/GatewayCredential.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Models/GatewayModels.generated.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Runtime/SessionResult.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Security/CredentialStore.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosPreviewProof/ObservedTransport.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosPreviewProof/ProofRunner.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosPreviewProof/ResponseEvidence.swift`
- `clients/ios/ArcanosKit/Tests/ArcanosPreviewProofTests/ConfigurationTests.swift`
- `clients/ios/ArcanosKit/Tests/ArcanosPreviewProofTests/ResponseEvidenceTests.swift`
- `clients/ios/ArcanosVoice/Sources/AppRuntime.swift`
- `clients/ios/ArcanosVoice/Sources/ArcanosIntents.swift`
- `clients/ios/ArcanosVoice/Sources/SettingsView.swift`
- `clients/ios/README.md`
- `clients/ios/scripts/derive-gateway-contract.mjs`
- `clients/ios/scripts/gateway-contract.generated.json`
- `docs/API.md`
- `docs/BACKEND_INDEX.md`
- `docs/CI_CD.md`
- `docs/CLI_AGENT_INDEX.md`
- `docs/CONFIGURATION.md`
- `docs/DATABASE_MIGRATIONS.md`
- `docs/gpt-access-gateway.md`
- `docs/RAILWAY_DEPLOYMENT.md`
- `docs/SCHEMA_PROTOCOL_GUIDE.md`
- `package.json`
- `packages/arcanos-runtime/src/redaction.ts`
- `prisma/schema.prisma`
- `scripts/check-native-pr-preview-imports.mjs`
- `scripts/native-pr-preview-contract.d.mts`
- `scripts/native-pr-preview-contract.mjs`
- `scripts/native-pr-preview-e2e.mjs`
- `scripts/native-pr-preview-e2e.test.mjs`
- `scripts/native-pr-preview-imports-tsconfig.json`
- `src/app.ts`
- `src/core/db/repositories/localAgentJobRepository.ts`
- `src/core/db/schema.ts`
- `src/nativePrPreviewApplication.ts`
- `src/nativePrPreviewContract.ts`
- `src/routes/gpt-access.ts`
- `src/services/actionPlanExecution/canonical.ts`
- `src/services/gptAccessGateway.ts`
- `src/services/localAgent/service.ts`
- `src/services/moduleLoader.ts`
- `src/shared/gpt/asyncGptJob.ts`
- `src/shared/types/express.d.ts`
- `tests/async-gpt-job.test.ts`
- `tests/gpt-access-gateway.test.ts`
- `tests/local-agent-service.test.ts`
- `tests/native-pr-preview-import-boundary.test.js`
- `tests/postgres-ci-truth-contract.test.js`
- `tests/runtime-redaction.test.ts`
