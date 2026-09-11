# Why We Fine-Tune Our AI Model

## Overview
Arcanos supports selecting a fine-tuned model and includes dataset preparation
and checkpoint-comparison tools. This guide describes those implemented tools
and the rationale for evaluating a fine-tune. Their presence does not establish
which model is deployed, that training has run, or that quality, safety, latency,
or cost improved.

## Implemented tooling and configuration

- `src/platform/runtime/unifiedConfig.ts` gives `FINETUNED_MODEL_ID` and
  `FINE_TUNED_MODEL_ID` precedence over the general default-model selectors.
  Fine-tuned IDs can also supply the fallback when no explicit fallback is
  configured. See [model precedence](CONFIGURATION.md#default-model-resolution-order).
  `src/services/openai/credentialProvider.ts` keeps Trinity's structured
  reasoning selector separate; a fine-tuned default does not replace every
  model used by the pipeline.
- `npm run dataset:build:fine-tune -- --zip <approved-export.zip> --output-dir <private-output-directory>`
  runs `scripts/build-openai-finetune-dataset.ts` from the repository root.
  With dependencies already installed, it reads local `conversations*.json`
  ZIP entries and writes `all`, `train`, and `validation` JSONL files, matching
  index sidecars, and a report. It does not upload data or start training.
  The default validation ratio is `0.1`, message window is `12`, and minimum
  assistant length is `8` characters. Output files are overwritten at the
  selected destination; use a new private directory for each approved export.
- `src/training/openaiFineTuneDataset.ts` selects the active conversation branch,
  filters visible user/assistant turns, removes recognized routing boilerplate,
  and redacts a limited set of email, OpenAI-key, and token patterns. The
  deterministic split is per example using conversation and target-message IDs,
  so examples from one conversation can appear in both splits. This is not
  evidence of conversation-disjoint evaluation or complete privacy filtering.
- `npm run fine-tune:compare -- --job-id <job-id> --validation-jsonl <approved-validation.jsonl> --output <private-report.json>`
  runs `scripts/compare-finetune-checkpoints.ts`. It retrieves the remote job and
  checkpoint metadata, then calls Responses for the final model and checkpoints.
  It writes expected answers, prompts, raw outputs, and lexical overlap F1
  scores. This requires separate authorization for provider access and approved
  data; lexical overlap alone does not establish correctness or safety.
  **`--dry-run` still contacts the provider** for job/checkpoint metadata and
  writes a report; it skips inference only.

Both package commands use `npx ts-node-esm`; use only already-installed tooling
for a bounded local task, rather than allowing a missing executable to trigger
a download. Neither workflow is a routine documentation check. The dataset
fixture suite is `tests/openai-finetune-dataset.test.ts`; its existence is not
a record that it passed in the current checkout.

<a id="assumptions"></a>

## Evaluation goals
- We operate in a domain that requires consistent terminology, workflows, and response formats.
- We must meet latency and cost targets at production scale.
- Key product flows need stable contracts enforced by application validation;
  model training alone does not make generation deterministic.

<a id="primary-reasons-we-fine-tune"></a>

## Primary Reasons to Evaluate Fine-Tuning
1. **Domain alignment and precision**
   Evaluate whether training improves domain vocabulary, workflows, and task framing while reducing post-processing.

2. **Consistency across products and teams**
   Compare output variance and prompt-maintenance needs against the baseline.

3. **Tooling and integration compliance**
   Measure schema adherence, while keeping schema validation and authorization in application code.

4. **Safety and policy adherence**
   Evaluate preferred refusals and policy adherence without replacing the backend's security boundaries.

5. **Efficiency gains (latency and cost)**
   Measure whether shorter prompts improve token usage, cost, and latency; no benchmark result is established by this guide.

## When We Do NOT Fine-Tune
- **Rapid experimentation or prototyping:** We use prompting first to validate product fit.
- **Sparse or noisy data:** We avoid fine-tuning if the training set is too small or inconsistent.
- **Highly dynamic requirements:** If the behavior is expected to change weekly, we prefer prompt iteration over model retraining.

## Data and Privacy Considerations
- Review approved training data and all output sidecars before any upload. The
  current index retains conversation titles and identifiers, and the report
  retains local paths; automated text redaction is incomplete.
- Separate public, internal, and restricted data under the applicable access
  policy. The builder does not implement an access-control or consent system.
- Retain approved provenance and evaluation records privately. The source
  implements output reports, not proof that an organizational review occurred.

## Governance, Evaluation, and Rollback
- Before release, evaluate baseline prompts and critical workflows, including
  conversation-disjoint cases where dataset overlap would bias results.
- Prepare an authorized model-configuration rollback. The selectors make model
  replacement possible; they do not establish a tested deployment rollback.
- Re-evaluate when data, prompts, models, or policies change. This guide records
  review criteria, not a completed or scheduled evaluation program.

## Decision Checkpoints (//audit)
- `//audit`
  - **Assumption**: fine-tuning improves domain accuracy
  - **Risk**: overfitting reduces generalization
  - **Invariant**: model must pass baseline QA
  - **Handling**: compare against baseline eval set before release.
- `//audit`
  - **Assumption**: structured outputs are required for integrations
  - **Risk**: schema drift breaks clients
  - **Invariant**: schema remains stable
  - **Handling**: validate outputs with contract tests.
- `//audit`
  - **Assumption**: training data is policy-compliant
  - **Risk**: sensitive data leaks
  - **Invariant**: data is sanitized
  - **Handling**: enforce data review and redaction gates.
- `//audit`
  - **Assumption**: fine-tuning reduces cost
  - **Risk**: model becomes too specialized and slower
  - **Invariant**: latency targets met
  - **Handling**: benchmark before rollout.

## Minimal Test Plan
- **Happy path:** Run standard evaluation prompts and verify domain-specific outputs match expected formats.
- **Edge case:** Evaluate ambiguous or multi-intent queries and confirm the model follows policy and formatting rules.
- **Failure mode:** Inject invalid or adversarial prompts and confirm the model refuses or de-escalates per policy.
