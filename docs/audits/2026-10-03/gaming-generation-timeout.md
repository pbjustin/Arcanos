# Gaming generation timeout regression and acceptance

This is retained, user-supplied production evidence and a post-merge acceptance
procedure. It is not a new production observation, deployment authorization or
proof that the corrected provider operation succeeds live. Implementation starts
from `c024c387a353caa30efcc7e3cd2765dc3901fb84`, the merge of PR #1521,
`pbjustin/refactor/gaming-currentness-advisory`.

## Retained production failure

- Question: **“bleed Samurai build”**
- Game: **Elden Ring**
- Mode: **build**
- Workflow: `22dda62b-3f7f-4c99-abba-0d3b4d8973c0`
- Currentness request ID: `req_1790987700165_zv0gap`

Evidence before provider execution:

| Field | Observed value |
| --- | --- |
| `sourceKnown` | `true` |
| `evidenceSelected` | `true` |
| `freshnessStatus` | `unverified` |
| `acceptedGameplayCandidateCount` | `2` |
| `applicabilityStatus` | `unverified` |
| `gameplayEvidenceStatus` | `accepted_transient` |
| CLEAR evidence decision | `accept` |
| `groundingStatus` | `grounded` |
| `fetchedSourceCount` | `2` |
| `usableSourceCount` | `2` |
| `citableSourceCount` | `2` |
| `selectedChunkCount` | `3` |

The correctly retained currentness warning was:

> Current patch compatibility could not be verified. These recommendations are
> based on the available grounded guides and may be outdated if recent balance
> changes affected these items or mechanics.

`gaming.provider.start` recorded `provider = trinity`, `timeoutMs = 35000`,
`stageTimeoutMs = 12000`. Trinity intake completed successfully. Approximate
timestamps were provider start `00:35:00.913`, Gaming intake complete
`00:35:06.064`, provider failure `00:35:18.072`. Failure was `OpenAIAbortError`,
`timeoutPhase = reasoning`, `fallbackReason = INTAKE_UPSTREAM_TIMEOUT`, and
provider elapsed time approximately `17,159 ms`. Trinity logged:

> Sensitive-context generation failed.

Gaming selected `provider_timeout_with_evidence`, but hybrid returned
`state = temporarily_unavailable`, `nextAction = retry_later`,
`reason = GENERATION_UNAVAILABLE`. The observed Trinity prompt was approximately
7,792 characters; no raw evidence or provider prompt is retained here.

The implementation confirms the cause: a fixed 12-second Gaming model-stage cap
was passed to Trinity intake, reasoning and final generation inside the separate
35-second pipeline watchdog. Successful intake consumed about five seconds, then
reasoning exhausted the fixed stage cap while substantial pipeline time remained.
Hybrid discarded the specific timeout fallback when normalizing unsuccessful
generation. Grounding and advisory-currentness behavior had succeeded.

## Exact post-merge live acceptance procedure

Do not execute this procedure in the coding PR. After merge and separately
authorized deployment of the reviewed backend revision, obtain authorization for
the live provider acceptance operation and record the deployed SHA.

1. Submit **“bleed Samurai build”**, game **Elden Ring**, mode **build** through
   the normal actor-bound `gaming-hybrid-v1` query operation.
2. Follow the returned gameplay discovery request with its workflow ID,
   idempotency key and bounded candidate submission. Confirm actual gameplay
   acquisition, sufficient retained coverage, accepted evidence and CLEAR
   acceptance before provider dispatch.
3. Follow the returned official-currentness verification request with that same
   workflow and its own operation idempotency key. Preserve one gameplay round,
   one currentness round and the existing three-source acquisition limit per
   operation. Do not restart discovery or manufacture a new workflow.
4. If currentness remains unverified, retain the exact visible may-be-outdated
   warning above. Confirm grounded provider generation starts anyway.
5. Inspect content-free stage telemetry: total pipeline limit, request remaining
   time at dispatch, effective reasoning-stage limit, remaining generation time,
   elapsed time and timeout phase. Confirm reasoning can pass the old 12-second
   boundary within the corrected bounded allocation and final/audit/terminal
   headroom, without a second automatic provider-generation operation.
6. On successful grounded generation, expect `state = answer_ready`,
   `nextAction = answer`, `evidenceSelected = true`,
   `freshnessStatus = unverified`, accepted source citations and the visible
   warning. Preserve qualification, accepted gameplay candidate count,
   applicability and gameplay evidence status. Reject false verified-current or
   latest-patch claims. If currentness actually verifies, preserve that verified
   outcome instead of manufacturing advisory freshness.
7. If generation genuinely exhausts the corrected safe provider deadline, expect
   `state = temporarily_unavailable`, `nextAction = retry_later`,
   `reason = PROVIDER_TIMEOUT_WITH_EVIDENCE`, `sourceKnown = true` and
   `evidenceSelected = true`, with the same currentness and qualification fields.
   Record this as a generation timeout, not a source failure.
8. If a later client retry is separately authorized, retry the same logical
   retryable operation and payload with the same workflow/operation keys.
   Within existing validity/TTL, confirm retained evidence is reused without
   additional acquisition or currentness rounds. Do not extend TTLs.
9. Record the workflow ID, request IDs, deployed SHA, structured budget values,
   elapsed time, result reason and provider-generation operation count. Confirm
   the installed plugin, approved skill, eight tools, authentication, model
   policy and storage consent boundaries remain unchanged. Do not store sources
   without the existing separate authorization.

Offline tests prove the allocation, cancellation and response contracts. Actual
provider latency and successful live grounded generation remain to be measured
by this separately authorized procedure.
