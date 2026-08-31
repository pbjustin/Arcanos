# Backstage Booker GPT Builder 1.7.0 instruction replacement checklist

This is the canonical manual instruction update for the private Backstage
Booker Custom GPT. Repository code cannot edit the live GPT. Apply this patch
only after the backend revision that serves Builder contract `1.7.0` has been
deployed and verified.

## Re-import the Action contract

1. Open the existing Backstage Booker GPT in ChatGPT Builder. Do not create a
   second GPT or Action.
2. Edit its existing Action and import
   `https://acranos-production.up.railway.app/contracts/backstage_booker.openapi.v1.json`.
3. Confirm the imported contract reports version `1.7.0` and preserves exactly
   these operation IDs: `runBackstageBooker`,
   `getBackstageBookerJobResult`, `getBackstageUniverse`,
   `getBackstageStoryline`, and `writeBackstageCanon`.
4. Confirm `getBackstageBookerJobResult` still uses
   `GET /gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result`, with
   `waitForResultMs` bounded from `0` through `30000` and defaulting to `30000`.
5. Leave Authentication set to the existing **API Key / Bearer** configuration.
   Do not reveal, inspect, copy, replace, re-enter, or rotate the saved value. If
   import clears authentication, stop; restoring it is a separate authorized
   credential operation.
6. Confirm the Action contract contains no `jobReadToken`,
   `jobReadTokenHeader`, `x-arcanos-job-read-token`, or `stream` field.
7. Replace the GPT's full existing canonical Backstage instruction block with
   the complete fenced block under **Builder update checklist** in
   [`BACKSTAGE_BOOKER_CUSTOM_GPT.md`](BACKSTAGE_BOOKER_CUSTOM_GPT.md). Copy that
   block from its first `Use runBackstageBooker` line through its final Phase
   One sentence. Do not append either that block or the excerpt below: appending
   can exceed Builder's practical 8,000-character limit and leave conflicting
   old policy in place. Preserve the GPT's name, knowledge, conversation
   starters, model, visibility, and sharing settings, then save the same GPT.

## Protected-failure verification excerpt (do not append)

```text
PROTECTED BACKSTAGE AUTHORITY AND FAILURE POLICY

Protected Backstage authority is mandatory for official booking output. Never
use the current ChatGPT conversation, model memory, general wrestling knowledge,
or an earlier draft as a replacement when runBackstageBooker or
getBackstageBookerJobResult fails, aborts, times out, returns not_found, or
returns official=false.

Production-sized protected generation is accepted into the durable queue.
runBackstageBooker returns the accepted jobId promptly and does not wait for the
complete booking. Preserve that exact jobId. Use getBackstageBookerJobResult,
authenticated by the same saved Action bearer, for long-poll continuation.
Pending is not failure. While status is pending, continue polling the same job;
do not submit another booking request.

If the initial run transport aborts before any response or jobId is received,
retry the identical run operation once so backend idempotency can recover the
accepted job. Do not make more than that one recovery retry. If the retry
returns a jobId, preserve it and continue polling that same job.

On any protected failure or abort, do not answer the booking request from
conversation context, do not reconstruct a plausible card, do not present a
partial draft, do not call any result official, and do not claim continuity was
verified. Treat failed, expired, cancelled, unavailable, not_found, unverified,
official=false, and protectedGenerationCompleted=false as establishing no
official booking. Never use a failed result's error detail to continue the
storyline.

If no accepted or completed protected result is recovered, state exactly:
"The protected Backstage booking did not complete, so no official result was
established." Then stop. Produce a conversation-only working draft only after
the user explicitly requests that degraded mode after the failure has been
disclosed, and label that draft non-authoritative and unofficial.
```

The full canonical replacement block must preserve every policy expressed by
the excerpt above, although it may use the more compact wording required by the
Builder limit. Use the excerpt as a semantic verification checklist, not as an
additive patch. The schema makes protected provenance and failure state
machine-readable, but schema alone cannot guarantee model behavior after a
transport failure. No repository test or backend response can silently modify
ChatGPT Builder.
