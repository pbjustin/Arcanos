# ARCANOS iPhone client — Phase 1

The iPhone is an ARCANOS edge client. Siri, App Intents, App Shortcuts and system
snippets are its primary interface. The host app only provides diagnostics, a
temporary note, and a Debug simulation switch. No backend or Local Agent logic
has moved into Swift.

**Live remote use is blocked on a paired-device authentication addition.** The
current Gateway accepts a server-wide bearer, which must never be put on a phone.
This phase supports real on-device generation and an explicit in-memory Gateway
demonstration. Simulation is not evidence of a live backend, provider, queue, or
Python agent call.

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
- `Security/`: origin-bound, expiring Keychain storage; unlocked-device-only,
  nonsynchronizing, device-only protection. No credential entry or default token.
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
language/parameter extraction is a Phase 2 extension, not authorization inferred
from generated text. Test-failure reasoning currently submits a remote AI job;
automatic collection of Local Agent diagnostics for that reasoning is not wired.

Foundation Models is conditionally imported and checked at runtime on iOS 26 /
macOS 26. A fresh `LanguageModelSession` avoids overlapping generation. A device
without a ready supported model falls back to the Gateway provider; the shipping
host currently reports pairing unavailable. Generation errors also fall back;
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

The five operation paths are:

```text
POST /gpt-access/jobs/create
POST /gpt-access/jobs/result
GET  /gpt-access/capabilities/v1
GET  /gpt-access/capabilities/v1/{capabilityId}
POST /gpt-access/capabilities/v1/{capabilityId}/run
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

## Authentication prerequisite for live use

`GatewayCredentialProvider` is the integration seam; `KeychainCredentialStore`
is the device store. `storePairedCredential` must only receive a credential from
a future authenticated pairing exchange. Keychain storage does not make a
master credential suitable for a phone. The host deliberately offers no token
field and does not instantiate a live Gateway.

The minimal backend addition must:

1. Issue short-lived, revocable device sessions after authenticated pairing;
   include stable device/principal identity, intended Gateway audience, workspace
   access and least-privilege action scopes. Define refresh/logout/revocation.
2. Enforce those claims in Gateway authorization rather than relying on the
   current server-global principal/workspace configuration. Preserve stable
   confirmation actor identity across valid credential rotation.
3. Bind job creation, reads, and Local Agent capability execution to the paired
   principal/workspace. Current generic GPT job provenance checks alone are not
   per-device ownership authorization. Cross-device and cross-workspace reads
   must fail closed.
4. Return only the device credential to iOS over authenticated TLS. Keep all
   master Gateway and Local Agent executor credentials server-side.

No backend route, auth policy, SQL, worker, environment setting, package lock,
or Local Agent implementation was changed for this phase.

## Run the first voice test on an iPhone

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
8. For the full **synthetic Gateway/approval/job** test, use a Debug build and turn
   **Simulate the Gateway** on. Say **Hey Arcanos → Run tests**, explicitly approve
   the system prompt, and expect a **Simulation** pending response. Run **Check
   Latest Arcanos Job** from Shortcuts/Siri; the first check may still be pending,
   then the next confirms the synthetic result. Repeat and decline approval to
   verify no retry. This also works on iOS 18+ without Foundation Models.

Vocal Shortcuts is Apple's supported wake mechanism; ARCANOS does not install an
always-listening microphone or persistent wake daemon. A real Gateway/Local Agent
voice test cannot run until the authentication prerequisite above is implemented.

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

Phase 2: implement and audit device pairing/authorization first; then validate
on hardware, add protected durable job-handle continuity, richer bounded voice
parameter extraction and backend diagnostic collection, expose a reviewed patch
preview/share flow, and add consent-aware persistent local context. Backend
reasoning, capabilities, Git, test execution, patching, queueing and orchestration
remain authoritative.
