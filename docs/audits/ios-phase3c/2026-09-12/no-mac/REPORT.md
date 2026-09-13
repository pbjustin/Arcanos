# Phase 3C no-Mac pipeline engineering report

2026-09-12 UTC / 2026-09-11 America/New_York. The no-Mac build and distribution
tooling is implemented and locally validated. Cloud execution, signing,
TestFlight delivery and physical-phone evidence remain separate outstanding
milestones. No live ARCANOS service was contacted during this implementation.

## Baseline, scope and revision

- Worktree: `C:\pbjustin\Arcanos-ios-phase3c`, branch
  `codex/ios-phase3c-validation`.
- Inspected HEAD/base and current remote `main` (read-only `git ls-remote`):
  `4f3652ed4397e8b7de8891696ea6160d4cd51af2`, the PR #1499 merge.
- Historical `8b24d2b5` is not the merge commit. Local `main` in another checkout
  remains at `128107bc0e1474c29bc200962bc3838d14ed02ac`; it was left untouched.
- The existing Phase 3C overlay was uncommitted at entry: 11 modified tracked
  files and 26 untracked files. Applicable root instructions, validation skill,
  setup, Xcode project, workflows, Phase 3B report and both existing Phase 3C
  evidence/runbook layers were inspected. No nested override applied.
- The latest request authorizes a focused local commit after validation. The
  tested source is the base plus the manifest-recorded overlay; the resulting
  local commit is identified in the final handoff, not fabricated inside this
  pre-commit report. The pre-commit reports' base SHA alone is not the new code.
- No push, PR, merge, remote workflow dispatch, Apple upload, backend deployment,
  production configuration change or credential rotation was performed.

Source and command provenance are in [the portable summary](../no-mac-portable/summary.json),
[Apple preflight](apple-preflight.json), [local checks](local-checks.json), and
the accompanying `source-manifest.json`. The new manifest records all relevant
files, including workflow, icon, signing and documentation changes, before commit.

## Environment and project facts

Execution host: Windows 10.0.26200.0 with WSL Ubuntu-24.04, Linux Swift 6.2.4
(`x86_64-unknown-linux-gnu`), Node 24.18.1/npm 11.16.0 and Windows Python 3.11.7.
No Mac, Xcode, iOS SDK, Simulator, signing identity or authorized iPhone is
accessible in this session. No device model, OS build or private identifier was
collected, and no Apple-only result is inferred from Linux.

The actual target remains `ArcanosVoice` in
`clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj`. Its local dependency is
`../ArcanosKit`; there is no new package provider or remote dependency. Shipping
Debug/Release and the existing HardwareValidation configuration retain iOS 18.0,
Swift 6 and complete strict concurrency. Foundation Models remains guarded for
the existing iOS 26 supported/ready model requirement. No entitlement, App Group,
background listener, new provider or recovery engine was added.

The repository already has an active `ios-client.yml` macOS job. It remains
unchanged, including the recovery, contract and preview-dry-run regressions.
The new workflow reuses its deliberate `macos-15` / Xcode 26.3 selection.
The inspected [official runner manifest](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md)
lists Xcode 26.3 build 17C529 and iOS SDK/Simulator 26.2. The helper verifies the
actual runner inventory and rejects a missing/mismatched toolchain. Manifest
availability is preparation evidence, not execution on that runner.

## Changes and narrowly scoped findings

