# Phase 3B: shipping recovery integration

Date: 2026-09-11. This milestone connects the recovery core to shipping product
entry points. It does not claim all of Phase 3 or physical Siri recovery.

## Baseline and inspection

Review preparation rechecked GitHub: PR #1497 **merged** at
2026-09-11 20:33:01 UTC, producing
`ac2382575c16d6ed3ea26a31ddf6d090e7d875e9`, the fetched `origin/main` HEAD.
Its second parent is the original Phase 3B base,
`685ccf701ca87eb3fbebf52be755e3f9b16cde3f`; that checkpoint is reachable from
main. The checkpoint and merged main have identical trees, including the
expected recovery core.

Branch `codex/ios-phase3b-shipping-recovery` was rebased onto `ac238257...`
without conflicts. There were no Phase 3B commits to replay: its uncommitted
integration was first saved in a named stash with untracked files and a backup
branch, then restored after the fast-forward rebase. All tracked changes and
eight untracked files retained identical Git-normalized content. No published
history was rewritten and no Phase 3A code was squashed into Phase 3B. The
separate local `main` checkout remains at `128107bc...` with unrelated edits
preserved; the updated remote-tracking main is the integration baseline.

Root `AGENTS.md`, the iOS README, Phase 2 and Phase 3 engineering reports,
shipping source, generated Gateway contract, Xcode project and test workflows
were inspected. There are no nested iOS instruction files. The reported Railway
138/138, HTTPS 18 assertions, 32-request recovery proof and historical 115 Swift
tests are previous core evidence, not new shipping or device evidence.

The prior app factory constructed transient `RemoteAI`/`ArcanosSession` instances.
`knownJobs` and `AppRuntime.latestJobID` were memory-only; Check Latest explicitly
said tracking was cleared after restart. The host only refreshed shortcuts, with
no recovery lifecycle hook. There was an `OperationTracker`, but no reusable
submission/recovery coordinator to wire directly. Its file writer was atomic,
but each tracker cached a private snapshot, allowing separate writers to lose
each other's updates. Phase 2 credential reads exposed identity and credential
through separate calls, unsuitable for binding restored operations atomically.

## Shipping entry points and composition

- `ArcanosVoiceApp` observes active scene transitions through a cancellable SwiftUI
  task. `AppRuntime.activate()` invokes shared `startup()` on first activation and
  `foreground()` on subsequent activations and presents recovered result snippets.
- `AskArcanos.perform()` uses `AppRuntime.ask()` and
  `ShippingSessionComposition.ask()`, which enters the real `ArcanosSession`.
- `CheckArcanosJob.perform()` uses `AppRuntime.checkLatestJob()` and shared
  `checkLatest(operationID:)`. A fresh intent constructs the same composition
  without requiring a previous host UI launch. An optional reference identifies
  a specific operation; unspecified references require one recent candidate.
- Explicit system approval/cancellation stays in App Intents; their runtime
  calls enter the same composition and existing `ConfirmationCoordinator`.
- Narrow read-only Ask follow-ups use an explicit phrase allowlist before AI
  routing. SwiftUI/App Intents presentation stays outside `ArcanosKit`.

The Xcode project contains one application target. App Intents and `AppRuntime`
are sources of that target, not an extension. The factory uses its Application
Support `Arcanos/operations.json` and existing `org.arcanos.voice.credentials`
Keychain service. No App Group, shared-container entitlement or extension was added.
Debug simulation remains an explicitly separate in-memory fixture.

`ShippingSessionComposition` and `DurableSessionRecovery` orchestrate the existing
tracker, `JobClient`, `CapabilityClient`, authentication and confirmation machinery.
There is one index, with the same JSON array format and retention. A backward
compatible optional `capabilityAction` field holds only one allowlisted action,
so a restored Local Agent result can be projected safely without storing payloads.

The storage partition is canonical HTTPS origin plus server-issued device UUID.
The Phase 2 server binds this device to its principal/account/workspace; there is
no model-supplied account or second local identity. One Keychain snapshot returns
the credential and device identity together. A partition-bound provider checks
that context for each request and before result presentation. Renewal can retain
device identity; a different device/origin cannot inherit the operation or approval.

