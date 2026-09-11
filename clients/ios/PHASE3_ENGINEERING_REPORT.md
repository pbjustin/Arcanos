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
idempotency keys in one partition and duplicate operation UUIDs fail closed,
including when restoring persisted records. Accepted job handles cannot be
rebound, and delayed callbacks cannot replace terminal observations. Local Agent
`pending` receipts and deduped terminal receipts are supported.

The file store uses atomic writes and complete file protection. The host must keep
one tracker instance per file; actor serialization does not coordinate separate
trackers or processes sharing a file. Callers must supply fixed, non-sensitive
display summaries and opaque identifiers, never credentials, confirmation
challenges, prompts, payloads, repository content, or results. The string fields do
not automatically redact sensitive caller input.
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

The original checkpoint reported a Linux `swift test --package-path
clients/ios/ArcanosKit` run with 18 XCTest tests plus 84 Swift Testing cases. Its
five new deterministic cases use in-memory persistence and cover restoration
across tracker instances, accepted-job preservation, ambiguous delivery,
idempotency collision, device partition isolation, ambiguous reference rejection,
mismatched job results, and duplicate/cross-device notification hints. They do not
demonstrate cross-process or file-backed recovery, file protection, or rejection
of out-of-order notifications.

Review independently verified the [macOS CI job](https://github.com/pbjustin/Arcanos/actions/runs/34581054753/job/103204443210)
for original head `328fcc2f0b824a17e5bf2935220d3ff03bd78ae4`: Apple Swift 6.2.4
and Xcode 26.3 passed 18 XCTest tests and 85 Swift Testing cases, including the
five tracker cases, and built the unsigned Simulator app successfully. This run
does not validate later review fixes or establish Simulator execution.

The review fixes passed the complete package suite on Linux with Swift 6.2.4:
18 XCTest tests and 92 Swift Testing tests in eight suites. Added regression
coverage checks Local Agent receipt statuses, immutable handles, delayed terminal
callbacks, invalid observations, duplicate identities, malformed restoration,
and preservation of durable and actor state after a failed write. The existing
Gateway contract passed its drift check. These fixes still require a fresh macOS
CI run for Apple-platform compilation evidence.

## Remaining implementation and validation

This commit does **not** claim the complete Phase 3 milestone. The recovery index is
not yet wired into `ArcanosSession` submission and the app lifecycle; App Intents
still track their latest job in memory. Backend APNs token registration/delivery is
also not implemented because no reviewed device-notification contract exists.
Those are required before calling durable recovery user-visible.

The following are **NOT RUN**: Simulator execution, physical iPhone Keychain
behavior, Foundation Models inference, Siri/App Shortcut
activation, dictation/speech, system confirmation, APNs delivery, authorized HTTPS
Gateway integration, PostgreSQL assertions, Local Agent/provider execution, and
dismiss/relaunch result retrieval. The original implementation environment exposed
Linux Swift rather than Xcode/device hardware; the macOS CI build above supplies
separate compilation evidence. No live credentials or isolated target were used.

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
4. After session/lifecycle recovery is implemented, configure the user-owned App
   Shortcut/Vocal Shortcut. Invoke Ask Arcanos, dismiss
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