| Area | Files / resulting behavior |
| --- | --- |
| Cloud Apple validation | `.github/workflows/ios-phase3c.yml`, expanded `run-phase3c-apple-validation.py`: secretless PR/manual/reusable workflow; exact Xcode/SDK checks, local package resolution, Apple Swift tests, actual Debug/Release/HardwareValidation Simulator builds and bundle isolation checks |
| Simulator execution | `run-phase3c-simulator.py`, `SimulatorRecoveryDriver.swift`, guarded call from `ArcanosVoiceApp.swift`: dedicated Simulator, readiness synchronization, installed host app, observed process exits/relaunches, same accepted operation/job, authoritative fixture completion and repeated restoration |
| Archive/export/upload preparation | `.github/workflows/ios-hardware-distribution.yml`, `phase3c_signing.py`: protected main/manual/exact-SHA admission, successful unsigned validation prerequisite, isolated manual signing, archive/export validation, separately authorized upload mode |
| Evidence | `phase3c_cloud_report.py`: explicit A-K mapping; missing, incomplete or mismatched reports cannot establish PASS; physical/live results are never promoted from Simulator evidence |
| Packaging | Hardware scheme now permits archiving; project includes the Simulator driver and a distinct opaque 1024px validation icon. Ordinary Debug/Release exclude both driver and validation catalog. `generate-validation-icon.py` reproduces/checks the original asset without external art. |
| Tests | Expanded `test_hardware_configuration.py`; new cloud configuration, cloud report, signing and Simulator regression suites |
| Documentation | `PHASE3C_CLOUD_RUNBOOK.md`, narrow iOS README/device-runbook updates, this report and sanitized evidence; all four generated code indexes refreshed |

The scheme's previous `buildForArchiving=NO` and missing app icon were concrete
distribution blockers found by inspection. Both are fixed. The Apple helper
also previously classified a failed package-test execution as BLOCKED; it now
records FAIL. No Apple-runtime defect was observed or claimed to be fixed.
The existing production `ArcanosKit` session, routing, auth and recovery code
was reused without source modification.

## Isolation and Simulator proof design

The validation macro selects its composition before ordinary preferences or
credential restoration. The fixed bundle `org.arcanos.voice.hardware-validation`,
isolated Keychain service and `ArcanosHardwareValidation-v1` persistence partition
remain in place. UI/results visibly identify HardwareValidation. Fixture
requests enter the existing transport boundary and never open sockets or resolve
the logical `.invalid` fixture origin. Failure cannot select a live transport.
Normal shipping TLS, origin validation, authentication, ownership, confirmation
and idempotency rules remain unchanged.

The new Simulator driver is compiled only with both the validation macro and
`targetEnvironment(simulator)`, then requires explicit CI launch arguments. It
is absent from physical archives and ordinary builds. It invokes the installed
app's existing `AppRuntime.ask`, `activate` and `checkLatestJob` paths, using the
shipping session/recovery and synthetic credentials in Simulator Keychain.
It does not substitute a demonstration session or drive App Intents directly.

The controller seeds a synthetic forbidden `.invalid` production preference,
requires evidence that it was ignored, submits one accepted fixture operation,
observes host PID termination, launches a fresh host process, checks the same
operation/job, explicitly completes the fixture and repeats restoration. It
rejects duplicate counts, stale/mismatched proof, incorrect identities/results,
missing authoritative reads and unobserved termination. Its injected transport
has zero HTTP by construction; intercepted submissions and semantic executions
remain separate counters. No Simulator is erased or deleted; persistent-host
artifacts remain for approved operator cleanup.

## Signing, artifacts and TestFlight state

No external commercial CI provider was necessary. Scripts invoke standard Xcode,
Security, codesign and Apple Transporter tools; GitHub supplies the disposable Mac
and approval/secret controls. The signing workflow is dispatch-only on protected
`main`, requires an exact reviewed SHA, and cannot inherit secrets through the
reusable unsigned workflow. Fork/untrusted PR jobs have no signing environment.

Required protected environment secret references, never values:

| Reference | Purpose |
| --- | --- |
| `IOS_SIGNING_P12_BASE64` | Apple Distribution certificate plus its private key in an encrypted PKCS#12 container |
| `IOS_SIGNING_P12_PASSWORD` | Unlock the imported container |
| `IOS_PROVISIONING_PROFILE_BASE64` | App Store distribution profile for the exact fixture bundle |
| `IOS_TEAM_ID` | Match the profile, certificate and signing team |
| `ASC_KEY_ID` | Identify the upload API key; TestFlight environment only |
| `ASC_ISSUER_ID` | Identify the App Store Connect API issuer; TestFlight environment only |
| `ASC_PRIVATE_KEY_BASE64` | Upload API private key; TestFlight environment only |

