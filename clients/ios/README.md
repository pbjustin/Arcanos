# ARCANOS iPhone client — Phase 2 secure connectivity

The iPhone is an ARCANOS edge client. Siri, App Intents, App Shortcuts and system
snippets are its primary interface. The host app provides device pairing, diagnostics,
a temporary note, and a Debug simulation switch. No backend or Local Agent logic
has moved into Swift.

The existing Swift foundation now connects through scoped, expiring, revocable
device credentials. An operator creates a one-use pairing token on the trusted
server side; the iPhone consumes only that token. Master Gateway, operator, backend,
and Local Agent credentials never belong on the phone. Existing operator clients
retain their authentication lane. Deployment and physical-iPhone verification are
separate steps; synthetic tests do not prove live providers, workers, or Siri.

## Components and existing authorities

| Component | Repository location / responsibility |
| --- | --- |
| Existing backend | `src/`, strict TypeScript ESM Express; root npm workspaces, Node 24.18.1 / npm 11.16.0 |
| GPT Access Gateway | `src/routes/gpt-access.ts`, `src/services/gptAccessGateway.ts` |
| OpenAPI source | `buildGptAccessOpenApiDocument` in the Gateway service; served at `/gpt-access/openapi.json` |
| Confirmation authority | `src/transport/http/middleware/confirmGate.ts`, `confirmationChallengeStore.ts`, capability middleware in `src/routes/gpt-access.ts` |
| Durable jobs | `src/workers/jobRunner.ts`, `src/core/db/repositories/`, existing Gateway create/result APIs |
| Local Agent | `src/services/localAgent/`, `src/routes/gpt-access-local-agent.ts`, `daemon-python/arcanos/local_agent/` |
| Shared contracts | `packages/protocol/`; Local Agent generated capability catalog at `packages/protocol/schemas/v1/local-agent/capability-catalog.generated.json`; service-specific public contracts in `contracts/` |
| Reusable Swift foundation | `clients/ios/ArcanosKit/`, a Swift 6 package with no third-party dependencies or SwiftUI dependency |
| iPhone host and intents | `clients/ios/ArcanosVoice/`, checked-in Xcode project, iOS 18 deployment target |

`ArcanosKit/Sources/ArcanosKit/` contains:

- `AI/`: `ArcanosAI`, shared presentation profile, runtime-checked `LocalAI`,
  Gateway-backed `RemoteAI`, deterministic `AIRouter`.
- `Gateway/`: injectable transport, scoped credential interface, capability
  discovery/invocation, frozen requests, bounded job polling, isolated demo.
- `Models/`: generated Codable/Sendable OpenAPI DTOs and extensible `JSONValue`.
- `Runtime/`: session orchestration, conservative result projection, and a
  one-use confirmation coordinator.
- `Security/`: origin-bound Keychain identity and atomic session replacement;
  unlocked-device-only, nonsynchronizing, device-only protection. The host accepts
  only a one-use pairing token, with no master/operator credential field.
- `Tools/`: a bounded, memory-only note store. No shell, Git, or filesystem tool.

`ArcanosVoice/Sources/` contains the app entry point, runtime adapter, five
App Intents, App Shortcuts, static system snippet and settings view. App Intents
require local device authentication. Approval is an additional explicit system
interaction; device unlock alone does not approve an action.

## Routing and offline behavior

| Spoken command / context | Execution |
| --- | --- |
| Hello / Hi / Hello Arcanos | Local when Foundation Models is available; remote fallback otherwise; never attaches the captured note |
| Summarize this note / Summarize my note / Summarize this / Summarize the note | Local with a nonempty captured note of at most 8,000 UTF-8 bytes |
| Rewrite this note / Make this note shorter / Turn this note into bullet points | Same bounded local transformation path |
| What did I just capture? / Read my note / Read this note | Same local context boundary |
| Check my repository / Check my repo / Git status | Existing Local Agent `git.status` capability, then durable job result |
| Run tests / Run my tests | Existing Local Agent `tests.run`, `typescript-unit` profile by default, confirmation and job result |
| Apply that patch / Apply the patch | Only a patch previously supplied to `session.previewPatch` and confirmed applicable by the backend in this session; `patch.apply` with that exact patch and returned hash |
| Coding, repository analysis, current knowledge, test-failure reasoning, other open requests | Existing remote `arcanos-core` AI job |

