# GPT-OSS DB Governance

Railway Postgres can support GPT-OSS as a governance store, eval ledger, and
review queue. It is not a raw training corpus.

The governance path is:

```text
redacted observation or eval failure
  -> candidate queue
  -> human/spec review
  -> approved example store
  -> dataset gate
  -> optional future JSONL export
```

Raw DB dumps, raw logs, raw production payloads, secrets, hidden reasoning,
Custom GPT action requests, OpenAI model output, and OpenAI judgments are not
training data. `railway_cli_observation` and `eval_failure_observation` are
candidate-only provenance values; the dataset gate rejects them until a reviewer
creates a separate `human_authored`, `arcanos_owned_spec`, or `repo_schema`
record.

`self_reflection_observation` follows the same candidate-only rule. The
`self_reflections` table can help prioritize review because it has `category`
and `priority`, but raw reflection rows are not directly trainable. Do not dump
`self_reflections.content` into training data. Use category, priority, and
metadata keys only for aggregate inspection; any approved example must be
rewritten or redacted as a human/spec/schema-owned record before export.

## Schema

The migration file is:

```bash
migrations/20260521_gptoss_governance.sql
```

It defines:

- `arcanos_action_registry`
- `arcanos_route_policy`
- `arcanos_safety_rules`
- `gptoss_eval_runs`
- `gptoss_eval_failures`
- `gptoss_training_candidates`
- `gptoss_approved_training_examples`

Local scripts do not apply this migration. Review it and apply it manually in
the target Postgres environment only when that is explicitly intended. After
review and explicit approval, the guarded apply command is:

```bash
npm run gptoss:db:schema:apply
```

The apply command requires the local DB connection environment to be present,
rejects destructive SQL, runs this one idempotent migration in a transaction,
and reports only table names plus seed counts. It does not dump table contents.

Inspect the migration without opening a DB connection:

```bash
npm run gptoss:db:schema:dry
npm run gptoss:db:governance:validate
npm run gptoss:db:migration:print
```

Verify live table presence without dumping rows:

```bash
npm run gptoss:db:schema:verify-live
```

Inspect classification coverage without reading raw row content:

```bash
npm run gptoss:db:classification:inspect
```

That command is dry-run/local-schema only by default and writes aggregate
reports under `local_artifacts/gptoss-db-governance/`. A live metadata-only run
requires an explicitly configured DB connection and `--execute`; it is limited
to table existence, column names, row counts, category/priority counts, and
metadata key counts. It must not select `content`, dump metadata values, or
export JSONL.

## Candidates

Candidate imports default to non-trainable review records:

- `allowed_for_training: false`
- `reviewed: false`
- `requires_human_review: true`
- `redacted: false` unless the input is already verified redacted
- `no_openai_output_used: true`

Dry-run a candidate import:

```bash
npm run gptoss:db:candidate:dry
```

The importer never creates approved training examples automatically and does
not store raw stdout, stderr, logs, or production payloads as messages.

Self-reflection-derived candidates must also default to:

- `source: self_reflection_observation`
- `allowed_for_training: false`
- `reviewed: false`
- `requires_human_review: true`

Reflection `category` can suggest a task family, `priority` can suggest review
order, and metadata keys can suggest labels to inspect. Metadata values and raw
reflection content stay out of reports and training datasets.

## Approved Export

Approved export filters only rows with:

- `reviewed: true`
- `redacted: true`
- `allowed_for_training: true`
- `no_openai_output_used: true`
- source in `arcanos_owned_spec`, `repo_schema`, `human_authored`, or
  `redacted_consented_log`

Every exported row is validated by the existing GPT-OSS dataset gate. By
default, export dry-runs do not write JSONL:

```bash
npm run gptoss:db:export-approved:dry
```

Use `--execute --output <path>` only after reviewing the source rows. Prefer
`local_artifacts/gptoss-db-export/` for generated reports unless the export is
explicitly intended as a reviewed dataset artifact.

## Eval Ledger

Eval report ingestion records run metadata and redacted failure facts. It does
not create training examples:

```bash
npm run gptoss:db:eval-ledger:dry -- --report local_artifacts/gptoss-phase3-7-lowlr/eval-force-final.json --dataset-path examples/gptoss/arcanos-phase3-7-weighted-repair-training.jsonl
```

Ledger dry-runs write local reports under `local_artifacts/gptoss-db-ledger/`.

## Phase 3.8 Candidate Workflow

The Phase 3.7 router/classifier postprocessed v2 eval reached 9/24. Its
remaining true model errors are now represented as local governance candidate
drafts, not training data:

```bash
node scripts/gptoss/db-eval-ledger.mjs --report local_artifacts/gptoss-phase3-7-lowlr/eval-router-classifier-postprocessed-v2.json --dataset-path examples/gptoss/arcanos-phase3-7-weighted-repair-training.jsonl
node scripts/gptoss/db-training-candidate-import.mjs --input local_artifacts/gptoss-phase3-7-lowlr/phase3_8_governance_candidates.jsonl
node scripts/gptoss/db-export-approved-training.mjs
```

Those commands are dry-run/local by default. They do not require live DB writes,
do not dump raw rows, and do not create approved JSONL examples. The
`eval_failure_observation` source remains non-trainable even when the candidate
is redacted and queued for review.

Only a separate reviewed `arcanos_owned_spec`, `repo_schema`, or
`human_authored` repair dataset can be used for future training. For Phase 3.8,
that file is
`examples/gptoss/arcanos-phase3-8-true-error-repair-training.jsonl`; validate it
with:

```bash
npm run gptoss:phase3-8:dataset:validate
```

OpenAI reference mode remains disabled for this workflow, and no live DB writes
are required to ingest the local eval ledger or candidate drafts in dry-run
mode.

## Safety

Keep tokens, cookies, bearer strings, and connection strings in local
environment configuration only. Do not paste them into prompts, reports, DB
rows, or JSONL examples. OpenAI reference mode remains disabled for this GPT-OSS
path, and this governance layer does not train, call OpenAI, use vLLM, run
Railway CLI, or modify production routing.
