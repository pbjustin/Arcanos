# CLEAR 2.0 Auditing Across Any Domain

The CLEAR method (Clarity, Leverage, Efficiency, Alignment, Resilience) was built to judge orchestration quality inside ARCANOS, but the same rubric can govern any complex system — from logistics workflows to healthcare decision engines. This guide explains how to adapt CLEAR 2.0 scoring to new problem spaces without diluting its rigor.

## 1. Establish Your Audit Substrates

1. **Inventory assets** — enumerate workflows, services, prompts, or policies that will be scored together. Treat each asset as an "audit substrate" that can emit telemetry, supply documentation, and accept remediation tasks.
2. **Declare system boundaries** — document upstream dependencies, downstream consumers, and shared controls so that CLEAR findings have defined scope.
3. **Name authoritative data sources** — identify trace stores, code repositories, policy registries, or process logs that feed each metric. Audits should never rely on ad-hoc samples.

## 2. Map CLEAR Principles to Domain Signals

Translate the five principles into domain-specific observable signals.

| Principle | Universal Question | Domain Mapping Examples |
|-----------|--------------------|-------------------------|
| Clarity   | Can a reviewer trace inputs → decisions → outputs? | Trace IDs for supply-chain events, explainability packets in ML inference, medical note addenda in clinical ops. |
| Leverage  | Does the system reuse vetted modules instead of cloning logic? | Shared worker libraries, template-driven customer outreach, standardized order routing rules. |
| Efficiency| Are latency, cost, or resource budgets honored? | CPU quotas per tenant, fulfillment SLA adherence, staffing hours per patient. |
| Alignment | Are actions consistent with policy, compliance, or strategic goals? | Privacy policy enforcement, contract-specific price guards, care-path guidelines. |
| Resilience| Can the system absorb failures and recover predictably? | Double-entry inventory checks, backup routing trees, on-call escalation charts. |

For each signal:

- Document the metric formula (e.g., `alignment.intentMatch = aligned_decisions / total_decisions`).
- Define thresholds for green/yellow/red bands.
- Specify the sampling cadence (per deploy, hourly, real-time).

## 3. Instrument Data Collection

1. **Attach telemetry hooks** to every asset. Examples: middleware exporting JSON traces, ETL jobs feeding data warehouses, or manual review forms for regulated processes.
2. **Normalize inputs** so that the audit service can compare assets. Convert disparate metrics into 0–10 scores using min/max scaling or percentile ranks.
3. **Persist evidence** such as trace excerpts, screenshots, or runbooks in append-only storage. Auditors must be able to replay decisions.

## 4. Configure CLEAR Scorecards

1. **Define per-principle weights.** ARCANOS uses Clarity 25%, Leverage 15%, Efficiency 20%, Alignment 20%, Resilience 20%. Adjust weights only if risk appetites demand it; otherwise reuse the defaults for comparability.【F:docs/resiliency-patches-and-clear.md†L81-L101】
2. **Create schema contracts** for audit payloads. Each asset should emit:
   - `asset` descriptor and revision tag.
   - `scores` object containing the five principles plus sub-metrics.
   - `composite` numeric score and `status` label (green/yellow/red).
   - `recommendations` array linking to remediation tasks.【F:docs/resiliency-patches-and-clear.md†L107-L145】
3. **Automate ingestion** through APIs or message buses so that scorecards stay current without manual exports.

## 5. Run Cross-Domain Audit Cycles

Follow a repeatable cadence regardless of industry:

1. **Pre-audit readiness** — verify telemetry freshness, lock configuration baselines, and announce cut-off times to stakeholders.
2. **Execution window** — run automated CLEAR score generation, followed by targeted manual reviews for low-signal metrics (e.g., policy nuance or clinical appropriateness).
3. **Review board** — convene cross-functional owners to inspect composite scores, compare against service-level commitments, and accept or reject deployments.
4. **Remediation tracking** — feed recommendations into backlog tools with owners, due dates, and expected score impact.
5. **Regression proof** — require evidence (tests, runbooks, change diffs) before closing findings to ensure scores trend upward.

## 6. Embed CLEAR Into Operational Rituals

- **Gate deployments**: block releases when composite scores fall below target thresholds or when any single principle dips beneath minimum floor (e.g., Resilience < 7 triggers fail-safe mode).
- **Drive budget conversations**: Efficiency scores inform capacity planning and vendor negotiations.
- **Reinforce policy**: Alignment findings become inputs to governance councils or compliance attestations.
- **Test disaster readiness**: Resilience actions map directly to chaos drills and tabletop exercises.

## 7. Scaling to New Domains

1. **Create domain adapters**: thin translation layers that convert local telemetry (e.g., IoT sensor feeds) into CLEAR-compliant payloads.
2. **Distribute starter templates**: markdown or JSON blueprints so new teams can self-serve audits without expert facilitation.
3. **Bundle training**: run workshops illustrating how to score a canonical workflow in the new domain, emphasizing evidence quality.
4. **Continuously calibrate**: compare inter-rater reliability between auditors, adjust scoring rubrics, and publish calibration notes quarterly.

## 8. Example Adoption Journey

1. A healthcare network selects electronic triage as the audit substrate.
2. They map CLEAR principles to triage signals (clarity = chart explainability, leverage = standardized triage protocols, etc.).
3. An ETL job exports nightly scores plus flagged patient encounters to `clear_audit.log`.
4. Deployment reviews require composite ≥ 8.2 _and_ resilience ≥ 8.0 before rolling out triage updates hospital-wide.
5. Findings flow into a remediation Kanban board, closing only when nurse leaders confirm process changes.

By abstracting CLEAR 2.0 into assets, signals, instrumentation, and operational cadences, any organization can gain the same auditable rigor that protects ARCANOS orchestration workflows.