Matching normalizes case, surrounding whitespace and trailing sentence
punctuation. The local allowlist is intentionally small. The model cannot expand
it, call capabilities, provide confirmation, or claim remote effects. More complex
language/parameter extraction is a future extension, not authorization inferred
from generated text. Test-failure reasoning currently submits a remote AI job;
automatic collection of Local Agent diagnostics for that reasoning is not wired.

Foundation Models is conditionally imported and checked at runtime on iOS 26 /
macOS 26. A fresh `LanguageModelSession` avoids overlapping generation. A device
without a ready supported model falls back to the Gateway provider; an unpaired,
expired, or revoked phone reports the authentication state. Generation errors also fall back;
cancellation never triggers a fallback. Debug route logs contain finite reason
and destination enums only, not prompts, notes, results, IDs, or credentials.

Eligible on-device inference needs no ARCANOS network connection. Siri's own
speech availability depends on device/settings and is separate from the model.
The note is attached to a remote fallback only for the explicit note commands;
unrelated requests do not upload it. The host explains this behavior. Notes,
approval challenges and job handles live only in process memory. App termination
loses them, without cancelling accepted backend jobs. The client never silently
queues or automatically replays a disconnected mutation. Foreground polling is
bounded; pending results expose a Check Latest Arcanos Job action.

Cancellation before transport prevents submission, including cancellation during
credential lookup. A valid job receipt already received is retained for later
status checks even if the caller cancels; no polling or resubmission follows in
that cancelled task. Overlapping job reads cannot restore a consumed patch preview.

## API derivation and wire behavior

The client operation paths are:

```text
POST /gpt-access/jobs/create
POST /gpt-access/jobs/result
GET  /gpt-access/capabilities/v1
GET  /gpt-access/capabilities/v1/{capabilityId}
POST /gpt-access/capabilities/v1/{capabilityId}/run
POST /gpt-access/devices/pair
GET  /gpt-access/devices/session
POST /gpt-access/devices/renew
POST /gpt-access/devices/{deviceId}/revoke
```

Run from the repository root with the pinned Node toolchain and installed dev
dependencies:

```sh
node clients/ios/scripts/derive-gateway-contract.mjs
node clients/ios/scripts/derive-gateway-contract.mjs --check
```

The script reads the existing TypeScript OpenAPI builder using its AST. It does
not import the backend, initialize a database, read secrets, or invoke providers.
It derives selected models and an operation/schema snapshot in
`clients/ios/scripts/gateway-contract.generated.json`. Review changes when the source contract changes. This
is a deliberately limited generator, not a competing OpenAPI definition or a
full client-side schema validator. Backend validation remains authoritative.

The client uses only canonical Gateway paths. It never follows response-supplied
job URLs, uses public job-read routes, invokes the Local Agent executor protocol,
or sends control operations through `/gpt/:gptId`. The ephemeral URLSession uses
HTTPS only, rejects redirects, disables cookies/cache, and has request/resource
timeouts. It checks a 2 MiB response cap after buffering; a streaming byte cap is
future transport hardening. Request bodies are bounded. HTTP error text is not
reflected into speech or logs.

Capability HTTP success is not execution success. The Local Agent's inner
`ok`, `accepted` and `persisted` receipt must all be true; the session then reports
pending. Only a matching completed job with a successful Local Agent outcome can
produce a completed action response. Failed, expired, missing, malformed and
unavailable results never produce a success claim.

