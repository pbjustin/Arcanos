# Phase 3C preparation and isolated validation evidence

Captured 2026-09-12 UTC (2026-09-11 local operator date). This is a dated,
sanitized engineering snapshot, not deployment authority or a statement that
Phase 3C is complete. The maintained procedure is the
[device runbook](../../../../clients/ios/PHASE3C_DEVICE_RUNBOOK.md).

## Baseline and environment

Read-only GitHub metadata confirmed PR #1499 merged at
`4f3652ed4397e8b7de8891696ea6160d4cd51af2`; current remote main matched that SHA.
Its final PR head was `8b24d2b559ce56352cc0bc9c543edfecb64da4e4`, not the merge
commit. A new worktree `C:/pbjustin/Arcanos-ios-phase3c` on
`codex/ios-phase3c-validation` started clean at the merge. The older primary
checkout at `128107bc0e1474c29bc200962bc3838d14ed02ac` had unrelated tracked and
untracked changes; none was reset, stashed, or discarded.

The accessible host is Windows NT 10.0.26200.0 with Ubuntu 24.04.4 in WSL.
Windows PATH has no Swift, Xcode, or xcrun. Cached Linux Swift 6.2.4 targets
`x86_64-unknown-linux-gnu`. The installed canonical Node 24.18.1/npm 11.16.0
was selected instead of Windows PATH Node 24.13.0/npm 11.6.2. Python versions
are Windows 3.11 and WSL 3.12.3. No Mac, iOS SDK, Simulator runtime, signing
identity, or authorized physical iPhone is exposed to this session. Phone model,
OS/build and model eligibility remain unverified; no device identifier was read.

Inspected root instructions and validation/worktree guidance, iOS README,
Phase 2/3/3B reports and physical runbooks, source/callers/tests, package/project,
privacy resource, and iOS CI workflow. The actual target is `ArcanosVoice`,
minimum iOS 18.0, Swift 6 strict concurrency, automatic signing without a saved
Team, one local ArcanosKit package, and five App Intents in the application.
No extension, App Group, Keychain sharing group or custom entitlement was added.
Foundation Models remains guarded by SDK import and iOS 26 runtime availability.

## Implementation and findings

The existing startup restores saved Gateway preferences and polls through the
shipping recovery composition on activation. Debug demonstration uses a different
in-memory session, so it cannot safely establish isolated shipping recovery.
The missing tooling is an explicit hardware configuration of the same target:

- `HardwareValidation` / `ArcanosVoice-HardwareValidation` selects a different
  bundle, Keychain service and Application Support partition before restoration.
  Live pairing, saved Gateway restoration and demo switching are excluded in
  that build. Ordinary Debug and Release exclude all hardware fixture sources.
- `HardwareFixtureTransport` has no network implementation. It records durable
  synthetic acceptance/completion, intercepted requests and actual process IDs,
  rejects unknown requests, and keeps approval challenges memory-only. The
  production session/router/recovery/credential clients remain in the path.
- Explicit app controls initialize, compare, replace and delete synthetic
  Keychain records. A saved digest expectation lets a read-only probe compare
  identity and credential bytes after relaunch/reboot. No automatic replacement,
  pairing or identity creation occurs on startup or secure-storage failure.
- The real LocalAI provider is observed without substitution. Model availability
  reasons and finite attempts/success/error counts are visible. The local-only
  transport rejects and counts fallback attempts; a blocked fallback is not
  successful inference. All snippets identify the fixture build.
- Local inspection/build and configuration/packaging validators, focused
  regressions, a reusable portable runner and the physical/live runbook supply
  reproducible next steps. No shipping recovery, auth, routing, TLS or ATS
  algorithm was replaced, and no production defect is claimed from unavailable
  Apple execution.

## Independent milestones

| Milestone | Status | Evidence boundary |
| --- | --- | --- |
| Phase 3C validation tooling prepared | PASS | Local implementation and portable/static checks; Apple compilation remains separate |
| A: Apple-platform compilation | BLOCKED | No accessible Mac/Xcode/iOS SDK; historical CI is not this uncommitted overlay |
| B: Simulator runtime execution | BLOCKED | No accessible Apple Simulator runtime |
| C: Physical system Keychain | BLOCKED | Authorized phone, signing and actual lock/reboot observations required |
| D: Physical Foundation Models | BLOCKED | Supported authorized hardware and ready model required |
| E: Physical voice/App Intent | BLOCKED | Actual spoken activation, dictation, confirmation, audio and visual observations required |
| F: Physical recovery with fixtures | BLOCKED | Installed app and corroborated process/lifecycle events required |
| G: Live pairing/Gateway/provider/executor | NOT RUN | Outside this task's authorization |

Thus Apple build/runtime validation, physical local AI/Keychain validation and
physical voice/recovery validation are independently blocked. Live-service
validation remains outstanding. No whole-phase completion claim is made.

## Executed checks and retained artifacts

