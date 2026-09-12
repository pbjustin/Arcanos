# Phase 3C device and Apple-runtime validation

Prepared against merged Phase 3B baseline
`4f3652ed4397e8b7de8891696ea6160d4cd51af2` on 2026-09-12 UTC
(2026-09-11 local operator date). Record the
actual revision and uncommitted overlay again before every run. The reported
`8b24d2b5` checkpoint is historical; it is not this baseline identifier.

This runbook separates local preparation, Apple builds, actual app execution,
physical hardware, and live services. Preparation on Windows does not establish
Apple-platform or physical-device success. The older physical-iPhone sequence in
[README.md](README.md#run-the-physical-iphone-validation) combines live pairing
and hardware work; do not execute its live steps under the Phase 3C fixture scope.
The [Phase 3B report](PHASE3B_ENGINEERING_REPORT.md) documents the reused shipping
composition and its earlier evidence limits.

For an operator without a Mac, use the
[cloud build, signing and TestFlight runbook](PHASE3C_CLOUD_RUNBOOK.md). A
separately authorized TestFlight installation replaces the local-Mac signing
and USB installation steps below. The physical observations and evidence limits
remain required. Its expanded A-K matrix distinguishes cloud build, Simulator
runtime, signing, upload, App Intent and Vocal Shortcut evidence; this runbook's
original A-G labels remain unchanged for historical device records.

## Authorization and evidence

The original device-tooling preparation permitted isolated injected transports
and local synthetic fixtures. It did not permit any ARCANOS Gateway request, including health,
status, pairing or session inspection; Railway production/preview access;
providers; Local Agents; notifications; deployment; remote workflow dispatch;
commit, push or PR publication. Each later run must follow its current explicit
operator authorization; the no-Mac workflow's publication and upload gates are
specified in the cloud runbook. A ready phone does not expand that authority.
Official Apple documentation and read-only repository/CI metadata are permitted.

Use one record per check with `PASS`, `FAIL`, `BLOCKED` plus its actual dependency,
or `NOT RUN`. A failure means an attempted check violated its expected result;
missing equipment is blocked. Preserve the following independent levels:

| Level | Evidence required | Status at Windows preparation |
| --- | --- | --- |
| A | Xcode/iOS SDK compilation of the actual application target | BLOCKED: no available Mac/Xcode/iOS SDK |
| B | Simulator execution of the installed app and its lifecycle/composition | BLOCKED: no available Mac/Simulator runtime |
| C | Physical-device system Keychain reads, writes and lifecycle protection | BLOCKED: authorized iPhone, Mac and signing setup unavailable |
| D | Actual Foundation Models inference on supported physical hardware | BLOCKED: model-capable authorized iPhone and ready model unavailable |
| E | Spoken physical App Intent/Siri activation, capture, confirmation and presentation | BLOCKED: authorized iPhone and configured system interaction unavailable |
| F | Installed physical app/intent recovery with synthetic remote results | BLOCKED: authorized iPhone, signing and installation unavailable |
| G | Live pairing/Gateway/provider/executor behavior | NOT RUN: separate explicit authorization required |

For each record include:

- UTC time, full `git rev-parse HEAD`, `git status --short`, relevant changed-file
  hashes, and the exact build configuration. A dirty source tree is not an
  exact-commit build; retain its sanitized diff or manifest with the evidence.
- macOS/Xcode/Swift/SDK/runtime versions or device model and OS version/build;
  whether hardware is physical or simulated; signing availability without the
  private identity/certificate; actual app and intent process roles.
- Real components and substitutions; exact command or manual interaction;
  expected result; observed result; status and dependency/error category.
- For recovery: synthetic operation/job correlation, lifecycle event, intercepted
  transport submissions, actual HTTP attempts, synthetic semantic execution count,
  restored status and validated result. Never equate the two request counters.

Keep sanitized evidence under ignored `local_artifacts/ios-phase3c/<run-label>/`
or an approved directory outside the repository. DerivedData, `.xcresult`, copied
app containers, certificates and raw device logs do not belong in commits or
packaging. Do not publish UDIDs, serial numbers, personal device names, bearer
values, pairing codes, raw challenges, private prompts or unrelated container
contents. Synthetic operation/job IDs may be retained for correlation. Reduce
real installation/device partition IDs to equality/difference assertions.

## Inspect the Mac and project before building

The local helper records a source hash manifest, toolchain inventory and the
independent evidence levels without launching anything:

```sh
python3 -B clients/ios/scripts/run-phase3c-apple-validation.py \
  --output-dir local_artifacts/ios-phase3c/apple-inspection
```

On a Mac, add `--build` and choose a fresh output directory. It runs Apple Swift
package tests, builds unsigned Simulator Debug/Release/HardwareValidation, and
checks the built bundles for fixture exclusion. It does not install or launch
the app; level B still requires the runtime procedure below. A Windows run
records A/B as BLOCKED. Logs and build products are retained locally; no cleanup,
signing change, remote workflow or backend request is performed.

Use the existing isolated checkout. Do not reset, clean, stash or overwrite
another checkout. On the operator's Mac, from repository root:

```sh
git rev-parse HEAD
git status --short
xcode-select -p
xcodebuild -version
xcrun swift --version
xcodebuild -showsdks
xcrun simctl list runtimes
xcodebuild -list -project clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj
```

Keep device and signing inventories local. In Xcode's Devices and Simulators
window, determine whether the owner-authorized phone is connected and trusted.
Record only its model and OS/build in the sanitized evidence. Inspect the
installed signing identities locally; record available/unavailable, not their
certificate details. Choose an existing compatible stable Xcode installation.
Do not install a beta or raise the project's deployment target to make a check
easier. Apple-only calls must be checked against the selected SDK, not inferred
from command-line Swift syntax parsing on Linux.

Baseline project facts to recheck after applying the tooling overlay:

| Item | Source fact |
| --- | --- |
| Project | `clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj` |
| Shipping target and shared scheme | `ArcanosVoice` |
| Shipping configurations | `Debug`, `Release`; scheme launch/test/analyze uses Debug, profile/archive Release |
| Minimum iOS | `IPHONEOS_DEPLOYMENT_TARGET = 18.0` |
| Swift | `SWIFT_VERSION = 6.0`, strict concurrency `complete` |
| Platforms | iPhone, `iphoneos` and `iphonesimulator`; Mac Catalyst disabled |
| Local package | `../ArcanosKit`; no third-party package dependency |
| Signing | Automatic; no checked-in development Team; shipping bundle ID `org.arcanos.voice` |
| Resources | Generated Info.plist and bundled `PrivacyInfo.xcprivacy` |
| Entitlements | No custom entitlements file, App Group, shared Keychain group, push entitlement or background mode declared |
| Intents | Five App Intents are compiled into the app target; no separate extension target |
| Existing protection | Intents require local device authentication; Keychain is unlocked-only, device-only, nonsynchronizing |
| Apple model API | `canImport(FoundationModels)` plus iOS/macOS 26 runtime availability guard |

The app remains installable at its iOS 18 minimum. Real Foundation Models tests
require iOS 26+ and eligible ready hardware. An iOS 18 Simulator/device is useful
for unavailable-framework handling and does not establish model inference.

After signing a hardware build, inspect that build's generated Info.plist,
privacy manifest, App Intents metadata and signed entitlements locally. Confirm
the fixture bundle identity and absence of added broad ATS exceptions, trust-all
handlers, push/background modes or cross-app credential groups. An unsigned
Simulator build has no physical signing/entitlement evidence.

## Isolate the app before any launch

The baseline `AppRuntime.init()` restores the saved Gateway origin and default
credential service. `activate()` calls shipping startup/foreground recovery and
can issue result reads using persisted credentials. The old Debug **Simulate the
Gateway** switch is applied after construction and uses a different in-memory
session; it cannot prove shipping restoration. Do not launch ordinary Debug or
Release against an existing app container for this task.

Use scheme **ArcanosVoice-HardwareValidation**, configuration
**HardwareValidation**, of the same application target. This selects isolation
before `restoreGateway`, credential lookup or lifecycle activation, including a
fresh App Intent invocation. The build defines `ARCANOS_HARDWARE_VALIDATION`
alongside `DEBUG`; ordinary Debug/Release exclude the hardware fixture sources.
Confirm the visible **Hardware validation** label before sending any command.

| Fixture boundary | Exact selection |
| --- | --- |
| Installed bundle | `org.arcanos.voice.hardware-validation` |
| Display name | `ARCANOS Fixtures` |
| Keychain service | `org.arcanos.voice.hardware-validation.credentials.v1` |
| Logical origin | `https://arcanos-hardware-fixture.invalid` (never resolved or contacted) |
| Persistence root | App Application Support `ArcanosHardwareValidation-v1/` |
| Client recovery index | `operations.json` using the existing `FileOperationPersistence` |
| Synthetic server state/counters | `fixture-ledger.json` using the same bounded file transaction primitive |
| Keychain persistence expectation | `keychain-expectation.json`, digests of the known synthetic items only; never secret item bytes |
| Fresh ledger mode | `localOnly`; fixture responses require an explicit mode change |

The runtime rejects any bundle ID other than the fixed fixture identity, never
loads shipping preferences or real paired credentials, and exposes no live
pairing controls. The fixture adapter rejects unexpected origins/routes and
errors without constructing a live transport. Persisted fixture mode controls
cannot select a live Gateway. No preference or launch argument enables fixture
adapters in an ordinary shipping build.

The in-app fixture exercises `AppRuntime`, `ShippingSessionComposition`, the
existing session/router/recovery coordinator, and the actual App Intents. Real
Keychain and real `LocalAI` can be selected independently of synthetic Gateway
responses. Synthetic replies establish neither server authentication nor TLS.
For an injected in-process fixture, actual HTTP requests are **zero**; count
intercepted `GatewayRequest` attempts separately.

The developer panel contains the following controls. Their callbacks enter the
shipping runtime; app buttons do not prove a spoken App Intent invocation.

| Control | Operator use |
| --- | --- |
| Initialize synthetic Keychain credential | Explicitly seed a new isolated test session once; does not replace an existing session |
| Probe existing Keychain credential | Read-only persistence observation after termination/reboot; checks saved synthetic item digests |
| Probe synthetic origin and account partitions | Read canonical/foreign synthetic Keychain accounts and query a foreign synthetic recovery partition; does not switch the shipping session |
| Replace synthetic Keychain credential | Explicit atomic replacement; never use before a persistence observation |
| Delete synthetic Keychain credential | Remove only the isolated test session and verify absence; retain identity/evidence |
| Enable local-only transport guard | Reject and count every attempted Gateway request, including fallback |
| Summarize known note using real LocalAI | Capture the displayed synthetic note and call the existing app request path under the local-only guard |
| Enable fixture Gateway | Permit only the narrowly supported in-process synthetic replies |
| Submit one synthetic operation through app | Call the existing Ask path with the fixed fixture command |
| Complete pending synthetic jobs | Make all pending fixture jobs terminal and increment executions once per job |
| Check operation through app | Existing status path, optionally selecting an operation reference |
| Lose next receipt after synthetic acceptance | Arm a separate lost-receipt scenario, consumed by the next accepted fixture submission |
| Fixture authentication response | Choose `accepted`, `expired`, `revoked`, `invalid`, or `unavailable` synthetic response |
| Fixture approved-retry response | Choose `accepted`, `challengeAgain`, or `unavailable` before initiating the confirmation flow |
| Refresh validation evidence / Export validation evidence | Refresh, then save sanitized JSON locally with the matching build/lifecycle record |

Use the export sheet's local file destination; exporting does not authorize
messaging, email or cloud publication. A displayed `UNRECORDED` revision is not
revision evidence; attach the separate exact source manifest or rebuild with the
documented revision build setting. Events and counters persist across processes,
while the real model observer's attempt/success/error counts restart with its
process. Controls persist; inspect them at the start of every case. Changing a
fixture control discards its volatile challenge state, so set failure controls
before asking for a protected action, not while approving it.

No local HTTPS server or certificate installation is required by an in-process
fixture. Do not repurpose the command-line loopback HTTP adapter as device HTTPS
evidence. If a later authorized fixture uses HTTPS, give it an isolated hostname
and certificate trusted through the normal device trust mechanism, preserve ATS
and origin checks, and verify the phone's route independently. `127.0.0.1` on
an iPhone addresses the phone, not the Mac. Certificate/trust changes require
their own approved setup; never add trust-all delegates or broad exceptions.

## A: Build the shipping application and fixture configuration

Create a fresh evidence directory without deleting previous runs. Select the
actual installed Xcode using its normal command-line tools setting. From root,
with `PHASE3C_EVIDENCE` set to that directory:

```sh
xcrun swift test --package-path clients/ios/ArcanosKit \
  --scratch-path "$PHASE3C_EVIDENCE/swift"
xcodebuild -project clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj \
  -scheme ArcanosVoice -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$PHASE3C_EVIDENCE/ShippingDebug" \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj \
  -scheme ArcanosVoice-HardwareValidation -configuration HardwareValidation \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$PHASE3C_EVIDENCE/HardwareValidation" \
  ARCANOS_VALIDATION_REVISION="$(git rev-parse HEAD)+working-tree" \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj \
  -scheme ArcanosVoice -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$PHASE3C_EVIDENCE/ShippingRelease" \
  CODE_SIGNING_ALLOWED=NO build
```

Do not launch either shipping build in the fixture task. Inspect all
diagnostics, including App Intents metadata extraction, availability checks,
Swift 6 actor isolation, privacy-manifest packaging and package linkage. Record
each command's exit status and build log. The baseline Xcode scheme has no app
test target/testables; `swift test` is a package suite, not an app UI test.
If tests are absent, record that fact rather than calling `xcodebuild test` a
successful app-runtime validation.

The fixture command marks the current uncommitted overlay as `+working-tree`;
retain the changed-file manifest with it. After later authorized publication,
use the exact clean revision if appropriate. For Xcode Run on hardware, set the
same `ARCANOS_VALIDATION_REVISION` user-defined build setting locally so exported
observations identify the build. This value is evidence metadata, not a fixture
or live-network selector. Do not archive or distribute the hardware scheme.

## B: Execute the actual app in Simulator

In Xcode select a dedicated Simulator from the installed runtime inventory and
the fixture scheme. Build and Run. Record the exact runtime, configured minimum
iOS, installed bundle ID and visible fixture label. A successful generic
destination build does not perform this step.

1. Confirm startup initializes the shipping composition with isolated credentials
   and storage. Inspect the fixture evidence before any request. No saved real
   origin or paired-device credential may appear.
2. Submit a synthetic remote request through the app's existing Ask intent path,
   verify a pending receipt and inspect durable operation identity.
3. Perform background/foreground, terminate the known test app process, relaunch,
   and use Check Latest Arcanos Job. Complete the fixture and restore the same job
   using the detailed recovery sequence below.
4. Record launch, scene activation, process change, restored states, result
   projection, and app/intent diagnostics independently. Label any simulated
   model, Keychain double or supplied command explicitly.

Optional Simulator commands must use the specifically selected test Simulator
identifier, kept local, and the actual fixture bundle ID from build settings:

```sh
xcrun simctl install "$PHASE3C_SIMULATOR_ID" "$PHASE3C_FIXTURE_APP"
xcrun simctl launch "$PHASE3C_SIMULATOR_ID" "$PHASE3C_FIXTURE_BUNDLE_ID"
xcrun simctl terminate "$PHASE3C_SIMULATOR_ID" "$PHASE3C_FIXTURE_BUNDLE_ID"
xcrun simctl launch "$PHASE3C_SIMULATOR_ID" "$PHASE3C_FIXTURE_BUNDLE_ID"
```

These commands target app installation/processes only, without resetting the
Simulator or deleting another app's data. A Simulator Keychain is Apple API
execution evidence at level B, not physical-device protection evidence at C.

## Physical-device setup

Connect the authorized phone to the Mac, unlock it, trust the Mac when prompted,
and let the owner enable Developer Mode if needed. Apple documents Developer
Mode under Settings > Privacy & Security, including a restart and user
confirmation: [Enable Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
Do not change device settings automatically.

Choose the fixture scheme and phone destination. Configure a valid development
Team; retain bundle ID `org.arcanos.voice.hardware-validation`. The runtime
deliberately rejects an arbitrary identifier, so a signing conflict requires a
coordinated fixture-only bundle/guard change and renewed isolation checks before
launch. Keep local Team/signing changes out of commits. Retain the same Team and
bundle through lifecycle/Keychain tests. Install through Xcode and confirm the
fixture label. Never enter
real pairing material in this build. Record model/OS build and actual selected
configuration without collecting hardware identifiers.

## C: System Keychain on the physical phone

Use `KeychainCredentialStore` and `AppleKeychainItemStorage` in the dedicated test
service only. The production service is `org.arcanos.voice.credentials`; never
read, overwrite, enumerate or delete that namespace. Synthetic sessions must
satisfy the existing origin, audience, UUID, scope and expiry validators. They
are storage inputs, not genuine paired credentials.

The existing item policy is `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and
`kSecAttrSynchronizable = false`. Preserve it. Apple describes unlocked-only
availability and no migration to another device:
[Keychain accessibility](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly).

Perform each check separately and record booleans/state categories without
printing credential values:

| Check | Expected observation |
| --- | --- |
| Store then retrieve synthetic session | Correct canonical origin and synthetic device partition; credential equality checked only in memory |
| Terminate actual hosting process and relaunch | Same stored identity/session without reseeding or automatic replacement |
| Reboot, then unlock as required by iOS | Same stored record; unlock is required for the chosen accessibility policy |
| Replace synthetic credential | Replacement visible, old value no longer selected, original installation identity retained |
| Delete only synthetic session | Session absent; normal local-forget semantics preserve the installation identity |
| Canonical origin handling | **Probe synthetic origin and account partitions** reads the equivalent uppercase-host/default-443/slash origin as the same synthetic record; the separate reserved `.invalid` origin/account is absent |
| Device partition query | The same probe queries `OperationTracker` with another synthetic device and finds no records; original Keychain item digests remain unchanged |
| Temporarily unavailable Keychain | Explicit unavailable outcome; no deletion, identity generation, account fallback, new submission or success claim |

The explicit initialization/replacement action saves digest expectations for
the synthetic session and installation identity. The read-only probe uses a
fresh system store and compares those expectations after relaunch/reboot. Never
export Keychain bytes; retain only the equality outcome. Do not press a
seed/replace button before reading the restored record: that would mask
persistence failure. Credentials expire within one hour by current client
validation. If reboot testing exceeds expiry, distinguish preserved record bytes
and identity from correctly refused use of an expired session; do not extend
the lifetime or move the device clock to make it pass.

The partition probe establishes actual test-service Keychain origin/account
reads plus a component-level foreign-device recovery query. It does not pair
another phone, switch the installed shipping composition to a new authenticated
device, or prove server account/workspace mapping. Keep any full physical
switched-device session scenario NOT RUN unless that precise scenario is
separately instrumented and observed. The default portable partition regressions
remain lower-level synthetic evidence.

For genuine temporary unavailability, use a supported device test or a debugger
breakpoint immediately before the existing Keychain read, lock the phone, then
resume only that read without satisfying a new authentication prompt. Record
whether it actually ran while protected data was unavailable. Suspension or an
intent waiting for unlock is **BLOCKED** for the Keychain-error observation, not
a failed security check. A synthetic locked-store toggle proves client handling
only. Do not disable authentication, weaken accessibility or attach an invented
background mode. After unlock, read the same record and operation again and
verify no side effects occurred. Never infer server expiry/revocation from this
synthetic exercise.

## D: Foundation Models on the physical phone

Use the existing `LocalAI` provider and its runtime availability checks. Apple
lists iPhone 15 Pro models and iPhone 16 models or later for Apple Intelligence;
the operator must also verify supported language/region, ready model download
and installed OS. Those system requirements do not replace this app's iOS 26
Foundation Models guard. Setup belongs to the owner:
[Apple Intelligence requirements](https://support.apple.com/en-us/121115).

1. Record the actual `SystemLanguageModel.default.availability`, including its
   unavailable reason when available in the selected SDK: `deviceNotEligible`,
   `appleIntelligenceNotEnabled`, `modelNotReady`, or the observed future case.
   An app-level generic unavailable message is insufficient to invent a reason.
   Apple recommends checking availability before generation:
   [Foundation Models availability](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel).
2. Confirm the real provider is selected. Use **Summarize known note using real
   LocalAI**, which captures **The garden meeting is Tuesday at 10 AM. Bring the
   blue notebook. Maya will bring seeds.** and invokes **Summarize this note**
   through the installed shipping request path. Separately capture/invoke through
   the actual Shortcut for the voice check at E.
3. Require a local response that preserves the meeting time, blue notebook and
   who brings seeds
   without inventing remote actions. Wording is nondeterministic; do not assert
   an exact generated sentence. Record outcome, finite route reason and sanitized
   error category. Do not substitute a canned answer for a model failure.
4. Select the fixture's local-only/no-remote mode before starting the offline
   check. After the owner's model setup has finished, the owner disables cellular
   and Wi-Fi. Repeat the bounded task. Compare transport counters before/after;
   require no application Gateway submission or fallback transport attempt.
   The transport guard rejects and counts attempted router fallback; it does
   not rewrite shipping routing policy. Claim zero attempted fallback only
   after a real local inference succeeds and `requestAttempts` stays unchanged.
   An unavailable/failing model may attempt a blocked fallback; report that
   count explicitly and do not call it successful local-only inference.
5. If the model is unavailable, retain its real status. The fixture must remain
   blocked from remote access; a truthful unavailable result is successful
   unavailable-state handling, while actual inference remains BLOCKED.

Foundation Models generation uses a fresh `LanguageModelSession`; its availability
and output must be observed on the device:
[Generate content with Foundation Models](https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models).
Zero ARCANOS transport calls is application evidence. It is not a measurement of
all system-wide traffic, Siri connectivity, dictation or speech synthesis.
Run the local-only case before creating remote fixture jobs, and let startup
finish before taking the counter checkpoint. If another lifecycle observation
changes counters during the window, retain the event record and rerun an
isolated window; do not silently attribute those reads to model fallback.

## E: Physical voice, App Intents and confirmation interaction

The configured path uses Apple's system services. It does not replace Siri's
system wake word and adds no app-owned persistent microphone or background
listener. Apple documents Vocal Shortcuts under Settings > Accessibility > Vocal
Shortcuts: choose an action or Siri Request, choose the phrase, then repeat it
as prompted. The owner may bind **Hey Arcanos** to the test shortcut:
[Set up Vocal Shortcuts](https://support.apple.com/guide/iphone/use-vocal-shortcuts-iph7f242ea2c/ios).

1. In Shortcuts create **Arcanos Fixture Voice** with the installed fixture app's
   existing **Ask Arcanos** action. Leave **Command** unset so the intent's
   `requestValue` asks **What do you need?** Confirm the action belongs to the
   fixture bundle if both shipping and fixture apps are installed.
2. Run manually once to verify registration and parameter prompting; record it
   as a manual Shortcut invocation. For spoken output, the owner selects the
   applicable Siri Responses preference (such as Prefer Spoken Responses).
3. Configure Vocal Shortcuts to invoke **Arcanos Fixture Voice**. If the shortcut
   is not offered directly, use Siri Request with **Run Arcanos Fixture Voice**.
   Use the owner's phrase and finish the system training prompts.
4. Say the chosen phrase, wait for the system, authenticate when required, then
   speak the bounded command. Observe actual activation, captured request,
   `AskArcanos.perform`, selected route, spoken dialog and system snippet.
5. Create a separate shortcut using **Check Latest Arcanos Job**. After a fixture
   acceptance, invoke this action later and verify the original operation result.

Record each dimension separately for unlocked and supported locked states:

| Dimension | Proof needed |
| --- | --- |
| Activation | Actual spoken phrase starts the intended Shortcut/App Intent |
| Capture | System obtains the spoken command through its parameter request |
| Intent | Actual shipping intent runs in the observed process |
| Route/inference | Actual route and provider selected, with required note present |
| Speech | Audible result from the system interaction |
| Visual result | Supported system snippet and truthful pending/completed state |
| Later invocation | Fresh status action restores the same operation |
| Confirmation | Actual system confirmation interaction for the frozen synthetic request |

For offline testing score activation, dictation, local inference and spoken
output separately. A supplied transcript/direct method call does not prove
spoken invocation. The temporary note is memory-only; if capture and ask execute
in different processes, report missing context instead of claiming shared note
storage. A locked intent may require unlock as designed:
[App Intent authentication policy](https://developer.apple.com/documentation/appintents/intentauthenticationpolicy/requireslocaldeviceauthentication).
Do not require an unsupported continuous conversation or bypass authentication.

## F: Physical recovery with controlled fixtures

Use the installed fixture configuration and the real shipping request/status
intents, app lifecycle, secure storage and file persistence. The CLI recovery
proof remains useful lower-level evidence and does not perform this scenario.

For each accepted-receipt run, record a named before/after evidence checkpoint.
The durable ledger retains earlier jobs; use counter deltas and explicit
operation references rather than deleting history. Keep the fixture completion
boundary pending until after receipt persistence has been observed:

1. Tap **Enable fixture Gateway** and invoke Ask Arcanos with **Run the hardware
   fixture operation**, the only accepted synthetic AI command. Record one
   intercepted submission, one new accepted ledger job, zero executions before
   completion, its operation reference and accepted fixture job identity.
2. Confirm the durable operation record contains that accepted receipt before
   ending the interaction. A verbal pending response alone is insufficient if
   persistence was unavailable.
3. Dismiss Siri and perform exactly one chosen lifecycle event from the table
   below. Record process identity/role and whether the process actually ended.
4. Relaunch or invoke Check Latest Arcanos Job. Confirm the same operation/job
   identities are restored. The first pending read must remain truthful.
5. Tap **Complete pending synthetic jobs**. This completes all pending synthetic
   ledger jobs once each, including any earlier unfinished scenario; account
   for each job when comparing total counters. Retrieve and validate the authoritative
   synthetic result through the existing result API projection. Restore the
   same operation again to confirm no new submission or execution.
6. Verify one synthetic execution for this job after explicit completion, and
   no later increase for this job. Compare final submissions with the receipt
   checkpoint; result reads may increase but accepted work must not be resubmitted.
   If multiple operations exist, supply the operation reference explicitly.

| Separate case | Lifecycle evidence required |
| --- | --- |
| Siri dismissal | System interaction ended; do not infer process termination |
| Background and foreground | App scene transition occurred; no forced termination claim |
| Explicit process termination | Identified app/intent host process stopped after receipt persistence |
| Cold app launch | New app process initialized and restored persisted receipt |
| Fresh status intent before host UI launch | Newly invoked intent reopened the same store, without opening the app first |

Use Xcode's debugger/process views or locally retained device diagnostics to
identify the actual execution host; App Intents are compiled into the host app,
but compilation topology is not runtime process evidence. A visible app swipe
does not prove all intent-related execution ended. If the OS will not provide
the desired lifecycle or same-container access, report that case BLOCKED with
the observed behavior. Never kill system Siri processes to manufacture a result.

Test lost receipt separately, using **Lose next receipt after synthetic acceptance**:
one synthetic execution may exist while the client lacks a job receipt. After
restart the same operation stays uncertain and recovery issues no mutation.
No automatic replay, new idempotency context, fabricated result or approval is
allowed. A local observation timeout is not remote failure. Dismissing Siri,
backgrounding, terminating the app or cancelling observation does not prove
remote cancellation.

## Confirmation and authentication regressions

Only synthetic capability replies are allowed here. The ordinary **Run tests**
intent command exercises the protected `tests.run` path without an executor.
`patch.apply` must remain protected; the current host does not provide a general
patch-entry flow, so preserve its package regression coverage and do not invent
a shell or remote patch capability to make hardware testing convenient.

For the real system confirmation interaction:

1. Send the original capability endpoint/action/payload without confirmation.
2. Fixture returns `CONFIRMATION_REQUIRED`; verify no execution has occurred.
3. Decline or dismiss the actual system prompt. Expect zero privileged retry.
4. Make a new request, approve that exact system prompt explicitly, and verify
   one retry with identical endpoint/action/payload and idempotency context.
   Only top-level `confirmation_token` may be added; its value is the raw
   challenge ID. Compare inside the fixture without writing the challenge.
5. Fail the retry or return a second challenge. Verify the client stops with no
   third request. Repeating approval must not execute again.
6. Repeat across restart and a fresh Approve Pending Arcanos Request invocation.
   Volatile approval must be gone; recovery must not replay a privileged retry.
   An unrelated or stale spoken **approve** does not grant authorization.

Set **Fixture approved-retry response** before each original request. After
synthetic expired/revoked/invalid responses, the production credential store may
correctly preserve a rejected state. Return **Fixture authentication response**
to `accepted` and explicitly replace the synthetic credential to start a new
authorized fixture case; switching the server response alone must not repair
client authentication. Preserve the failed-state evidence before replacement.

Record whether the system accepted a spoken answer, required a supported visual
control, cancelled, or required authentication. A tapped button proves that
interaction only; it does not establish spoken approval support.

Use synthetic expired/revoked/foreign-partition states and temporary credential
denial to verify fail-closed behavior. Verify exact-request binding remains
unchanged after status reads, foregrounding and repeated intent invocation.
Synthetic authentication rejection proves client response handling, not actual
server-side revocation/expiry. Inspect existing confirmation/security package
regressions rather than broadening grants or bypassing the coordinator.

## G: Separately authorized live milestone — do not execute now

Before any live action, obtain explicit authorization naming the test environment,
phone, scoped principal/workspace, allowed provider request, allowed read-only
Local Agent target, evidence access, bounded execution window and cleanup scope.
Do not use fixture credentials against a server. This section is preparation,
not permission; health/status requests and preview provisioning are also excluded.

Prerequisites: successful appropriate Apple/device checks, stable signed shipping
build with fixture selectors absent, an approved genuine HTTPS Gateway origin,
existing scoped-device pairing support, an isolated non-sensitive workspace,
provider/worker readiness established by the separately authorized operator,
and access to independent backend submission/execution evidence.

| Live step | Expected result and evidence |
| --- | --- |
| Pair phone through existing flow | Trusted operator creates a short-lived minimal-scope pairing challenge; phone consumes it; only scoped expiring device credential reaches Keychain |
| Verify HTTPS and origin | Normal shipping TLS accepts the intended certificate/origin and rejects a controlled invalid certificate/origin; no redirect or broad trust override |
| Submit one harmless provider task | Approved non-sensitive task creates one owned job; scoped phone credential authenticates it |
| Read owned job | Canonical result route returns only the paired principal/device's authorized job; controlled foreign ownership is denied |
| Recover accepted job after termination | Receipt is durably recorded, actual hosting process terminates, fresh app/intent restores the same operation/job and reads its result |
| Independently verify counts | Backend request/acceptance and provider/executor records establish actual submission attempts and semantic executions; client receipt alone is insufficient |
| Read-only Local Agent | One explicitly authorized `git.status` operation in the named isolated target returns its owned result without mutation |

Pairing must use the existing operator-side challenge creation and phone-side
one-use pairing flow. Never request, paste or place a master Gateway, operator,
backend or executor token on the phone. Minimal grants for this milestone cover
the required owned jobs and `git.status` only. `tests.run`, `patch.apply` or any
other privileged action requires separate explicit approval and an appropriate
isolated target; pairing or prior fixture approval does not authorize them.

Set a bounded observation window; preserve pending/uncertain outcomes and stop
without resubmitting when evidence is missing. Reconcile actual execution counts
from the authorized backend source. Record provider/executor acceptance, result
and lifecycle evidence independently of synthetic fixture success.

Safe cleanup is limited to the approved test pairing, records and artifacts.
Authorized server revocation and local credential removal are different actions;
local forget does not revoke a server credential. Stop only fixture processes
owned by this run. Preserve evidence and unrelated apps/stores/settings. If a
cleanup control rejects an action, record the exact blocked path/action and
reason, retain it outside commits/packaging, and do not work around the control.

## Milestone handoff

Report these separately after each run, with supporting evidence records:

- Phase 3C validation tooling prepared.
- Apple-platform build/runtime validated: A and B independently.
- Physical-device local AI and Keychain validated: C and D independently.
- Physical-device voice/recovery validated with fixtures: E and F independently.
- Live-service validation outstanding: G remains NOT RUN until separately
  authorized and actually executed.

The next operator action is to use either an authorized local Mac or the
[no-Mac cloud path](PHASE3C_CLOUD_RUNBOOK.md), verify the current fixture scheme
and build settings, and obtain actual Apple build/runtime evidence before
installing only the isolated fixture configuration. The cloud path requires
authorized workflow publication and separately protected TestFlight upload;
unpublished code cannot be tested by an existing remote workflow. Hardware or
live gaps prevent a claim that Phase 3C is fully complete.
