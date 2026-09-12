# Phase 3C physical-validation attempt

Date: 2026-09-12 UTC (2026-09-11 America/New_York). The requested physical
acceptance criterion remains **BLOCKED**. This session exposes Windows/WSL,
with no accessible Mac, Xcode, Simulator, signing environment or authorized
iPhone. No iOS app was built, installed or launched during this attempt.

## Revision and scope

- Worktree: `C:\pbjustin\Arcanos-ios-phase3c`.
- Branch: `codex/ios-phase3c-validation`.
- HEAD and merged Phase 3B base:
  `4f3652ed4397e8b7de8891696ea6160d4cd51af2` (PR #1499 merge).
- Historical checkpoint `8b24d2b5` is an ancestor, not the current merge base.
- Phase 3C remains an uncommitted overlay. All 21 source, guide and generated
  index hashes match the [previous manifest](../final-manifest.json). The
  [new inspection](inspection.json) records these hashes, toolchain facts and
  the pre-evidence working-tree inventory. The [Apple preflight](apple-preflight.json)
  also records the broader iOS source manifest and unchanged-source check.
- Hardware-tested commit: none. Portable checks refer to this base plus the
  explicitly hashed overlay; they are not tests of the base commit alone.
- No source edits or targeted fixes were necessary in this attempt. Inspection
  and an independent source review found no new demonstrated defect. Apple
  runtime defects remain unassessed because the runtime is unavailable.
- No commit was made: the request's final no-commit restriction was retained,
  and no hardware test could begin. No staging, push, PR, merge, deployment,
  remote workflow, backend request, cleanup or production change was performed.

Root `AGENTS.md`, the repository validation skill, iOS setup documentation,
Phase 3B/3C engineering evidence and the existing
[device/live runbook](../../../../../clients/ios/PHASE3C_DEVICE_RUNBOOK.md)
were reviewed. Existing work and prior evidence were preserved.

## Available environment and actual project

| Item | Observed value |
| --- | --- |
| Host | Windows NT 10.0.26200.0, AMD64 |
| Linux environment | WSL Ubuntu-24.04; Ubuntu also registered |
| Available Swift | Swift 6.2.4, `x86_64-unknown-linux-gnu`, cached WSL toolchain |
| Node / npm / Python | 24.18.1 / 11.16.0 / 3.11.7 |
| Xcode / Apple Swift / iOS SDK | Unavailable to this session |
| Simulator runtimes | None accessible; not an inventory of an unseen Mac |
| Signing identities | Not inspectable without the Mac |
| Physical iPhone | None available to this session; Windows Apple mobile inventory returned zero matches |
| Device model / iOS version or build | Unobserved; no private device identifiers collected |
| Xcode project | `clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj` |
| Actual application target | `ArcanosVoice` |
| Shipping scheme / configurations | `ArcanosVoice`, Debug and Release |
| Fixture scheme / configuration | `ArcanosVoice-HardwareValidation`, HardwareValidation |
| Minimum deployment target | iOS 18.0, unchanged |
| Language settings | Swift 6; complete strict concurrency |
| Local provider runtime requirement | Existing Foundation Models path requires iOS 26 and supported, ready hardware/model; minimum app OS remains 18.0 |
| Signing configuration | Automatic signing; development team must be selected on the authorized Mac |
| Packaging/security source facts | One application target, existing App Intents, privacy manifest; no added extension, App Group or Keychain-sharing entitlement |

The source availability guards and authentication policies were inspected. Their
compilation, registration and runtime behavior have not been checked with an
installed Apple SDK. No claim is made that a particular phone is model-capable.
Only local Windows projects were exposed by the app inventory; no Mac connection
was discovered or attempted. An access-method question was sent to the operator.

## Isolation verification

**PASS for source/configuration checks only.** HardwareValidation selects its
composition before loading ordinary preferences, restoring credentials or
starting recovery. It uses the shipping session, routing, recovery and intent
paths with a durable injected fixture transport. The hardware branch does not
construct the live pairing client or restore against a live origin.

- Separate app identifier: `org.arcanos.voice.hardware-validation`.
- Separate credential service:
  `org.arcanos.voice.hardware-validation.credentials.v1`.
- Separate persistence root: `Application Support/ArcanosHardwareValidation-v1`.
- Logical fixture origin: `https://arcanos-hardware-fixture.invalid`; the adapter
  handles requests in process and never resolves or opens a connection to it.
- Local-only is the initial mode; enabling fixture Gateway behavior is explicit.
  Unknown requests and injected failures cannot select a real transport.
- Hardware diagnostics/snippets visibly identify fixture mode. Actual visibility
  on an installed app is still blocked.
- The three hardware-only Swift source files are excluded from ordinary Debug
  and Release builds by project configuration; the shipping library does not
  depend on the fixture-support target. Built-bundle inspection is still blocked.
- Normal TLS, origin checks, ATS and Keychain accessibility are unchanged. No
  trust override, networking exception, real credential read or fallback URL
  was introduced.

No local HTTPS server or device trust installation is needed for this injected
adapter. Its request count is an intercepted-transport count, not an HTTP count.
The earlier CLI loopback proofs used a different transport and do not establish
installed-app lifecycle behavior.

## Fresh validation actions

All checks below use the inspected base plus the unchanged Phase 3C overlay on
the Windows/WSL host above, with no live service components.

| Check and action | Expected / observed result | Status |
| --- | --- | --- |
| Git state and SHA-256 comparison against previous manifest | 21 hashes still match; no source drift | PASS |
| `python -B -m unittest discover -s clients/ios/scripts -p test_hardware_configuration.py` | 10 configuration regression tests succeed; 10 passed | PASS |
| Hardware source/configuration gate, invoked by Apple helper | Reject live restoration/fallback and configuration leakage; gate passed | PASS |
| `python -B clients/ios/scripts/run-phase3c-apple-validation.py --build --output-dir local_artifacts/ios-phase3c/physical-execution-recheck` | Requires Mac/Xcode for actual build; exited 2 with explicit dependency block before build or launch | BLOCKED |
| Local Windows Apple mobile inventory | Identify available phone without publishing identifiers; successful inventory query returned zero matches | PASS |
| `npm run docs:check` with pinned Node/npm | Documentation and generated indexes current; 572 checks passed, zero warnings | PASS |
| `npm run docs:links -- --local-only` | 410 local targets passed; all external requests skipped | PASS |
| Separate local check of this untracked audit report | All 6 links and anchors passed after the anchor correction | PASS |
| Evidence review and bounded secret-pattern scan | Three new files reviewed; zero candidate secret-pattern matches | PASS |
| `git diff --check` | No whitespace errors; only existing Windows line-ending notices | PASS |

The initial `npm run docs:links` invocation inadvertently used the script's
external-network default: 410 local targets and 33 external URLs passed. This
was broader network access than intended for this validation. A subsequent
offline extraction of its complete target list found public documentation,
GitHub and Codecov links only, with no Gateway, Railway environment, provider
API, Local Agent or notification endpoint among the targets. Public Railway
and OpenAI documentation links were included. The checker did not retain a
redirect trace, so the target inventory is not a packet-level network audit.
No credentials were supplied. Further link validation uses `--local-only`.
This command mistake is preserved here instead of describing the whole attempt
as network-free. The new report's separate local-link check found one incorrect
anchor; it was corrected without changing implementation code.

The helper's original sanitized logs are retained under ignored
`local_artifacts/ios-phase3c/physical-execution-recheck`; the copied preflight JSON
references log names in that original directory. Build products and raw device
logs were not created. The previous 168 Swift tests, Debug/Release portable
builds and two loopback recovery proofs are [historical portable evidence](../README.md),
not fresh executions in this attempt. They were not rerun because the tested
source hashes still match and they cannot resolve the missing Apple dependency.

## Independent validation matrix

Every row refers to base `4f3652ed4397e8b7de8891696ea6160d4cd51af2` plus the
hashed uncommitted overlay. No physical device/OS or Apple SDK was available;
the intended configuration and component boundaries are listed explicitly.

| Level | Status | Configuration / real versus fixture | Action, observed result and dependency |
| --- | --- | --- | --- |
| A. Xcode/iOS SDK compilation | BLOCKED | Actual ArcanosVoice target; Debug, Release and HardwareValidation | Build helper invoked, exited 2 before compilation; needs Mac, stable compatible Xcode and iOS SDK. Package resolution, Apple tests, concurrency, App Intents, Keychain API and built-resource checks remain unexecuted. |
| B. Simulator runtime | BLOCKED | Installed shipping composition in HardwareValidation; injected Gateway; model availability reported truthfully | No Simulator available; app initialization, launch, restoration and supported intent invocation unobserved. Unsigned builds would not prove this row. |
| C. Physical Keychain | BLOCKED | Real CredentialStore/system Keychain; synthetic material and isolated namespace | Needs signed app and authorized iPhone. Write/read/replace/delete, relaunch/reboot persistence, partition handling and temporary-unavailability behavior unobserved. |
| D. Physical Foundation Models | BLOCKED | Actual LocalAI/Foundation Models provider; local-only task | Needs supported iPhone, ready model and compatible OS. Availability reason, provider selection, semantic result and offline repeat unobserved. No fixture model substituted. |
| E. Physical App Intent/voice | BLOCKED | Shipping intents and actual Siri/Shortcuts/Vocal Shortcuts; synthetic task | No phone or system interaction. Activation, capture, route, speech, visual result, later invocation, locked states and spoken confirmation unobserved. |
| F. Physical fixture recovery | BLOCKED | Installed shipping session/recovery/intent composition, real persistence/Keychain, durable injected Gateway | No process was launched or terminated. Receipt persistence, identity restoration, authoritative completion and no-duplicate behavior remain unobserved on hardware. |
| G. Live-service validation | NOT RUN | Future shipping pairing, HTTPS, provider, owned jobs and authorized read-only executor | Explicitly excluded. No Gateway health/status, Railway, provider, Local Agent or notification request. Separate authorization required. |

## Physical findings and safety regressions

There are no new real Keychain, Foundation Models, Siri/App Intent or recovery
findings. The Keychain namespace/accessibility, local-only transport guard and
fixture boundaries passed static inspection; this does not prove system behavior.
Server-side credential acceptance, expiry and revocation are **NOT RUN**.

Physical submission attempts, intercepted attempts, accepted submissions,
semantic executions, operation ID, job ID, restored status/result and lifecycle
transition are **unobserved**, stored as null in `inspection.json`. They must not
be reported as zero-duplicate proof. No voice interaction ended, app backgrounded,
process terminated, cold launch occurred, device rebooted, network toggled or
secure-storage availability transition was induced by this attempt.

Confirmation and lost-receipt physical checks are **BLOCKED**. The prior portable
regressions remain applicable only at their recorded scope. Inspection found no
change to explicit request-specific approval, the one exact retry with only a
top-level confirmation token, retained idempotency context, stop-on-second-challenge
behavior, or conservative uncertain-without-replay policy. No live privileged
capability was invoked. Actual supported spoken confirmation remains unproven.

## Files and Git state

This attempt adds only these sanitized evidence files in this directory:

- `REPORT.md`: this report.
- `inspection.json`: current environment, revision, source hashes and absence of
  physical observations.
- `apple-preflight.json`: fresh helper result and source/configuration evidence.

The existing 11 modified tracked files and 23 untracked Phase 3C source/evidence
files were preserved. With these three additions, Git has 11 modified tracked
files and 26 untracked files, with no staged changes. The full pre-attempt list
is in `inspection.json`; the three additions above describe the delta. No Apple
runtime defect was reproduced, so no production source fix was made.

## Next operator action and remaining live milestone

Make an existing authorized Mac with Xcode and the owner's iPhone accessible, or
continue this task there. Preserve this exact overlay and verify its manifest
before testing; no commit or transfer to another host was performed here. From
that checkout run:

```sh
python3 -B clients/ios/scripts/run-phase3c-apple-validation.py --build \
  --output-dir local_artifacts/ios-phase3c/apple-hardware-attempt-1
```

Choose a fresh output directory. Inspect the actual SDK, device model/OS and
signing locally, then follow the existing runbook to launch only
`ArcanosVoice-HardwareValidation`. Verify the visible fixture mode before
initializing synthetic Keychain material. Complete the Keychain/model checks,
then the real Shortcut/Vocal Shortcut and accepted-receipt lifecycle scenarios.
The helper alone does not execute the app or prove any hardware milestone.

After the appropriate physical checks pass, the next live step is to obtain a
separately authorized environment, scoped pairing/owned-job/provider operation,
read-only Local Agent target, count evidence and cleanup scope. Then follow
[runbook section G](../../../../../clients/ios/PHASE3C_DEVICE_RUNBOOK.md#g-separately-authorized-live-milestone-do-not-execute-now):
existing scoped-device pairing, normal HTTPS/origin validation, one harmless
provider task, owned-job retrieval, recovery of the same accepted job after an
observed process termination, independent counts and one approved `git.status`.
No master token or token-pasting workaround is part of that sequence. Live
privileged operations require their own approval and isolated target.

| Milestone | Status |
| --- | --- |
| Phase 3C validation tooling prepared | PASS: prior implementation inspected unchanged; fresh configuration checks pass |
| Apple-platform build/runtime validated | BLOCKED: A and B need accessible Apple tooling/runtime |
| Physical local AI and Keychain validated | BLOCKED: C and D need authorized hardware and setup |
| Physical voice/recovery validated with fixtures | BLOCKED: E and F need actual system/lifecycle execution |
| Live-service validation outstanding | NOT RUN: separate authorization required |

Phase 3C is not fully complete. The requested physical acceptance criterion
cannot be established by this Windows-only attempt.