## Exact confirmation flow

1. Prepare and freeze the capability path, original action/payload bytes and
   idempotency key. Send it without a confirmation token.
2. Accept only the Gateway's `403 CONFIRMATION_REQUIRED` envelope and challenge.
   Keep the raw challenge ID private to the coordinator; show a local opaque
   approval handle and action summary.
3. Ask explicitly through `requestConfirmation`. Cancellation discards the
   pending approval. Saying “yes” to the general Ask intent does not approve it.
4. Consume the local approval handle before awaiting transport. Retry the frozen
   request exactly once, appending only top-level
   `"confirmation_token": "<raw challenge id>"`. Preserve the idempotency header.
5. Expired approval, a failed retry, or another challenge stops. Concurrent or
   repeated approvals cannot issue a third request. App restart fails closed.

The backend remains authoritative for body/actor/principal/workspace binding,
expiry and single-use consumption. There is no `x-confirmed: yes`, automatic
approval, token obtained from model output, or generic shell escape hatch.

## Pairing, credentials, and server authorization

`DevicePairingClient` consumes a generated `DevicePairRequest` at
`POST /gpt-access/devices/pair`. It sends a random installation UUID retained in
Keychain and the short-lived `agp1.` pairing token. The UUID identifies the local
installation; it does not authenticate the phone. The server consumes the pairing
challenge exactly once and returns an `agd1.` opaque device credential with
`gpt-access-device-v1` audience, the canonical HTTPS origin, server device ID,
issue/expiry dates, the absolute renewal deadline, scopes, approved capability
actions, and the fixed `arcanos-core` GPT target. Raw pairing tokens never enter
Keychain, preferences, files, or logs. The entry field clears on submission.

The trusted operator creates challenges through `POST /gpt-access/devices/pairing`.
That endpoint is absent from the phone's pairing client. Challenges expire after
five minutes. Credentials last at most one hour. Explicit renewal before expiry
replaces the old credential, retaining the device and authorization context, within
a 30-day absolute pairing window. An expired credential or an exhausted renewal
window requires fresh operator pairing; there is no refresh secret on the phone.