| Check | Result | Scope and artifact |
| --- | --- | --- |
| Baseline package provenance | PASS | 52 original package files matched merge blobs, permitting checkout line endings; [provenance](portable-baseline/baseline-provenance.json) |
| Baseline debug/release builds and tests | PASS | Swift 6.2.4/Linux; 18 XCTest plus 136 Swift Testing tests; [baseline manifest](portable-baseline/summary.json) |
| Existing shipping/core recovery proofs | PASS | Separate Linux processes and loopback HTTP; duplicate/lost-receipt/confirmation/corrupt-result controls; [shipping proof](portable-baseline/shipping-proof.json), [core proof](portable-baseline/core-proof.json) |
| Final package debug/release builds | PASS | New fixture target builds; [build manifest](portable-final-2/summary.json) |
| Final Swift tests | PASS | 18 XCTest plus 150 Swift Testing tests = 168; includes 14 hardware fixture test functions with parameterized cases; [final follow-up](portable-final-followup/summary.json) |
| App source parsing and ordinary/hardware runtime typechecks | PASS | Linux Swift 6 only; actual value types/composition, no SwiftUI/AppIntents/Apple API resolution; final follow-up manifest |
| Configuration gate and Python regressions | PASS | 10 Python test methods; parsed source/config and synthetic bundle negative cases, no real built app; [configuration evidence](configuration-validation/summary.json) |
| Apple preflight requested with `--build` | BLOCKED | Exit 2: no Mac/Xcode; no build or launch occurred; [preflight](apple-preflight.json) |
| Documentation/index check | PASS | Node 24.18.1/npm 11.16.0; 572 documentation assertions and current generated indexes |
| Local documentation links | PASS | 410 local targets; 33 external URLs discovered and explicitly not requested |
| Diff whitespace, new Python syntax and new-document targets | PASS | Local checks; untracked additions checked independently of tracked-only documentation audit |
| PostgreSQL, root backend build/Jest, remote CI, preview and live E2E | NOT RUN | No backend/protocol change; live environments/workflows not authorized |

The baseline shipping proof reported 21 primary processes, 19 HTTP requests and
three operations; its accepted-receipt scenario retained one submission and one
synthetic semantic execution through restoration. Approval and negative controls
are separately enumerated in its log. The core proof reported 11 primary
processes/seven requests and rejected its corrupt-completion negative control.
These are CLI composition/process proofs, not the installed app/Siri lifecycle.

One intermediate runner setup failed because resolving the Swift executable
symlink changed `argv[0]` to `swift-driver`; the runner now preserves `swift`.
[That failed attempt](portable-final/summary.json) remains separate from the
passing runs. Linux Git also initially reported a Windows LFS ZIP as dirty;
authoritative Windows Git and blob comparison resolved that diagnostic artifact.
Verbose Swift Testing emitted synthetic token arguments: retained audit logs
were sanitized, and both new runners redact credential/challenge values before
saving output, including a portable timeout's partial output. No real secrets
were accessed. The final log-sanitization-only runner adjustment was syntax
checked; passing Swift results concern unchanged Swift source.

The four generated backend/CLI index files were regenerated together because
four new Python tooling/test files entered the source inventory. Backend entries
did not change beyond the generated timestamp. The source overlay and final
git status are captured in [final manifest](final-manifest.json). Checks record
their own earlier exact file hashes; later documentation/report or runner-only
changes do not imply those commands revalidated different application code.

New files include the hardware fixture transport/tests, hardware runtime/view,
shared hardware scheme, device runbook, two validation runners, configuration
validator/tests, and this evidence set. Modified files are `Package.swift`,
`project.pbxproj`, `AppRuntime.swift`, `ArcanosIntents.swift`, `SettingsView.swift`,
`VoiceSnippet.swift`, the iOS README and the four generated index files. All
changes remain unstaged and uncommitted on `codex/ios-phase3c-validation`.

## Scope and operator handoff

Portable credentials, local inference, Gateway responses and capability effects
are fixtures. Baseline process proofs use actual loopback HTTP; the new app
transport has zero HTTP requests by construction. Neither proves genuine TLS,
server credential acceptance, provider execution, Siri or system-wide offline
traffic. The raw Keychain and Foundation Models branches cannot execute on Linux.

All live checks are NOT RUN, including health/status endpoints, Railway
production/preview, pairing, provider requests, Local Agents and notifications.
No infrastructure/workflow was provisioned or triggered; no stage, commit, push,
PR, merge, deployment, TestFlight upload, credential rotation or production
configuration change occurred. The runbook's live milestone requires separate
authorization through the scoped-device pairing flow, never a master-token field.

Next operator action: bring this uncommitted overlay plus its source manifest to
an authorized Mac; run the Apple helper with `--build` into a fresh local
evidence directory. Inspect the HardwareValidation bundle and sign/install that
configuration on the authorized phone. Initialize only the synthetic credential
and run its read-only probe before the physical lifecycle/model/voice cases.
Do not launch the ordinary paired shipping configuration during this fixture task.

Retain local build/test artifacts and evidence until their applicable cleanup
approval is satisfied. No cleanup policy bypass was used. Existing bounded
loopback fixtures reported their own normal cleanup; new hardware fixture tests
retain their temporary synthetic files. Failed/intermediate validation evidence
is retained and labeled, not treated as successful Apple or hardware proof.