## Submission, lifecycle and safety

The shared session prepares the durable record before network transmission, sends
the existing authenticated create/capability request, and promptly saves a valid
accepted receipt. The initial AI ask performs zero result polls and acknowledges
pending work. Closing the voice interaction does not cancel the backend job.
App suspension cancels the active observation task. Process termination discards
volatile tasks and approvals; later startup or intent entry reopens disk state.
Critical persistence never depends on a termination callback.

Startup/foreground perform at most four sequential job reads per activation;
status entry selects one operation. Existing transport timeouts remain in force.
No polling daemon or suspension-time progress is promised. Repeated activation
and separate observers may repeat reads, but never submit accepted work again.
Fresh results must match job identity and canonical state and pass the existing
result projection before an observation is saved. Cached terminal metadata is
not a substitute for a fresh authoritative result. Unknown, expired, corrupted,
mismatched or inaccessible results are not successful answers.

The existing backend provides no lookup by lost create receipt. Recovery therefore
preserves `prepared`/`submissionUncertain`, the same operation UUID and idempotency
key, and sends no replay. This is an explicit unresolved observation, not a failed
job, automatic new semantic operation or claim of exactly-once execution.

The minimum core repairs are:

- Lock the stable sidecar for an entire local read/modify/write transaction and
  reload within every transaction. Atomic replacement alone could lose concurrent
  changes. The lock is released by the OS on process death, waits at most one
  second under contention, and contains no network suspension. Unreadable files
  fail closed rather than becoming empty state.
- Read identity and credentials from one secure record; preserve missing,
  temporary unavailability, expired and revoked states. No identity recreation,
  credential deletion or partition switch occurs during recovery.
- Inject the existing Gateway client's clock for deterministic credential-expiry
  checks; the default still uses the real clock. HTTPS, origin, certificate,
  redirects and authorization headers are unchanged.

Confirmation remains an exact original-request challenge flow: explicit approval,
one retry of the frozen endpoint/action/payload and idempotency context, with only
top-level `confirmation_token` containing the raw challenge. No token is nested in
payload or saved in the index. Failure or another challenge ends that flow.
Restoration never supplies approval or replays a privileged retry. Patch payloads
and approval secrets remain memory-only; a restored preview cannot arm an apply.
Existing `tests.run` and `patch.apply` protection and local-only routing remain.

## Local validation and evidence

Fresh post-rebase validation used Swift 6.2.4 on WSL Ubuntu 24.04, Python 3,
and pinned Node 24.18.1/npm 11.16.0. Package builds used the mounted working
tree and a new empty external scratch directory. The fixture parents received
explicit mapped Git directories for the Windows worktree; this process-local
adjustment did not alter repository configuration. Reports identify base SHA
`ac2382575c16d6ed3ea26a31ddf6d090e7d875e9` with `sourceDirty: true`, including
the restored Phase 3B sources. Source hash manifests confirmed those sources
stayed unchanged throughout validation. Proofs used fresh Release binaries.
The commands below use `<scratch>` for that external directory.
Final preparation subsequently removed one trailing blank line in the shared
fixture transport and updated documentation; shipping behavior did not change.