`GatewayCredentialProvider` remains the live transport seam. The shipping host
uses `KeychainCredentialStore` with `AppleKeychainItemStorage`; tests inject an
atomic item-store double. Each origin has a single complete session item protected
by `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, with iCloud synchronization off.
Only the nonsecret Gateway origin and Debug simulation preference use UserDefaults.
Pairing and renewal DTO debug descriptions are generated with secret redaction.

Each protected request sends `Authorization: Bearer <device credential>` and
`X-Arcanos-Device-Origin` containing the paired canonical origin. The backend
authenticates the stored credential state and authorizes the scope on every request.
The origin header binds the intended audience; it is not an identity proof and is
not a replacement for TLS or the credential. Client URL validation remains HTTPS
only, origin bound, and redirect rejecting. No secret follows a response-provided URL.

The device has only the explicitly granted subset of `jobs.create`, `jobs.result`,
`capabilities.read`, and `capabilities.run`. Capability grants are restricted to
the existing `ARCANOS:LOCAL_AGENT` actions `git.status`, `tests.run`, `patch.preview`,
and `patch.apply`; operator pairing defaults to `git.status`. Granting `tests.run`
or `patch.apply` still invokes the existing one-use confirmation flow. Device
pairing cannot authorize administrative APIs, executor claims, arbitrary shell,
other GPT targets, or unrelated capabilities.

Jobs use the same canonical create/result APIs and generated models as Phase 1.
The server records device/principal/workspace ownership on creation and checks it
for pending and terminal result reads. Knowledge of a job ID is insufficient.
No public-job read-token fallback was added; existing public-job token protection
and trusted-operator access remain separate. A polling authentication error retains
an accepted job handle while explicitly stating that the result could not be read.

The client exposes `unpaired`, `paired`, `expired`, `revoked`, `renewal_required`,
and `authentication_failure`. The final five minutes of a valid credential show
renewal required. Known server authentication failures update Keychain state and
stop subsequent use; a late rejection for an old token cannot poison its replacement.
The store serializes pairing, renewal, and revocation for each origin across
client instances, captures the credential/device together, and checks the original
credential before accepting a replacement. Stale replies cannot overwrite a newer
session or release its operation lock. Before renewal or self-revocation, the client atomically records a fail-closed
marker. A lost reply, cancellation, or failed Keychain replacement requires pairing
again; it never automatically resends a potentially consumed credential. Successful
renewal atomically replaces that marker and old secret. Successful revocation
records revoked state. **Forget local credential** only removes the local session;
it does not claim server revocation. An expired/revoked device can be revoked from
the trusted operator context even when it cannot authenticate on the phone.

Local routing is unchanged and continues independently of credentials when the
Foundation Models runtime is available. No authentication error reports remote
completion or silently replays a remote action.

## Run the physical-iPhone validation

1. On a Mac, install Xcode 26 or newer with an iOS SDK. Open
   `clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj`.
2. Select the **ArcanosVoice** target → **Signing & Capabilities**. Enable
   **Automatically manage signing**, choose your Team and use your own unique
   bundle identifier. No API keys, server secrets, custom microphone entitlement,
   or extra background mode are needed.
3. Connect and unlock the iPhone, trust the Mac, and enable **Settings → Privacy
   & Security → Developer Mode** if prompted. Restart and confirm when requested.
   Select the **ArcanosVoice** scheme and your iPhone destination, then **Run**.
4. Open **ARCANOS** once. For real local inference use a supported Apple
   Intelligence iPhone on iOS 26+, enable Apple Intelligence in Settings and wait
   until the host reports the local model available. Capture a short note in the
   host, for example “Buy apples and milk. Call Sam tomorrow.” Keep simulation off.
   On an explicitly authorized test Gateway with the Phase 2 schema installed,
   configure the canonical HTTPS device origin and the existing operator
   principal/workspace context. In that trusted operator context, create a
   pairing challenge with the minimal desired scopes and `capabilityActions`;
   include `tests.run` only for the approved test capability exercise. Read only
   the returned `origin`, `pairingToken`, and `expiresAt` into the pairing workflow.
   In the iPhone's **Pairing** section, enter that HTTPS origin and one-use token,
   then tap **Pair this iPhone** before its five-minute expiry. The app should
   report paired. Tap **Check device session** to verify server acceptance.
5. In **Shortcuts**, tap **+ → Add Action → Apps → ARCANOS → Ask Arcanos**.
   Leave **Command** unset and name the shortcut **Arcanos Voice**. Run it once
   manually to check parameter prompting. Choose **Prefer Spoken Responses** in
   **Settings → Siri** (or **Apple Intelligence & Siri**) **→ Siri Responses**.
6. Open **Settings → Accessibility → Vocal Shortcuts → Set Up** (or **Add Action**)
   **→ Continue**. Select **Arcanos Voice**. If it is not listed, select **Siri
   Request** and enter “Run Arcanos Voice”. Set the vocal phrase to **Hey Arcanos**
   and complete the prompted voice repetitions.
7. Say **Hey Arcanos**, pause for the system, authenticate if requested, and answer
   **“Summarize this note”** when asked **“What do you need?”**. Expect spoken text
   and an ARCANOS result snippet. This is the real on-device test.
8. Say **Hey Arcanos**, then **“Explain why an integration test can time out”**.
   This request deterministically requires remote ARCANOS. Verify a device
   authentication audit event, an owned job creation, and an owned result read
   on the test Gateway. Expect the result spoken by Siri and shown in the system
   snippet; a pending result requires **Check Latest Arcanos Job**. Verify that
   the same device's credential is used throughout without logging its value.
9. With an approved `tests.run` grant and an isolated test workspace/Local Agent,
   say **Hey Arcanos → Run tests**. Decline once and verify no retry, then repeat
   and approve the exact system prompt. Verify one retry with unchanged endpoint,
   action, payload, and idempotency key plus only the confirmation token. Check
   the accepted job until it reports the actual outcome. Pairing alone must not
   execute the action. Test device A reading device B's job using a controlled
   test client and verify denial without returning B's result.
10. Tap **Renew device credential** while it is valid. Verify continued access
    and that the old secret is rejected from an isolated test client. Then revoke
    the phone from the trusted operator context and ask for a remote request or
    poll again: expect revoked/authentication failure with no success claim. Also
    test natural one-hour expiry without renewal and fresh pairing afterward.
11. Disable Wi-Fi and cellular networking, retain the captured note, and invoke
    **Summarize this note** or **Read my note** on a model-ready iPhone. Verify
    local completion and no Gateway request. Test Shortcuts directly if Siri's
    own speech path needs networking. Lock the phone and verify protected intents
    require local device authentication and Keychain access fails closed.
12. For the optional **synthetic Gateway/approval/job** demonstration, use a Debug build and turn
   **Simulate the Gateway** on. Say **Hey Arcanos → Run tests**, explicitly approve
   the system prompt, and expect a **Simulation** pending response. Run **Check
   Latest Arcanos Job** from Shortcuts/Siri; the first check may still be pending,
   then the next confirms the synthetic result. Repeat and decline approval to
   verify no retry. This also works on iOS 18+ without Foundation Models.

Vocal Shortcuts is Apple's supported wake mechanism; ARCANOS does not install an
always-listening microphone or persistent wake daemon. These hardware steps are
a validation procedure, not a claim they were executed in the Windows environment.

Apple references: [Foundation Models availability and generation](https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models),
[App Intent confirmation](https://developer.apple.com/documentation/appintents/appintent/requestconfirmation(conditions:actionname:dialog:)),
[Vocal Shortcuts setup](https://support.apple.com/guide/iphone/use-vocal-shortcuts-iph7f242ea2c/ios),
[Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

## Supplemental Swift HTTPS preview proof

After the [maintained Railway PR preview lifecycle](../../docs/RAILWAY_DEPLOYMENT.md)
has established the exact PR head, owned web/worker deployments, and both HTTPS
hosts, `ArcanosPreviewProof` exercises the actual Swift client against its sealed
synthetic HTTP peer. This separate executable is not part of the iPhone host.
Build and run it from a clean checkout of that exact head on macOS or Linux with
Swift 6.2, using a process environment without service/provider credentials.

First validate the arguments and Git evidence without making network requests:

```sh
swift run --package-path clients/ios/ArcanosKit ArcanosPreviewProof \
  --repository-root /absolute/path/to/clean/checkout \
  --pr-number <PR-number> --commit-sha <exact-40-character-head-SHA> \
  --web-base-url <confirmed-web-HTTPS-origin> \
  --worker-base-url <confirmed-worker-HTTPS-origin>
