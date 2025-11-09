# Contextual Reinforcement & CLEAR Audit Loop

The contextual reinforcement service exposes HTTP endpoints that keep recent
conversation state, audit telemetry, and CLEAR 2.0 scores aligned. It powers
the reinforcement window consumed by `services/contextualReinforcement.ts` and
the CLEAR transport defined in `services/audit.ts` and `services/clearClient.ts`.

---

## Runtime Configuration

| Environment Variable | Default | Purpose |
| --- | --- | --- |
| `ARCANOS_CONTEXT_MODE` | `reinforcement` | Enables or disables contextual storage (`off` skips recording). |
| `ARCANOS_CONTEXT_WINDOW` | `50` | Maximum number of contextual entries kept in memory. |
| `ARCANOS_MEMORY_DIGEST_SIZE` | `8` | Number of entries included in the digest helper. |
| `ARCANOS_CLEAR_MIN_SCORE` | `0.85` | Minimum CLEAR score required before feedback is marked as accepted. |
| `CLEAR_WEBHOOK_URL` / `CLEAR_ENDPOINT` / `CLEAR_FEEDBACK_URL` | unset | Optional outbound webhook targets for CLEAR feedback delivery. |

All configuration values are surfaced through `getReinforcementHealth()` so
operators can confirm the active window and CLEAR threshold at runtime.

---

## Endpoints

All routes live under `src/routes/reinforcement.ts` and inherit the
`auditTrace` middleware, giving each request a trace identifier that is
returned in the JSON response payload.

### `POST /reinforce`

Record a natural-language summary, bias signal, and optional metadata for the
current reinforcement window.

- **Request body**
  - `context` (string, required): text to store.
  - `bias` (enum: `positive`, `neutral`, `negative`, optional): qualitative
    indicator used when constructing the digest.
  - `metadata` (object, optional): arbitrary key/value information to keep with
    the entry.
  - `requestId` (string, optional): overrides the trace identifier from
    `auditTrace`.
- **Response**: `{ status: 'ok', traceId, recorded }`, where `recorded` contains
  the persisted entry metadata. When contextual reinforcement is disabled, the
  `recorded` field will be `null`.
- **Side effects**: stores the entry in the in-memory window via
  `registerContextEntry()` and logs the event to structured logging.

### `POST /audit`

Accept CLEAR audit feedback from upstream services.

- **Request body**: a `ClearFeedbackPayload` with the following shape:
  - `system`: must be `"CLEAR"`.
  - `requestId`: identifier that links the audit back to the originating
    request.
  - `payload`: object with at least `CLEAR_score` (number) and optional
    `pattern_id`.
- **Response**: `{ status: 'ok', traceId, accepted, delivered,
  deliveryMessage, record }`.
  - `accepted` is `true` when the score meets or exceeds
    `ARCANOS_CLEAR_MIN_SCORE`.
  - `delivered` reports whether the payload was forwarded to the external CLEAR
    webhook.
  - `record` echoes the normalized audit record stored locally.
- **Side effects**: creates an audit record, stores it in the context window,
  and attempts to deliver the payload using `sendClearFeedback()`.

### `GET /memory/digest`

Returns the rolling digest that powers reinforcement-aware prompts. The digest
includes up to `ARCANOS_MEMORY_DIGEST_SIZE` recent entries with summaries,
scored biases, and pattern identifiers.

### `GET /memory`

Alias for `/memory/digest` maintained for backwards compatibility.

### `GET /health`

Reports the status of the reinforcement subsystem, including whether the
service is enabled, the number of stored contexts and audits, the configured
window size, and the timestamp of the most recent CLEAR feedback.

---

## CLEAR Feedback Loop

1. `POST /reinforce` (or internal helpers such as `trackPromptUsage()` and
   `trackModelResponse()`) captures prompts, outputs, and CLEAR results into the
   shared reinforcement window.
2. External CLEAR tooling invokes `POST /audit` with scoring metadata.
3. `processClearFeedback()` evaluates the score against the configured
   threshold, creates an audit record, and stores it via `registerAuditRecord()`.
4. `registerAuditRecord()` immediately injects a contextual entry describing the
   CLEAR outcome so future prompts reflect the latest audit status.
5. `sendClearFeedback()` delivers the original payload to the configured CLEAR
   webhook; failures are logged but do not block local storage.
6. When the AI runtime builds a system prompt, `buildContextualSystemPrompt()`
   reads the current window and the most recent CLEAR score, exposing the
   results to downstream completions.

This closed loop lets operators observe CLEAR compliance in real time while
maintaining a contextual history that is available to both human reviewers and
AI routing logic.

---

## Example Workflow

```bash
# 1. Inject a contextual note from an external observer.
curl -X POST http://localhost:8080/reinforce \
  -H "Content-Type: application/json" \
  -d '{
        "context":"Handoff to summarizer succeeded with zero retry errors",
        "bias":"positive",
        "metadata":{"source":"handoff"}
      }'

# 2. Report a CLEAR audit result for the same request.
curl -X POST http://localhost:8080/audit \
  -H "Content-Type: application/json" \
  -d '{
        "system":"CLEAR",
        "requestId":"handoff-42",
        "payload":{"CLEAR_score":0.91,"pattern_id":"handoff"}
      }'

# 3. Inspect the current digest and health snapshot.
curl http://localhost:8080/memory/digest
curl http://localhost:8080/health
```

Use these calls together to keep contextual reinforcement aligned with CLEAR
2.0 expectations across every request cycle.