| Evidence level / actual command | Result |
| --- | --- |
| `swift build --package-path clients/ios/ArcanosKit --scratch-path <scratch>` | PASS, all package products |
| `swift test --package-path clients/ios/ArcanosKit --scratch-path <scratch>` | PASS, 18 XCTest + 123 Swift Testing tests in 11 Swift Testing suites; 141 total |
| `swift build -c release --package-path clients/ios/ArcanosKit --scratch-path <scratch>` | PASS, all Release products |
| `python3 clients/ios/scripts/run-shipping-recovery-e2e.py --swift-binary <release-bin>/ArcanosShippingRecoveryProof` | PASS, shipping composition/session integration across 21 processes; mandatory disabled-wiring control rejected |
| Same shipping command with `--inject-fault wiring-disabled` | Expected exit 1, `SHIPPING_RECOVERY_WIRING_BYPASSED`; not a positive pass |
| `python3 clients/ios/scripts/run-operation-recovery-e2e.py --swift-binary <release-bin>/ArcanosRecoveryProof` | PASS, separate existing core proof: 11 processes, 7 HTTP requests, 3 creates for 3 distinct operations; mandatory corrupt completion rejected with `COMPLETED_RESULT_MISMATCH` |
| Same core command with `--inject-fault corrupt-completion` | Expected exit 1, `CORRUPTED_COMPLETION_REJECTED` with child `COMPLETED_RESULT_MISMATCH`; separate negative-control run |
| `node clients/ios/scripts/derive-gateway-contract.mjs --check --typescript <installed-typescript-path>` | PASS, 22 schemas and 10 operations; no contract drift |
| `npm run build -w @arcanos/protocol`, `@arcanos/cli`, `@arcanos/runtime`, `@arcanos/openai` | PASS, four local package prerequisites |
| Focused Jest command below | PASS, 322/322 tests in five suites, one fresh LF source fixture containing the current Phase 3B overlay; zero skipped or failed |
| `node scripts/run-jest.mjs --runTestsByPath tests/commit-guard-large-diff.test.ts --coverage=false --runInBand --no-cache` | PASS, 8/8 isolated Git fixture tests; targeted ESLint and guard JavaScript syntax also passed |
| `npm run guard:commit` | PASS after the narrow Swift reference classification repair described below |
| `npm run docs:check` | PASS, 462 documentation checks and current generated indexes; CLI index updated for the new Python runner |
| `npm run docs:links -- --local-only` | PASS, 300 local targets; 33 discovered external URLs were not fetched |
| `swiftc -frontend -parse clients/ios/ArcanosVoice/Sources/*.swift` | PASS, syntax only; does not resolve Apple SDK types |
| `git diff --check` | PASS |
| `npm run sync:check` | PASS, zero errors/warnings, five existing informational suggestions |
| `gitleaks dir clients/ios --redact`, workflow and final staged-patch scans | iOS scan flagged two reviewed pre-existing generic-key false positives in idempotency-validation expressions in `CapabilityClient.swift` and `OperationTracker.swift`; no credential values. Workflow scan found zero findings; staged patch scan found only the same tracker-expression false positive in context. No finding was silently suppressed. |

The focused Node command was:

```sh
node scripts/run-jest.mjs --runTestsByPath \
  tests/gpt-access-device-credentials.test.ts \
  tests/gpt-access-device-openapi-contract.test.ts \
  tests/gpt-access-gateway.test.ts \
  tests/local-agent-module-contract.test.ts \
  tests/agent-execution-confirmation.test.ts --coverage=false --runInBand --no-cache
```

Those tests use mocked repositories, providers/dispatch and executor doubles,
plus loopback Express requests. They ran with an explicitly sanitized environment
and a fixture-only socket guard; no developer Gateway URL or credentials were
inherited. The fresh source fixture was an LF archive of `ac238257...` plus the
current integration overlay, matching Git's committed content. It avoids the
known Windows CRLF SQL-migration comparison failure without changing source or
test semantics. All five suites passed together: Gateway 282, device credentials
20, device OpenAPI 9, Local Agent contract 10, and execution confirmation 1.
No historical test result is substituted for this post-rebase run.

The initial staged commit guard rejected the fixture's Swift named arguments
reading `configuration.token` and `config.token` as if they were literal secrets:
its existing code-expression
classification covered TypeScript/Python but not Swift. The preparation adds
only unquoted Swift `identifier.member` recognition. Ordinary quoted literals,
Swift raw literals, token signatures and unquoted values outside code remain
blocked, with focused regression tests. No guard was disabled or suppressed,
and no fixture credential expression was disguised to evade the check.

The shipping positive sequence records **19 actual HTTP requests, 3 submission
attempts and 3 synthetic semantic executions**, across three distinct operations.
The accepted-receipt scenario contains **17 requests: 1 create and 16 result
reads**, including injected failures and concurrent reads. Its single operation,
job and authenticated partition survive Process A's acknowledgement then SIGKILL,
Process B's startup/foreground and Process C's verified status result. The other
two operations test receipt loss and termination before receipt; each makes one
HTTP create, one synthetic semantic execution, and zero recovery submissions.