```

For an authorized executed proof, repeat the same command with both
`--execute --allow-network`. The default run reports `executed: false` and zero
requests. Origins must identify this PR under `*.up.railway.app`; production,
redirects, alternate origins, paths, queries, embedded credentials, and incomplete
network opt-ins are rejected. The checkout must have canonical GitHub origin,
matching HEAD, and no tracked or untracked changes. In WSL, use a Linux Git
checkout; Windows worktree metadata may contain paths Linux Git cannot resolve.
Keep the JSON output outside the evidence checkout.

The proof checks both served identities and compact fixture metadata before
admitting canonical Gateway requests, then verifies them again at completion.
It uses the package's `GatewayClient`, `URLSessionGatewayTransport`, generated
DTOs, session, polling, and confirmation coordinator. Its observing wrapper adds
only the fixed synthetic selector, records fixture traffic, and controls response
delivery for deterministic concurrency checks. Every response is received over
HTTPS; none is substituted. Only the compiled public test bearer is used.

Coverage includes all five canonical operations, a create/pending/completed AI
flow, terminal failure, a redacted HTTP error, exact original request bytes and
idempotency on one approved retry, rejected approval replay, cancellation without
a retry, and passive-worker/unauthenticated/malformed-request denials. It also
cancels Swift tasks immediately after receiving accepted HTTP receipts and holds
two real patch-result responses to verify accepted job handles survive and a
consumed preview cannot be rearmed. The approval here is an explicit synthetic
harness decision; it does not exercise Apple's system approval UI.

The credential-free `GET /ios/device-contract` runs the production-shared grant
schema, credential state policy, owned-job predicate, and requester-device
idempotency helper over fixed synthetic inputs. The Swift proof checks its exact
`ios-device-policy/v1` response and served identity before and after Gateway
traffic, and requires the passive worker to deny it. Web readiness runs the same
assertions fail-closed; the supplemental native verifier requires its versioned
proof header on both existing readiness requests, preserving the trusted
138-request plan. This covers invalid grants/origins, expiry and renewal,
revocation and audience, owner isolation, and idempotency isolation without
credentials, persistence, or protected effects. The synthetic Gateway routes
accept the Swift client's device-origin header only when it exactly matches the
owned PR HTTPS host, together with the fixed selector and public fixture bearer.

The run permits at most 40 requests, 120 seconds, and 2 MiB of aggregate response
data, retaining the actual transport's request/resource timeouts. Its JSON report
contains the tested SHA/PR, executed/network flags, finite assertion names,
request/byte counts, and scope. It does not print prompts, credentials, challenges,
or raw server errors. The server fixture replies are validated separately against
the source-derived Gateway snapshot in
`tests/ios-gateway-preview-fixture.test.ts`; run contract derivation `--check` at
the same head. This supplemental proof does not replace trusted lifecycle
ownership evidence or establish live pairing/authentication, SQL, a real queue,
provider inference, actual Local Agent execution, Siri, or Foundation Models.

### Durable recovery over preview HTTPS

After the same trusted lifecycle establishes both hosts, build the executable
from the clean exact-head Linux/macOS checkout and run the recovery parent:

```sh
swift build --package-path clients/ios/ArcanosKit --product ArcanosPreviewProof
preview_bin_dir=$(swift build --package-path clients/ios/ArcanosKit --show-bin-path)
python3 clients/ios/scripts/run-operation-recovery-preview.py \
  --swift-binary "$preview_bin_dir/ArcanosPreviewProof" \
  --pr-number <PR-number> --commit-sha <exact-40-character-head-SHA> \
  --web-base-url <confirmed-web-HTTPS-origin> \
  --worker-base-url <confirmed-worker-HTTPS-origin>