Protected variable `IOS_USES_NON_EXEMPT_ENCRYPTION` is supplied only after owner
export-compliance review; no exemption is assumed. `ios-hardware-signing` is for
archive/export, and `ios-hardware-testflight` independently gates publication.
Configure required reviewers, no self-approval/admin bypass and main-only branches
before adding secrets. A workflow `environment` declaration does not establish
those protections. Read-only repository metadata showed no matching iOS/Apple/
TestFlight environments configured during inspection.

Signing checks a clean exact revision, exact fixture App ID, unexpired App Store
profile, matching certificate, signed entitlements, embedded profile equality,
icon, deployment target, build number, archive/export signature and source
stability. Missing signing material returns **SIGNING NOT RUN**. Raw signing
commands/output are not serialized. Only sanitized signing metadata is uploaded
as a workflow artifact: signed IPA/archive products embed provisioning material
and stay on the disposable runner. Future upload rebuilds and signs the same
reviewed SHA inside its separate protected job, then sends that artifact directly
to Apple after explicit authorization. Apple processing and tester availability
remain separate from Transporter acceptance.

No Apple keys, certificates, provisioning profiles or account passwords were
requested, generated or imported in this task. No TestFlight upload was attempted.
The [cloud runbook](../../../../../clients/ios/PHASE3C_CLOUD_RUNBOOK.md) supplies
the no-Mac Windows/WSL CSR/P12 preparation sequence, portal setup, secret interfaces,
App Store Connect record and internal-tester checklist. Account membership,
bundle reservation, credentials and export-compliance answers remain operator
dependencies; private keys/passwords must never be pasted into chat.

## Validation actually run

| Check | Observed result | Status |
| --- | --- | --- |
| Existing Swift package suite | 18 XCTest + 150 Swift Testing cases, zero failures | PASS |
| Portable Debug and Release builds | Linux Swift 6.2.4, both exit 0 | PASS |
| Shipping process/loopback proof | 21 primary processes; primary accepted scenario one HTTP submission/one synthetic execution; original operation/job retained | PASS |
| Core process/loopback proof | 11 processes, seven HTTP requests, three creates across separate scenarios; corrupt-result negative control rejected | PASS |
| Confirmation and uncertain receipt regressions | Existing fixture suites/proofs retain exact retry/idempotency and do not replay lost receipts or restore approval | PASS |
| Python tooling regressions | 57 tests, zero failures on corrected credential-free Windows harness | PASS |
| Hardware source/configuration guard | Actual project, macro selection, shipping exclusions, bundle/storage/TLS checks | PASS |
| Gateway contract drift | 22 schemas and ten operations match, using installed TypeScript compiler without backend import | PASS |
| Workflow YAML and icon | Both workflow structures parse; generated opaque icon matches source | PASS |
| Documentation/index drift | 573 checks, zero warnings; all indexes current | PASS |
| Tracked local links | 411 targets initially, 422 after adding the new runbooks to the index; external URL checks skipped | PASS |
| Commit guard / sync / whitespace | Guard passed; sync zero errors/warnings and five existing informational suggestions; staged diff has no whitespace errors | PASS |
| Syntax/runtime portable checks | Existing Linux syntax and runtime-stub typechecks passed; Apple code/SDK behavior not established | PASS |
| Apple build preflight | Exit 2: Mac/Xcode unavailable; no build started | BLOCKED |
| Simulator preflight | Exit 2: macOS/Xcode/runtime unavailable; no app launched | BLOCKED |
| Signing preflight | Missing CI secrets; SIGNING NOT RUN; zero signing subprocesses | NOT RUN |

The first isolated Python harness attempt omitted Windows' uppercase
`SYSTEMROOT`, causing WinError 10106 and import failures. That failed attempt is
retained in `local-checks.json` and the ignored raw log. Only the ad hoc harness
allowlist was corrected; the unchanged repository tests then passed. The new
cloud runbook had one incorrect local anchor, found and corrected during final
link review. Neither finding was a shipping runtime defect.

The portable proof counts above do not establish installed-app, Siri or physical
device success. Exact details are in [shipping proof](../no-mac-portable/shipping-proof.json)
and [core proof](../no-mac-portable/core-proof.json). A CLI-supplied intent phrase
is not spoken system invocation. Historical preview evidence was neither rerun
nor used as evidence of live behavior here.