The mandatory wiring-disabled control creates a separate synthetic operation,
then deliberately bypasses the production startup adapter. It fails with the
specific wiring error and zero recovery reads. Including that internal control,
the shipping command uses **23 processes, 20 HTTP requests, 4 submission attempts
and 4 synthetic semantic executions across 4 separate operations**. The standalone
negative run is additional and independently returns the expected nonzero exit.
These are fixture execution counts, not real worker/provider execution evidence.

The parent independently checks file-before-create ordering, actual HTTP headers,
partition, original idempotency key, operation/job identity, result projection,
secret/prompt/result absence from the index and request counts. Two startup
processes synchronize their reads, and a held pending response is released after
a separate process verifies completion; it cannot overwrite or present stale
pending state. No shared memory is available between children. Both positive
proofs confirmed loopback server and temporary-store cleanup. The separate LF
Node archive/extraction remains in the task workspace because automatic approval
review again rejected normal, resolved-path-checked cleanup as "blocked by
policy", without a more specific reason. The paths are `phase3b-baseline-lf/`
and `phase3b-baseline-lf.zip`, outside the repository. Only the historical local
validation wrapper refers to them; they affect neither shipping packaging nor
the fresh tests. They were not staged. The new LF source snapshot is retained
separately under external `review-validation/` as reproducible test evidence.

Regression coverage includes repeated activation, direct intent-adapter restoration,
concurrent submissions and observations, receipt-delivery cancellation, lost receipts,
corrupt/mismatched results and store bytes, device/origin isolation, credential
expiry/revocation/removal and temporary secure-storage denial, network unavailability,
ambiguous references, local-mode continuity, exact approval retry/replay/expiry,
no privileged restoration and preserved live versus restored patch-preview behavior.

Raw local logs, source manifests and sanitized JSON evidence are retained in
the task workspace's external `review-validation/` directory. Swift logs and
proof JSON are under `20260911-163602-swift/`; Node commands, source hashes and
results are in `node-validation-summary.json`, `node-jest-results.json`, and
`node-*.log`. Documentation and redacted secret-scan logs are alongside them.
Each process report's binary hash accompanies the source SHA/dirty marker.

## Checks NOT RUN and remaining limits

- iOS SDK/Xcode compilation and an unsigned Simulator build: no Xcode on this
  Windows/WSL host. The checked-in CI step is future automation, not executed CI.
- Simulator runtime execution, physical-device App Intent/Siri, dictation/spoken
  dialog, system confirmation, Apple Keychain and locked-device file protection,
  and Foundation Models runtime: Apple frameworks/hardware were unavailable.
  Swift package tests exercise the shared adapter used by intents, not actual Siri.
- Live Gateway or preview HTTPS recovery, live pairing, Railway verifier/deployments,
  AI providers, Local Agents and privileged remote operations: excluded by scope.
- Disposable PostgreSQL end-to-end suite, full repository sweep and remote CI:
  not run. This integration changes no backend persistence or contract; selected
  mocked Phase 2 regression coverage is reported separately from SQL E2E evidence.

No test weakens the shipping HTTPS, certificate, origin or authentication policy.
Fixture transport alone maps a fixed synthetic HTTPS origin to one explicit
loopback HTTP listener and rejects alternate hosts/routes/redirects. Credentials,
local inference and remote results are injected doubles. Interprocess/file proof
does not establish Apple file protection or actual OS intent lifecycle scheduling.

## Physical-device procedure — NOT RUN

1. On a Mac with Xcode 26, run package tests and build the `ArcanosVoice` scheme.
   An unsigned Simulator build is compilation evidence only. Separately launch
   the Simulator and exercise supported UI/intent paths; record runtime evidence.
2. With separate operator authorization, install a signed build on an unlocked
   physical iPhone and pair it to a designated non-production HTTPS Gateway using
   Phase 2 pairing. Record the source revision and device/OS/toolchain versions.
3. Invoke **Ask Arcanos** for one authorized remote request. Record the displayed
   operation reference and backend job identity with appropriately redacted
   diagnostics. Independently count create HTTP attempts and semantic jobs.
