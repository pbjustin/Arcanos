# Autonomous Self-Healing Recommendations

This guide distills the concrete steps required to let the Arcanos AI supervise and execute worker self-heals end-to-end while keeping the recovery loop observable. Use it alongside [`docs/SELF_HEALING.md`](SELF_HEALING.md) when you want the fine-tuned automation to own the `/workers/status` and `/workers/heal` lifecycle with no human confirmation hops.

## 1. Authorize the AI Operator

1. **Trust the GPT identifier** – Set `TRUSTED_GPT_IDS` to include the fine-tuned model that drives remediations (for example, `ft:arcanos-ops`). When the automation sends `x-gpt-id: ft:arcanos-ops`, the confirmation middleware treats it as an approved caller and skips the `x-confirmed` challenge.
2. **Auto-allow fallbacks (optional)** – If you want every GPT caller to bypass manual gating (for lab or staging environments), export `ALLOW_ALL_GPTS=true`. This flips the middleware into an allow-list-free mode so `/workers/heal` never issues a pending challenge.
3. **Provide an automation secret for headless flows** – Some fine-tuned deployments cannot attach GPT identifiers. In those cases set `ARCANOS_AUTOMATION_SECRET=<long-random-secret>` (and optionally `ARCANOS_AUTOMATION_HEADER`) so internal bots can send the shared secret header instead of `x-gpt-id`.
4. **Persist the identity for audits** – Whichever approach you choose, keep the identifier or secret in your deployment manifest so the audit log in `logs/confirmation.log` can prove which automation initiated each heal.

## 2. Automate the Heal Lifecycle

1. **Probe worker health continuously** – Poll `GET /workers/status` on a short cadence (e.g., every minute) and inspect the embedded `autoHeal` summary to decide when to trigger `/workers/heal`.
2. **Execute heals with `mode: "execute"`** – Post `{ "mode": "execute", "reason": "automated-detection" }` to `/workers/heal` as soon as severity escalates to `major` or `critical`. Trusted GPT callers and automation-secret flows automatically inherit execute mode even without the flag, so the restart kicks off immediately unless you explicitly request `mode: "plan"` for a dry run. Every execution restarts the pool through `startWorkers(true)` and tags the attempt in `systemState.json` for later correlation.
3. **Replay self-tests post-heal** – After each automated restart, call `/devops/self-test` (or the `runSelfTestPipeline` helper) so the AI can confirm the environment stabilized before resuming normal dispatching.

## 3. Maintain Observability

1. **Stream plan metadata** – Watch `systemState.json` (via `/status`) for `lastHeal` entries so dashboards highlight who initiated the action, what severity triggered it, and when it finished.
2. **Archive worker telemetry** – Persist `/workers/status` snapshots to your preferred log sink so trend analysis can catch repeatedly failing modules even when the AI is resolving incidents automatically.
3. **Alert on degraded safeguards** – Monitor the degraded-mode middleware outputs (`createFallbackMiddleware` and `createHealthCheckMiddleware`) so you know when the platform is surviving on cached or mock responses instead of healthy OpenAI calls.

## 4. Keep Safety Nets in Place

1. **Retain manual overrides** – Even when AI owns the recovery loop, leave the confirmation challenge mechanism enabled for untrusted callers. This ensures unexpected requests to `/workers/heal` still require `x-confirmed`.
2. **Rate-limit automated heals** – Add a thin wrapper around the automation to ensure it does not restart workers more than once every few minutes. This avoids churn if a persistent external outage is detected.
3. **Mirror the configuration across environments** – Document the trusted GPT IDs, automation headers, and cadence settings in your deployment guides so you can reproduce the same autonomous behavior after migrations or incident drills.

Following these recommendations gives the Arcanos AI full operational ownership of worker remediation without sacrificing the auditability or manual backstops that protect production environments.