```

This first run verifies arguments and clean Git evidence without HTTP or index
writes. Repeat with both `--execute --allow-network` for the authorized proof.
The parent starts fresh Swift processes for submission, an unknown-handle
negative control, accepted-handle recovery, and terminal restoration. Each
executed process uses the existing production HTTPS transport and checks both
roles, device-policy evidence, and fixture metadata before job traffic; successful
phases repeat those gates afterward. The parent checks the actual file between
processes, verifies stable job identity and exact request counts, and removes its
temporary files. The unknown-handle read must return the specific missing-job
failure without modifying either saved index or creating a job.

The full proof is bounded to 120 seconds, with 40 seconds per child. It makes 32
HTTPS requests: one create, three result reads (one negative, two successful),
and 28 identity/contract reads. The initial dry child adds no requests. A single
run must finish within the sealed peer's 120-second job retention. The report
includes phase process IDs, assertion names, counters, exact source commit and
binary hash; build provenance still requires building that binary at the tested
commit. Logs belong outside the evidence checkout. Remove the opt-in label only
after all supplemental proofs finish, then verify the trusted lifecycle removes
the exact owned preview and both former hosts deny readiness.

This proves file/process recovery over actual HTTPS against the sealed synthetic
peer. It does not establish shipping app/Siri recovery, real paired-device
authorization, database durability, active worker execution, or provider results.
The [loopback recovery fixture](#durable-operation-recovery-fixture) separately
covers lost receipts, process termination during submission, and corrupt results.

## Device Gateway and PostgreSQL end-to-end fixture

`ArcanosDeviceE2E` connects the real Swift pairing, Gateway, session, polling and
confirmation clients to the real Express Gateway handlers and a disposable
PostgreSQL 18 database. The backend uses the production credential, job and
Local Agent repositories. A finite worker claims and executes the queued GPT
request through the configured dispatcher, SDK and Trinity path, then persists
the fenced result. Provider responses, local inference, executor registration/
output and Keychain item storage are fixtures.

Run from a Linux checkout with the pinned Node/npm toolchain, Swift 6.2 or later,
installed npm dependencies, and an explicitly disposable PostgreSQL 18 database:

```sh
npm run build:packages
swift build --package-path clients/ios/ArcanosKit --product ArcanosDeviceE2E
ios_device_e2e_bin_dir=$(swift build --package-path clients/ios/ArcanosKit --show-bin-path)
IOS_DEVICE_E2E_DATABASE_URL=postgresql://arcanos_ci@127.0.0.1:5432/arcanos_ios_e2e_test \
IOS_DEVICE_E2E_SWIFT_BINARY="$ios_device_e2e_bin_dir/ArcanosDeviceE2E" \
  node scripts/validate-ios-device-gateway-e2e.mjs
