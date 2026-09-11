# Phase 3 engineering report

Date: 2026-09-11. Baseline: branch `work` at merge commit `4503f21`, which contains
the reported Phase 2 proof commit `506d32a`. The checkout was clean before this
change. This report is implementation evidence, not physical-device evidence.

## Implemented checkpoint

This checkpoint adds the reusable durable recovery-index core. `OperationTracker`
persists a submission intention before transport, records accepted backend job
handles without calling them complete, represents uncertain delivery separately,
and accepts result observations only for the exact stored handle. Records are
partitioned by canonical HTTPS origin and the server-issued device UUID. Duplicate
idempotency keys in one partition fail closed.

The file store uses atomic writes and complete file protection. Records contain no
credential, confirmation challenge, prompt, payload, repository content, or result.
Terminal/dismissed metadata is retained for seven days by default; unresolved
records remain until the user resolves or deletes the partition. Unpairing callers
can delete one exact partition with `removeAll`. The backend remains authoritative.

Implicit voice reference resolution returns a target only when exactly one recent
candidate exists. Ambiguous and stale context is not guessed. The notification
inbox accepts only minimal operation/job/device identifiers, deduplicates events,
rejects cross-partition and pre-operation hints, and never changes job state. A
caller must perform the normal authenticated result fetch after any accepted hint.

## Security and compatibility

- Existing confirmation code is unchanged: the frozen request is retried once and
  the raw challenge remains only the top-level `confirmation_token`.
- Existing `patch.preview` / `patch.apply` behavior is unchanged. Patch bodies are
  intentionally not placed in the recovery index, so an app restart requires a new
  preview and approval rather than applying content under stale evidence.
- No cancellation endpoint, automatic mutation replay, background microphone,
  generic command execution, APNs credential, backend scope, schema, deployment,
  or production infrastructure was added.
- Existing Phase 2 cross-device, origin-header, ownership, credential lifecycle,
  exact-confirmation-retry, and accepted-job tests remain in the Swift suite.

## Validation performed

`swift test --package-path clients/ios/ArcanosKit` passed on Linux with 18 XCTest
tests plus 84 Swift Testing cases. Five new deterministic cases cover cross-process
restoration, accepted-job preservation, ambiguous delivery, idempotency collision,
device partition isolation, ambiguous reference rejection, mismatched job results,
and duplicate/out-of-order/cross-device notification hints.

## Remaining implementation and validation

This commit does **not** claim the complete Phase 3 milestone. The recovery index is
not yet wired into `ArcanosSession` submission and the app lifecycle; App Intents
still track their latest job in memory. Backend APNs token registration/delivery is
also not implemented because no reviewed device-notification contract exists.
Those are required before calling durable recovery user-visible.

The following are **NOT RUN**: Xcode/iOS SDK compilation, Simulator execution,
physical iPhone Keychain behavior, Foundation Models inference, Siri/App Shortcut
activation, dictation/speech, system confirmation, APNs delivery, authorized HTTPS
Gateway integration, PostgreSQL assertions, Local Agent/provider execution, and
dismiss/relaunch result retrieval. This environment exposes Linux Swift rather
than Xcode/device hardware and no live credentials or isolated target were used.

## Exact physical-iPhone procedure

1. On a Mac with the repository checkout at this commit, run the Swift package
   tests, open `clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj`, select a signing
   team, and build the `ArcanosVoice` scheme against the installed iOS SDK.
2. Install on an unlocked, trusted iOS 26 Apple Intelligence-capable iPhone. Verify
   Keychain persistence after kill/relaunch, replacement on renewal, locked-device
   denial, expiry, revocation, unpairing, and origin changes.
3. With networking disabled, separately test intent invocation, dictation, a bounded
   Foundation Models request, unavailable-model handling, and spoken output. Inspect
   transport instrumentation to prove the local-only request made no network call.
4. Configure the user-owned App Shortcut/Vocal Shortcut. Invoke Ask Arcanos, dismiss
   Siri after a pending acknowledgement, terminate/relaunch the app, restore the
   operation, and retrieve its result without a second create request. Exercise an
   ambiguous recent-reference case and verify clarification rather than selection.
5. Against an explicitly authorized non-production HTTPS Gateway, pair this device,
   submit a real provider job, verify owner-only result access and Local Agent
   read-only access, then separately approve one `tests.run` or `patch.apply` action.
   Confirm the exact frozen retry and stale-preview refusal. Do not use production.
6. After APNs contract implementation/operator setup, test denied permission, token
   replacement, revocation/unpairing, delayed/duplicate/out-of-order/missing pushes,
   and a tap that fetches authoritative state but never approves an action.

## Recommended review boundaries

Review the tracker model/storage first, then partition/reference rules, then the
notification-hint boundary and tests. A following checkpoint should exclusively
wire preflight/receipt transitions into sessions and lifecycle recovery. APNs and
live hardware proof should remain separate so notification setup cannot block the
core recovery path.