## Independent A-K matrix

All rows apply to the base plus the hashed implementation overlay. The configured
future runner is macOS 15/Xcode 26.3/iOS SDK and Simulator 26.2; those versions
were not executed here. See [machine-readable matrix](cloud-summary.json).

| Level | Status | Observation / dependency |
| --- | --- | --- |
| A. Cloud Xcode/iOS compilation | BLOCKED | New workflow is local only; publication is not authorized. No accessible Apple compiler. |
| B. Cloud Simulator build | BLOCKED | Same unpublished workflow dependency; Linux build is not a Simulator build. |
| C. Cloud Simulator runtime | BLOCKED | No available Simulator; controller preflight exited before installation/launch. |
| D. Signed archive | NOT RUN | Apple account/profile/certificate and protected environment setup required. |
| E. TestFlight upload | NOT RUN | Explicit publication approval and protected App Store Connect credentials required. |
| F. Physical Keychain | BLOCKED | Installable authorized fixture build and actual phone observations required. |
| G. Physical Foundation Models | BLOCKED | Supported phone, ready model and actual local-only inference required. |
| H. Physical App Intent | BLOCKED | Actual installed intent/system invocation required. |
| I. Physical Vocal Shortcut | BLOCKED | Owner setup and spoken Hey Arcanos activation/capture/response required. |
| J. Physical fixture recovery | BLOCKED | Actual phone lifecycle, original operation/job and execution counts required. |
| K. Live ARCANOS services | NOT RUN | Explicitly outside scope; fixture success grants no live authority. |

## Concrete handoff

1. After separate authorization to publish the reviewed local commit, run
   **iOS Phase 3C Apple Validation** (`ios-phase3c.yml`) on that revision. Review
   `cloud-summary.json` and scoped reports for A/B/C. First cloud execution may
   reveal Apple-only defects; do not skip or soften failed checks.
2. Complete Apple Developer/App Store Connect and protected-environment setup
   from the cloud runbook using provider secret interfaces. Once the reviewed
   workflow is on protected `main`, invoke **iOS Hardware Validation Distribution**
   (`ios-hardware-distribution.yml`) with `expected_sha` equal to that commit,
   a new `build_number`, `mode=archive`, `authorize_upload=false`.
3. Only after explicit TestFlight publication authorization, invoke the same
   protected workflow with `mode=upload`, `authorize_upload=true`, the exact
   reviewed SHA and a new build number. Approve its separate TestFlight environment.
   Review Apple processing/export-compliance state and assign the internal tester.
4. On the iPhone, install the fixture build through TestFlight and verify its
   visible mode/revision. Explicitly initialize synthetic Keychain material;
   perform read/replace/relaunch/reboot-unlock/delete and partition checks.
5. Capture the known synthetic note and request **Summarize this note** through
   the actual local provider. Repeat in local-only mode with normal networking
   disabled after model setup; score inference separately from dictation/speech.
6. Create the installed fixture app's **Ask Arcanos** Shortcut, leave Command
   unset, verify manual invocation, then let the owner configure **Hey Arcanos**
   through supported Vocal Shortcuts. Record actual activation, capture, intent,
   routing, speech and supported visual result separately.
7. Enable fixture Gateway, invoke **Run the hardware fixture operation** through
   that intent, save the accepted operation/job checkpoint, end the interaction,
   perform a named lifecycle transition, invoke **Check Latest Arcanos Job**,
   complete the fixture and require the same operation/job with one accepted
   submission and one semantic execution. Repeat restoration and the separate
   confirmation/lost-receipt cases. Do not infer process death solely from closing
   Siri or dismissing a visible app.

Detailed setup and evidence tables are in the maintained cloud/device runbooks.
The next action is authorization to publish the local workflow revision for
unsigned cloud validation. Purchasing a Mac is not a prerequisite for this
prepared route. Live pairing/Gateway/provider/executor validation remains a
later separately authorized milestone using the shipping paired-device flow.