4. After the pending acknowledgement, dismiss Siri. Check the same operation
   without terminating the app; this tests interaction completion alone.
5. Start another separately authorized request, dismiss Siri, background/suspend
   the app and later foreground it. Do not assume polling ran during suspension.
6. For the accepted-receipt case, terminate the app after acknowledgement and
   relaunch it. Startup must recover the same operation and job, without a create.
   Invoke **Check Latest Arcanos Job** with its operation reference and retrieve
   the verified result. Independently confirm the original idempotency context,
   one HTTP submission and one semantic execution for that operation.
7. Terminate again and invoke the status intent before opening the host UI.
   Verify restoration works directly. Create two plausible candidates and verify
   a missing reference asks for clarification rather than choosing silently.
8. Separately exercise temporary Keychain denial/locked device, network loss,
   expiry, revocation, renewal and changed pairing. No old operation may move to
   another partition; local-capable requests must remain available when supported.
9. Under separate explicit approval for the exact privileged test request, test
   challenge/approval/retry and process termination before/after its receipt.
   Restoration must never count as approval, repeat the retry, or rearm an old
   patch. Count HTTP attempts separately from semantic execution.

This task did not execute this procedure or authorize its remote operations.
APNs, background notification infrastructure and broader Phase 3 features remain
outside this milestone.

## Files and execution boundaries

Added files:

- `clients/ios/ArcanosKit/Sources/ArcanosKit/Runtime/ShippingSessionComposition.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosFixtureSupport/Configuration.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosFixtureSupport/LoopbackTransport.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosShippingRecoveryProof/ShippingRecoveryProof.swift`
- `clients/ios/ArcanosKit/Tests/ArcanosKitTests/ShippingSessionTests.swift`
- `clients/ios/ArcanosKit/Tests/ArcanosKitTests/RuntimeSafetyTests.swift`
- `clients/ios/scripts/run-shipping-recovery-e2e.py`
- `clients/ios/PHASE3B_ENGINEERING_REPORT.md`

Modified files:

- `clients/ios/ArcanosKit/Package.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Runtime/ArcanosSession.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Runtime/OperationTracker.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Runtime/SessionResult.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Security/CredentialStore.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosKit/Gateway/GatewayClient.swift`
- `clients/ios/ArcanosKit/Sources/ArcanosRecoveryProof/LoopbackTransport.swift`
- `clients/ios/ArcanosKit/Tests/ArcanosKitTests/OperationTrackerPersistenceTests.swift`
- `clients/ios/ArcanosVoice/Sources/AppRuntime.swift`
- `clients/ios/ArcanosVoice/Sources/ArcanosIntents.swift`
- `clients/ios/ArcanosVoice/Sources/ArcanosVoiceApp.swift`
- `clients/ios/ArcanosVoice/Sources/VoiceSnippet.swift`
- `clients/ios/ArcanosVoice/Sources/SettingsView.swift`
- `.github/workflows/ios-client.yml`
- `check-commit-guard.js`, `tests/commit-guard-large-diff.test.ts`
- `clients/ios/README.md`, `clients/ios/PHASE3_ENGINEERING_REPORT.md`
- `cli-agent-index.json`, `docs/CLI_AGENT_INDEX.md`

No backend API, database schema, remote capability, infrastructure or production
configuration changes were made. Phase 3B is prepared as one focused local
commit above the merged Phase 3A baseline. Publication instructions and a draft
PR body are supplied separately; no push, PR creation, merge, deployment,
preview, credential rotation or live privileged operation is part of this run.

## Merge sequence and remaining gates

Phase 3A is merged and the Phase 3B base has been updated. Publish the focused
Phase 3B branch for review only after publication is authorized. Before merging,
require the final-base local proofs, green `docs:check` and `All Checks Complete`
at the final head, passing macOS/iOS compilation, and resolved review threads.
Refresh the base and checks if main advances. The draft must be ready for review
before a merge recommendation. Physical iPhone/Siri and live-service validation
remain a separately authorized subsequent milestone, using the procedure above.