```

The runner does not create a database or start PostgreSQL. It accepts only an
explicit loopback port and the dedicated `arcanos_ios_e2e_*` database names or
the existing CI database `arcanos_audit_pg18_20260727`. It creates a schema named
for a fresh run ID and removes it afterward. Never substitute a configured
application database. Missing prerequisites, incomplete evidence, skipped tests,
child timeouts and unconfirmed cleanup fail the command.

The proof covers unpaired local operation, authenticated pairing, consumed-token
replay rejection, durable AI results, foreign-device result concealment,
confirmation cancellation without execution, one exact approved retry, Local
Agent results, renewal with rejection of the old credential, revocation, and
independent idempotency keys for phones sharing an operator/workspace/executor.
The latter includes same-phone deduplication and caught a database binding
collision that synthetic repository tests did not detect.

The fixture's URLSession transport remaps the fixed logical HTTPS origin to a
bounded loopback HTTP listener. Production transport and its HTTPS/redirect
policy are unchanged; this proof does not verify TLS, a physical iPhone, Siri,
Apple Keychain, Foundation Models or actual Python executor/provider behavior.
The separate macOS workflow verifies the unsigned iOS Simulator build.

## Durable operation recovery fixture

The Phase 3 recovery index is a reusable core; it is not yet connected to the
shipping session, app lifecycle, or App Intents. `ArcanosRecoveryProof` tests that
core through production `OperationTracker`, `FileOperationPersistence`,
`GatewayClient`, and `JobClient` with separate Swift processes and actual HTTP
requests to a disposable loopback fixture.

On Linux or macOS with Swift 6.2.4 and Python 3.10 or later, run from the repository:

```sh
swift test --package-path clients/ios/ArcanosKit
swift build --package-path clients/ios/ArcanosKit --product ArcanosRecoveryProof
recovery_bin_dir=$(swift build --package-path clients/ios/ArcanosKit --show-bin-path)
python3 clients/ios/scripts/run-operation-recovery-e2e.py --swift-binary "$recovery_bin_dir/ArcanosRecoveryProof"
```

The parent verifies intent is on disk before submission, one create per operation,
restart/result recovery, foreign partition isolation, failed-read preservation,
lost receipts, and SIGKILL before receipt with no duplicate submission. Its
positive sequence requires 11 distinct process IDs, seven requests, and three
creates. A separate mandatory corrupted-result run must fail at result validation.
Temporary files and the loopback listener are removed before success is reported.
For a standalone expected-failure run, add `--inject-fault corrupt-completion`;
it must exit nonzero with `CORRUPTED_COMPLETION_REJECTED`.

The executable accepts only `--execute --allow-loopback` with bounded parent
configuration on stdin. Its test adapter permits only create/result POSTs to a
fixed logical origin and one exact loopback HTTP port; it disables redirects,
proxies, cookies, and shared credentials. Each process receives its synthetic
credential independently. The index contains neither credentials nor prompt or
result content. JSON evidence records the checked-out SHA/dirty state and binary
hash; compile immediately before execution. CI does this in the macOS job.

This is process/file/client-wire evidence. It does not prove shipping HTTPS,
Keychain or locked-iPhone file protection, actual server authorization or job
execution, automatic recovery of an unknown job handle, or Siri/app lifecycle
recovery. See the [Phase 3 engineering report](PHASE3_ENGINEERING_REPORT.md).

The required PostgreSQL CI job runs this fixture and retains its sanitized
`ios-device-e2e/v1` JSON artifact. Success requires all eleven Swift observations
and eleven independent backend assertions, the same run ID/source commit, and
confirmed server/schema cleanup. The report identifies local uncommitted changes.
For pull requests, CI tests GitHub's merge commit; verify that report's source SHA
and its PR head/base parents when using the artifact as published source evidence.

## Validation and next phase

Implementation checks on 2026-09-10: Swift 6.2 portable Linux debug/test and release
builds passed; 18 XCTest tests and 40 Swift Testing functions passed, including
all parameterized cases. The tested package source hashes matched the checkout.
The four existing Gateway/OpenAPI/Local Agent/confirmation Jest suites passed
279 tests with Node 24.18.1 / npm 11.16.0. Contract generation, positive and
negative drift checks, generator syntax, documentation/index checks and app
Swift syntax parsing passed. The checked-in Xcode project references, shared
scheme and privacy manifest passed static checks. Source/log review found only
synthetic fixture credentials and enum-only route logging.

Xcode compilation, physical iPhone/Siri execution, Apple Keychain and Foundation
Models runtime behavior, live Gateway/Local Agent integration, and the full
repository test suite were not run. No production actions were performed.

On a Mac with Xcode 26 selected:

```sh
swift test --package-path clients/ios/ArcanosKit
xcodebuild -project clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj \
  -scheme ArcanosVoice -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The portable package tests use injected providers/transports, with no live
credentials or backend operations. They cover model unavailability, routing,
malformed API results, transport/auth failures, cancellation, bounded polling,
confirmation expiry/replay/concurrency, accepted-receipt cancellation, cancelled
credential lookup, overlapping preview reads and exact one-time retry semantics.
Linux tests cannot exercise Foundation Models, Keychain, SwiftUI, or App Intents.
Physical-device validation must include supported/unsupported model availability,
offline inference, Siri input/output, locked-device behavior and explicit
approval/cancellation. Never infer those results from a package compile.

Phase 2 adds pairing, live device authentication, renewal/revocation, and associated
negative tests while retaining the existing routing/confirmation orchestration.
Current portable checks are recorded in the Phase 2 engineering report; the dated
Phase 1 evidence above is historical and does not validate the new Apple runtime path.

Recommended Phase 3: validate the complete flow on physical hardware against an
authorized test deployment, then add protected durable job-handle continuity and
reduce pairing/renewal friction based on those results. Bounded voice parameter
extraction and a reviewed patch preview/share flow can follow separate approval.
Backend
reasoning, capabilities, Git, test execution, patching, queueing and orchestration
remain authoritative.
