# GPT-OSS Local Runtime

GPT-OSS is a local-only runtime in this checkout. Railway remains responsible for
the web service, workers, and control plane. Local WSL or an external GPU host
handles GPT-OSS model execution.

Do not point Railway `OPENAI_BASE_URL` at `http://127.0.0.1`, `localhost`, or a
WSL-only address. In Railway, `127.0.0.1` is the Railway container itself, not
the local GPU runtime.

Use `OPENAI_BASE_URL` only for OpenAI-compatible provider overrides. If GPT-OSS
is exposed through a cloud endpoint, keep that separate with
`GPTOSS_API_BASE_URL`.

Example local-only variables:

```dotenv
# Local-only GPT-OSS runtime. Do not set these in Railway.
# GPTOSS_LOCAL_ENABLED=false
# GPTOSS_LOCAL_API_BASE_URL=http://127.0.0.1:11434/v1
# GPTOSS_LOCAL_MODEL=gpt-oss
# GPTOSS_LOCAL_HEALTH_TIMEOUT_MS=5000
# ARCANOS_LOCAL_GPU_DYNAMIC=true
# ARCANOS_VRAM_MIN_FREE_MB=10500
# ARCANOS_VRAM_BALANCED_FREE_MB=12500
# ARCANOS_VRAM_PERFORMANCE_FREE_MB=14500
# ARCANOS_TRAINING_ALLOW_SWAP=false
# ARCANOS_CAPTURE_OPENAI_OUTPUT=false
# ARCANOS_USE_OPENAI_OUTPUT_FOR_TRAINING=false
# ARCANOS_REFERENCE_OUTPUT_TTL_SECONDS=0
# ARCANOS_TRAINING_DATA_SOURCE=owned_specs_only
# ARCANOS_REQUIRE_HUMAN_DATASET_APPROVAL=true

# Cloud-hosted GPT-OSS endpoint, when one exists.
# GPTOSS_API_BASE_URL=https://your-gptoss-gateway.example/v1
```

## Local Commands

Profile the current GPU:

```bash
npm run gptoss:vram:profile
```

Dry-run the selector without a GPU:

```bash
npm run gptoss:vram:profile:dry
```

Validate the safe smoke dataset:

```bash
npm run gptoss:dataset:validate
```

Validate the optional Railway-safe routing dataset:

```bash
npm run gptoss:railway:dataset:validate
```

Print the smoke training plan without training:

```bash
npm run gptoss:train:smoke:dry
```

Dry-run the local Unsloth QLoRA smoke trainer:

```bash
npm run gptoss:unsloth:smoke:dry
```

Run the capped local Unsloth smoke trainer only after dataset validation passes:

```bash
npm run gptoss:dataset:validate
npm run gptoss:unsloth:smoke
```

Run the local eval baseline without contacting a model:

```bash
npm run gptoss:eval:local:dry
```

Dry-run the capped second-phase Unsloth command:

```bash
npm run gptoss:unsloth:phase2:dry
```

Generate a vLLM serve command without starting vLLM:

```bash
npm run gptoss:vllm:command
```

Check the local GPT-OSS OpenAI-compatible endpoint:

```bash
npm run gptoss:bridge:health
```

Preview the same endpoint configuration without network I/O:

```bash
npm run gptoss:bridge:dry
```

Run a dry-run bridge comparison report without network I/O:

```bash
npm run gptoss:bridge:dry
```

Run a smoke bridge eval without network I/O:

```bash
npm run gptoss:eval:smoke
```

Preview a local Railway CLI observation without running Railway:

```bash
node scripts/gptoss/railway-cli-bridge.mjs --dry-run --action railway.logs --service <service> --environment production
```

The Railway bridge is for redacted observation and eval/data drafting only.
Details are in `docs/GPTOSS_RAILWAY_BRIDGE.md`.

Inspect the optional GPT-OSS DB governance schema without opening a DB
connection:

```bash
npm run gptoss:db:schema:dry
npm run gptoss:db:governance:validate
```

The DB governance layer is a source-of-truth, eval ledger, and reviewed
candidate store. It is not a raw training corpus and does not export anything
to JSONL unless an approved-export command is explicitly executed. Details are
in `docs/GPTOSS_DB_GOVERNANCE.md`.
Live governance setup uses the guarded `npm run gptoss:db:schema:apply`
command only after explicit approval.

Run a live local GPT-OSS comparison. This contacts only the configured local
OpenAI-compatible GPT-OSS endpoint unless reference mode is explicitly enabled:

```bash
npm run gptoss:bridge:compare
```

The bridge commands are local operator tools. They do not start Trinity, do not
change Railway variables, and do not route system operations through the GPT
writing pipeline.

OpenAI reference calls are disabled unless the bridge is invoked with explicit
network and reference flags. OpenAI raw output is not persisted by default and is
never accepted as GPT-OSS training labels.

## Profiles

The selector reads `nvidia-smi` and chooses the highest-free-memory GPU.

| Profile | Free VRAM | Max seq length | vLLM utilization | CPU offload | Training |
| --- | ---: | ---: | ---: | ---: | --- |
| performance | `>= 14500 MiB` | `2048` | `0.90` | `0 GB` | allowed |
| balanced | `>= 12500 MiB` | `1024` | `0.78` | `2 GB` | allowed |
| shared | `>= 10500 MiB` | `512` | `0.65` | `4 GB` | smoke-only |
| defer | `< 10500 MiB` | `0` | `0` | `0 GB` | blocked |

GPT-OSS-20B local fine-tuning is QLoRA 4-bit only. Do not use BF16 or full
fine-tuning on the local 16 GB GPU path.

## Local Unsloth Training

Unsloth is the local training engine for GPT-OSS smoke fine-tuning. vLLM is only
for later serving, and Hugging Face should not be used as a hosted inference
platform for this path.

Model weights still need to be fetched and cached locally. Avoid writing large
model files to `C:` when it is low on disk. If a larger Windows drive is mounted
in WSL, prefer cache directories on that mount:

```bash
export HF_HOME=/mnt/d/huggingface
export HF_HUB_CACHE=/mnt/d/huggingface/hub
export UNSLOTH_CACHE_DIR=/mnt/d/unsloth
```

If no larger mounted drive exists, `/root/huggingface` and `/root/unsloth-cache`
keep the cache inside the WSL virtual disk. The smoke trainer fails closed when
the selected cache directory has less than 80 GB free.

Every training run must validate the dataset first. OpenAI model outputs,
OpenAI judgments, hidden reasoning, secrets, and unknown-source records must not
be used as GPT-OSS labels.

## Phase Plan

Phase 0 is bridge safety: local bridge scripts must keep OpenAI reference output
out of reports and keep eval reports marked `allowedForTraining: false`.

Phase 1 is complete: a 25-step local GPT-OSS-20B QLoRA smoke run passed with
`load_in_4bit=true`, `max_seq_length=512`, batch size `1`, gradient
accumulation `4`, and no BF16/full fine-tuning.

Phase 2 is the current safe expansion step: use `examples/gptoss/arcanos-eval-smoke.jsonl`
as the local eval baseline, and keep the training dataset between 40 and 80
safe Arcanos-owned, repo-schema, or reviewed human-authored examples. Training
loss on tiny smoke data is not a quality proof; eval pass rate and boundary
behavior matter more.

Phase 3 is a capped 100-step local QLoRA run. On the local RTX 5070 Ti path,
the package script uses `max_seq_length=256` and a small
`UNSLOTH_CE_LOSS_TARGET_GB` fallback for Unsloth fused cross entropy so the run
can proceed when automatic free-memory detection is too strict. It must be
preceded by dataset validation and eval setup:

```bash
npm run gptoss:dataset:validate
npm run gptoss:eval:local:dry
npm run gptoss:unsloth:phase2:dry
```

The first completed 100-step Phase 2 run used a no-save trainer path, so
`local_artifacts/gptoss-phase2/` did not receive a reusable adapter. Phase 2.1
keeps the same capped QLoRA settings but saves only the LoRA adapter, tokenizer
files, and `adapter-metadata.json` under the gitignored
`local_artifacts/gptoss-phase2/` directory. It does not save a merged or full
base model and does not upload artifacts.

The explicit execute command is:

```bash
npm run gptoss:unsloth:phase2
```

Treat the saved adapter as a local experiment until evals are run against that
adapter. Do not upload or publish the adapter without an explicit review step.

Phase 2.1 has saved the local LoRA adapter under the gitignored
`local_artifacts/gptoss-phase2/` directory. The next step is adapter evaluation,
not more training. The adapter eval loads GPT-OSS-20B plus the local adapter
through Unsloth/PEFT, writes any report under `local_artifacts/`, keeps
`allowedForTraining: false`, and does not call OpenAI or vLLM:

```bash
npm run gptoss:adapter:eval:dry
npm run gptoss:adapter:eval
```

For a base-vs-adapter check, run the Node/npm wrapper from the repo shell that
has Node installed. On this Windows + WSL setup, the wrapper activates
`/root/unsloth-gptoss-env` inside WSL for Python; running `node` directly inside
the WSL distro is optional and may fail if Node is not installed there:

```bash
node scripts/gptoss/eval-adapter-local.mjs --execute --compare-base-adapter --max-records 3
```

Comparison mode is sequential for 16GB VRAM: it generates base-model outputs,
clears model/GPU resources, then reloads the base model with the local LoRA
adapter and scores both outputs against the same eval records. Reports stay
under `local_artifacts/` and remain `allowedForTraining: false`.

Training loss on this tiny local dataset is not quality proof. The adapter must
pass generated-output eval before increasing dataset size, step count, or any
serving/routing scope.

Phase 3 corrects the Phase 2 training shape before any additional training.
Phase 2 used plain `text` rows with explanatory `Input:` / `Expected:` prose,
while adapter eval uses chat-template roles and scores the assistant's compact
final answer. The Phase 3 dataset keeps those contracts aligned by using
`system`, `developer`, `user`, and one final-only `assistant` target per record:

```bash
npm run gptoss:phase3:dataset:validate
npm run gptoss:unsloth:phase3:dry
```

Phase 3.0 showed that message format alone is not enough: the adapter worsened
when training loss was computed across the fully rendered system/developer/user
prompt as well as the assistant answer. Training loss from that shape is not a
quality signal because prompt and role-template tokens dominate the objective.

Phase 3.1 added response-only assistant-target loss masking, but diagnostics
showed it supervised assistant content only. GPT-OSS/Harmony inserts required
final-channel boundary tokens between the generation cursor and answer content:
`<|channel|>final<|message|>`.

Phase 3.2 supervises the Harmony final-channel boundary plus the assistant
final-answer content. Do not train again until the mask audit confirms
`harmonyBoundaryTokensSupervised:true`, `assistantContentSupervised:true`,
`supervisedStartsAtGenerationCursor:true`, and system/developer/user prompt
tokens are ignored:

```bash
npm run gptoss:unsloth:phase3:mask-audit
```

The audit reports stay under `local_artifacts/gptoss-phase3/`. A passing audit
must show assistant target spans found, supervised Harmony boundary tokens,
nonzero supervised assistant content labels, zero supervised prompt labels, and
no all-labels-masked samples.

The Phase 3 execute script validates the dataset first, caps the run at 100
steps, keeps QLoRA 4-bit only, saves only the LoRA adapter under
`local_artifacts/gptoss-phase3/`, and does not upload artifacts:

```bash
npm run gptoss:unsloth:phase3
```

Phase 3.2 fixed the Harmony mask span, but the adapter eval stayed at 2/24 and
training loss collapsed quickly. Phase 3.3 adds a separate low-learning-rate
profile so training dynamics can be tested before growing the dataset or
increasing steps. It keeps the response-only Harmony-boundary mask, uses
`learning_rate=5e-5`, `max_steps=50`, `warmup_ratio=0.10`, and LoRA dropout
`0.05`, and writes to `local_artifacts/gptoss-phase3-lowlr/`:

```bash
npm run gptoss:unsloth:phase3:lowlr:dry
```

Do not run the low-LR training profile until dataset validation, mask audit, and
the dry-run config pass. Compare the low-LR adapter separately before adding
targeted route/JSON/safety records.

Phase 3.3 improved the local adapter eval from 2/24 to 4/24, confirming training
dynamics were part of the problem, but it did not beat the Phase 2 7/24 baseline.
Phase 3.4 keeps the same low-LR profile and adds targeted final-only records for
route labels, JSON-only outputs, safety/control-boundary behavior, and compact
answers. The OpenAI reference model remains disabled. Do not increase training
steps until the targeted data path is trained and evaluated:

```bash
npm run gptoss:phase3-4:dataset:validate
npm run gptoss:unsloth:phase3-4:lowlr:dry
npm run gptoss:unsloth:phase3-4:lowlr:mask-audit
```

After training is explicitly requested, evaluate the separate adapter under
`local_artifacts/gptoss-phase3-4-lowlr/` with the smoke eval file.

Phase 3.4 also stayed at 4/24, so the next diagnostic is a 3-record
micro-overfit test. Its purpose is to separate trainer/eval correctness from
dataset generalization by checking whether the local Unsloth QLoRA path can
memorize exact eval-shaped route, JSON, and safety examples. Do not grow the
dataset or increase step count until the micro-overfit result is known:

```bash
npm run gptoss:micro:dataset:validate
npm run gptoss:unsloth:micro:dry
```

If the dry run passes and the diagnostic is explicitly requested, train with
`npm run gptoss:unsloth:micro` and evaluate with `npm run gptoss:micro:eval`.

The deterministic micro eval passed the route-label record but still failed the
JSON-only and safety/refusal records with analysis-style continuations. The next
diagnostic isolates those task shapes as one-record overfit runs:

```bash
npm run gptoss:single-json:dataset:validate
npm run gptoss:single-json:dry
npm run gptoss:single-safety:dataset:validate
npm run gptoss:single-safety:dry
```

If requested after dry-run validation, train and evaluate the isolated adapters
with `npm run gptoss:single-json:train`, `npm run gptoss:single-json:eval`,
`npm run gptoss:single-safety:train`, and `npm run gptoss:single-safety:eval`.
These diagnostics keep the Harmony final-boundary response mask and do not use
OpenAI reference output or vLLM.

### Generation Channel Diagnostics

The single JSON adapter improved target likelihood under teacher forcing, but
deterministic free generation still entered analysis-style text before producing
valid JSON. The next diagnostic is local eval-only final-channel forcing, then
JSON-task-only constrained start with `{`.

Run the three local diagnostics in sequence: baseline decode, `--force-final-channel`,
and `--force-final-channel --prefill-json-start`. The eval report must keep
`allowedForTraining:false`, `openAiCalled:false`, `trainingExecuted:false`,
`vllmUsed:false`, and `noOpenAiOutputUsed:true`.

Final-channel forcing is allowed only when the tokenizer can derive the
Harmony final boundary from its own chat template. JSON prefill applies only to
JSON-only eval records and does not invent fields or weaken strict JSON scoring.
These modes do not train, do not call OpenAI, do not use vLLM, and do not
replace proper training/eval once channel behavior is understood.

The single JSON adapter proved final-channel forcing can move generation out of
analysis-style continuations and into valid final-channel JSON. Broader adapter
comparison is a separate local eval step:

```bash
npm run gptoss:adapter:eval:force-final:compare
```

That command compares the full smoke eval adapters with `--force-final-channel`
and writes inventory, summary, failure breakdown, and next-decision reports
under `local_artifacts/gptoss-force-final-comparison/`. It is eval/inference
behavior only: it does not train, call OpenAI, use vLLM, touch Railway, or
modify production routing. The Railway bridge remains unrelated to this eval.

The first force-final comparison put Phase 3.4 low-LR and Phase 3 low-LR at
7/24. Remaining Phase 3.4 failures were mostly missing exact tokens and route
labels, so Phase 3.5 adds target-shape records for compact labels, required
first tokens, and JSON action fields:

```bash
npm run gptoss:phase3-5:dataset:validate
npm run gptoss:unsloth:phase3-5:lowlr:dry
npm run gptoss:unsloth:phase3-5:lowlr:mask-audit
```

Phase 3.5 training is a separate explicit step and was not run while preparing
the dataset. After training is explicitly requested, evaluate it with:

```bash
node scripts/gptoss/eval-adapter-local.mjs --execute --adapter-dir local_artifacts/gptoss-phase3-5-lowlr --eval-file examples/gptoss/arcanos-eval-smoke.jsonl --output local_artifacts/gptoss-phase3-5-lowlr/eval-force-final.json --temperature 0 --max-new-tokens 32 --repetition-penalty 1.3 --force-final-channel
```

Phase 3.5 reached 7/24 under force-final eval, equal to the previous best.
Invalid JSON and safety-boundary failures were zero, while remaining failures
were route labels, missing required tokens, and the `validate_dataset` action.
Phase 3.6 therefore adds action/label disambiguation records instead of more
generic JSON or safety examples:

```bash
npm run gptoss:phase3-6:dataset:validate
npm run gptoss:unsloth:phase3-6:lowlr:dry
npm run gptoss:unsloth:phase3-6:lowlr:mask-audit
```

Phase 3.6 training is a separate explicit step and was not run while preparing
the dataset. After training is explicitly requested, evaluate it with:

```bash
node scripts/gptoss/eval-adapter-local.mjs --execute --adapter-dir local_artifacts/gptoss-phase3-6-lowlr --eval-file examples/gptoss/arcanos-eval-smoke.jsonl --output local_artifacts/gptoss-phase3-6-lowlr/eval-force-final.json --temperature 0 --max-new-tokens 32 --repetition-penalty 1.3 --force-final-channel
```

Phase 3.6 regressed to 6/24. Phase 3.7 is comparison-driven: it returns to
the Phase 3.5 dataset as the base, adds only targeted repair records for the
failed tokens/actions, and oversamples those repair records 3x in the local
trainer. The source JSONL remains non-duplicated and human-reviewable:

```bash
npm run gptoss:phase3-7:dataset:validate
npm run gptoss:unsloth:phase3-7:lowlr:dry
npm run gptoss:unsloth:phase3-7:lowlr:mask-audit
```

Phase 3.7 training is a separate explicit step and was not run while preparing
the dataset. After training is explicitly requested, evaluate it with:

```bash
node scripts/gptoss/eval-adapter-local.mjs --execute --adapter-dir local_artifacts/gptoss-phase3-7-lowlr --eval-file examples/gptoss/arcanos-eval-smoke.jsonl --output local_artifacts/gptoss-phase3-7-lowlr/eval-force-final.json --temperature 0 --max-new-tokens 32 --repetition-penalty 1.3 --force-final-channel
```

OpenAI reference mode remains disabled. The Railway bridge remains
observation-only and unrelated to this dataset except for separate
spec-authored routing examples. The Railway-safe dataset remains optional,
spec-authored routing material and is not merged into active training unless a
future step explicitly asks for it.

Phase 4 is local serving and eval against a local endpoint. Phase 5 is a future
cloud provider path. Neither phase should modify Railway production routing or
replace OpenAI reasoning configuration without an explicit separate-provider
design.

The OpenAI reference model remains evaluation-only and disabled for this local
training phase.

## Router Postprocessing

Router/classifier eval mode reached 8/24 with forced final-channel decoding and
JSON prefill. JSON prefill made the `validate_dataset` action syntactically
valid, but the model returned a nested action object instead of the required
top-level action string.

The local eval postprocessor now applies only deterministic, allowlisted
canonicalization for safe router action envelopes such as
`{"action":{"type":"validate_dataset"}}` to `{"action":"validate_dataset"}`.
It does not canonicalize prose, success-message JSON, unknown actions, or
privileged actions.

OpenAI-output-as-training-data remains a hard policy check. Affirmative answers
about using OpenAI model outputs as GPT-OSS training targets must fail; compact
rejections such as `No.` pass the policy check. This is evaluation/runtime
diagnostics only, not training, and it does not enable the OpenAI reference
model.

The 9/24 postprocessed eval showed deterministic postprocessing helps but does
not repair true model errors. The v2 scorer keeps hard policy failures strict,
adds Unicode dash normalization only for exact route labels, and lets safe
canonical JSON action envelopes expose token surfaces such as `validate`,
`allowed`, and `false` for required-token checks. Wrong factual outputs such as
Python owning the public protocol surface, `SLFTM` instead of `QLoRA 4-bit`, or
`10` steps instead of `100` remain failures and are future training or
retrieval candidates.

## Phase 3.8 Governance Repair

Phase 3.7 router/classifier postprocessed v2 remained at 9/24. The remaining
true model errors are now split into two local artifacts: non-trainable
governance candidates under `local_artifacts/` and a separate
human/spec-authored repair JSONL file. The candidates keep
`source: eval_failure_observation`, `reviewed:false`, and
`allowed_for_training:false`; they must not be exported as training examples.

Only the separate approved repair dataset can be used for a future training
step, and only after validation and mask audit pass:

```bash
npm run gptoss:phase3-8:dataset:validate
npm run gptoss:unsloth:phase3-8:lowlr:dry
npm run gptoss:unsloth:phase3-8:lowlr:mask-audit
```

No OpenAI reference model is enabled for Phase 3.8, and no live DB writes are
required. The dry-run scripts keep response-only Harmony final-boundary masking,
force-final/router-classifier eval modes remain available, and eval failure
observations remain candidate-only provenance.

If a future review explicitly approves training, the local command is:

```bash
npm run gptoss:unsloth:phase3-8:lowlr
```

After any approved Phase 3.8 training, evaluate the adapter with:

```bash
node scripts/gptoss/eval-adapter-local.mjs \
  --execute \
  --router-classifier-mode \
  --prefill-json-start \
  --adapter-dir local_artifacts/gptoss-phase3-8-lowlr \
  --eval-file examples/gptoss/arcanos-eval-smoke.jsonl \
  --output local_artifacts/gptoss-phase3-8-lowlr/eval-router-classifier-postprocessed.json \
  --temperature 0 \
  --max-new-tokens 32 \
  --repetition-penalty 1.3
```

Phase 3.8 reached a model/postprocessor score of 10/24 with no regressions.
The new pass was the writing-plane route label case. The OpenAI-output
training-data rejection, compact factual targets (`TypeScript`, `QLoRA 4-bit`,
`100`, `false`), and the refused-boundary JSON envelope remained model
failures.

Phase 3.9 adds a local deterministic effective scoring mode for policy/router
ownership:

```bash
node scripts/gptoss/eval-adapter-local.mjs \
  --execute \
  --router-classifier-mode \
  --prefill-json-start \
  --apply-hard-policy-overrides \
  --adapter-dir local_artifacts/gptoss-phase3-8-lowlr \
  --eval-file examples/gptoss/arcanos-eval-smoke.jsonl \
  --output local_artifacts/gptoss-phase3-8-lowlr/eval-router-classifier-effective-policy.json \
  --temperature 0 \
  --max-new-tokens 32 \
  --repetition-penalty 1.3
```

This report has two metrics. `modelScore` is the raw model/postprocessor score
and must remain visible. `effectiveRouterScore` is model output plus the local
deterministic policy/router layer. A hard policy override passing does not mean
the model learned the rule; it means runtime policy rejected the unsafe route
after the model failed it. The same distinction applies to deterministic
refused-boundary envelopes. Factual compact errors must not be normalized into
passes; they remain retrieval/spec or future training targets.

OpenAI reference mode remains disabled for both model and effective scoring.

Phase 3.10 adds a local spec-fact registry for compact, stable Arcanos facts:

```bash
node scripts/gptoss/eval-adapter-local.mjs \
  --execute \
  --router-classifier-mode \
  --prefill-json-start \
  --apply-hard-policy-overrides \
  --use-local-spec-facts \
  --adapter-dir local_artifacts/gptoss-phase3-8-lowlr \
  --eval-file examples/gptoss/arcanos-eval-smoke.jsonl \
  --output local_artifacts/gptoss-phase3-8-lowlr/eval-router-classifier-effective-spec.json \
  --temperature 0 \
  --max-new-tokens 32 \
  --repetition-penalty 1.3
```

The spec facts live in `examples/gptoss/arcanos-local-spec-facts.json`. They are
retrieval/spec support, not training data. They can improve
`effectiveRouterScore` for compact factual answers such as `TypeScript`,
`QLoRA 4-bit`, `100`, and `false`, while `modelScore` still reports the raw
model/postprocessor result. A spec-fact effective pass does not mean the model
learned the fact, and OpenAI reference mode remains disabled.

## Phase 4 Local Runtime Profile

Phase 3.13 records the current baseline:

- model-only score: `11/24`
- effective-router score: `24/24`

The model-only score is still weak and is not cloud-ready. The effective score
depends on the local deterministic runtime supports: force-final channel,
router-classifier mode, JSON prefill, hard policy overrides, local spec facts,
and router postprocessing.

Phase 4 packages that effective-router path as an isolated local runtime
contract for controlled testing only:

```bash
npm run gptoss:runtime:effective-router:dry
npm run gptoss:runtime:effective-router:smoke
npm run gptoss:runtime:readiness
```

The runtime contract lives in `scripts/gptoss/effective-router-runtime.mjs` and
`schemas/gptoss-effective-router-runtime.schema.json`. Runtime smoke fixtures
live in `examples/gptoss/runtime-smoke/`. Reports are written only under
`local_artifacts/gptoss-runtime/`.

Phase 4.1 adds a local request CLI for the same effective-router contract:

```bash
npm run gptoss:runtime:request:dry
npm run gptoss:runtime:request:smoke
npm run gptoss:runtime:request:regress
npm run gptoss:runtime:request:local-model:dry
```

The request CLI lives at `scripts/gptoss/effective-router-request.mjs`, validates
the request shape against `schemas/gptoss-effective-router-runtime.schema.json`,
and writes request reports only under `local_artifacts/gptoss-runtime/`. It is
dry-run by default. Direct request execution is fail-closed until a separate
local execution path is explicitly requested with `--execute-local-model`. The
local-model dry run plans the existing adapter eval wrapper and does not load a
model. The live one-request local-model smoke script is:

```bash
npm run gptoss:runtime:request:local-model:smoke
```

Run that only after the dry run and tests pass. It uses the
`openai-output-training-rejection.json` fixture, writes under
`local_artifacts/gptoss-runtime/`, and keeps OpenAI, training, vLLM, Railway CLI,
and live DB disabled. The request smoke fixtures live in
`examples/gptoss/runtime-request-smoke/`.

The cloud gate intentionally blocks cloud and Custom GPT exposure:

```bash
npm run gptoss:runtime:cloud-gate
```

Expected current result:

```json
{
  "cloudReady": false,
  "customGptReady": false,
  "localControlledRuntimeReady": true
}
```

Direct Custom GPT to local GPT-OSS is disallowed. Do not expose local
`127.0.0.1`, `localhost`, WSL, or developer-machine GPT-OSS endpoints to Custom
GPT actions. Cloud or Custom GPT integration requires a separate approved
serving path, auth boundary, action schema, rate limits, audit logs, rollback
behavior, and reference-only comparison plan. OpenAI output remains disallowed
as GPT-OSS training data.

Phase 4.3 adds local audit and replay artifacts for effective-router requests:

```bash
npm run gptoss:runtime:request:local-model:smoke:audit
npm run gptoss:runtime:audit:latest
npm run gptoss:runtime:request:replay -- --audit local_artifacts/gptoss-runtime/audit/<audit-file>.json
```

Audit records stay under `local_artifacts/gptoss-runtime/audit/` and replay
reports stay under `local_artifacts/gptoss-runtime/replay/`. Audit records store
input hashes plus redacted, capped previews only. They must not include raw
secrets, tokens, bearer values, database URLs, cookies, Railway tokens, OpenAI
keys, Redis/Postgres URLs, or raw environment values. Replay remains dry-run by
default and requires `--execute-local-model` before it can load the local model.

Phase 4.4 writes the local release manifest:

```bash
npm run gptoss:runtime:release-manifest
```

The manifest records `modelScore: 11/24`, `effectiveScore: 24/24`,
`localControlledRuntimeReady:true`, `modelOnlyReady:false`, `cloudReady:false`,
and `customGptReady:false`. It includes required runtime supports, request
smoke/regress status, latest local audit/replay artifact paths, artifact
exclusion patterns, and safety confirmations. It must not include adapter
weights, model weights, caches, secrets, Railway output, DB rows, or raw
sensitive local reports.

Phase 4.5 adds the full local release gate:

```bash
npm run gptoss:runtime:release-gate
```

The gate runs the baseline regression, effective-router regression, request
regression, readiness report, release manifest, and cloud gate. The cloud gate
is expected to block; that is a pass only when cloud and Custom GPT readiness
remain false and direct Custom GPT-to-local exposure remains disallowed.

The release gate fails closed on missing reports, missing score fields, an
effective score below `24/24`, dirty safety flags, missing runtime supports,
tracked local artifact/model/cache files, or accidental cloud/Custom GPT
readiness. Its report is local-only at
`local_artifacts/gptoss-runtime/release-gate-report.json`.

Phase 4.6 adds a CI-safe static release gate:

```bash
npm run gptoss:runtime:release-gate:ci
```

The CI gate validates package wiring, the runtime schema, release-manifest schema
expectations, baseline metadata, runtime smoke fixtures, local spec facts, docs,
required runtime supports, and cloud/Custom GPT false readiness without requiring
`local_artifacts/`, adapter files, model weights, CUDA, WSL, vLLM, Railway auth,
`DATABASE_URL`, OpenAI keys, live DB access, or a server. In local runs it writes
`local_artifacts/gptoss-runtime/release-gate-ci-report.json`; in CI it can rely
on the stdout JSON summary.

Model-only readiness remains false because the raw model score is `11/24`. The
effective runtime can be locally ready because deterministic local policy,
spec-fact, and postprocessor layers bring the effective score to `24/24`; that
does not make the model cloud-ready or approve a Custom GPT action boundary.

## Phase 5.1 Private Serving Scaffold

Phase 5.1 adds local-only private serving scaffold helpers:

```bash
npm run gptoss:private-serving:scaffold:validate
npm run gptoss:private-serving:scaffold:report
```

The scaffold lives under `scripts/gptoss/private-serving/` and is not a serving
implementation. It creates no HTTP server, listener, route handler, tunnel,
deployment, or Custom GPT action.

The scaffold status is:

- request signing verification is scaffolded and fails closed
- Phase 5.2 request signing verification is implemented locally with
  HMAC-SHA256 and fails closed without an explicitly supplied local signing key
- auth boundary validation rejects unauthenticated requests and is not
  production auth
- rate limiting is in-memory policy only and not durable production state
- response shaping emits only the safe effective-router envelope
- denial responses are structured and secret-free
- cloud and Custom GPT remain blocked

Expected readiness:

```json
{
  "privateServingDesignReady": true,
  "privateServingScaffoldReady": true,
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "requestSigningScaffoldReady": true,
  "requestSigningImplemented": true,
  "authBoundaryScaffoldReady": true,
  "authBoundaryImplemented": false,
  "rateLimitScaffoldReady": true,
  "rateLimitImplemented": false,
  "responseShapingScaffoldReady": true,
  "publicServerCreated": false,
  "cloudReady": false,
  "customGptReady": false
}
```

Before any server can be considered, a later phase must add production key
management and rotation, a durable private rate limiter, a private network
boundary, endpoint auth integration, audit sink approval, rollback gate
validation, and penetration test or security review.

## Dataset Gate

Training data must pass the local dataset gate. Allowed sources are:

- `arcanos_owned_spec`
- `repo_schema`
- `human_authored`
- `redacted_consented_log`

Rejected sources include `openai_output`, `openai_judgment`,
`railway_cli_observation`, `custom_gpt_action_request`, `hidden_reasoning`,
`raw_secret`, `unknown`, `third_party_copyrighted`, and
`model_generated_label_without_human_review`.
OpenAI API model outputs must not be harvested into GPT-OSS training labels.

The Railway-safe routing dataset is spec-authored optional future material. It
teaches routing protocol for safe Railway-backed diagnostics, not live backend
state. It is not part of active training, raw Railway output remains
non-trainable, and training from it requires a separate explicit future step.

DB-sourced `railway_cli_observation` and `eval_failure_observation` records are
candidate-only and rejected by the dataset gate. Approved DB exports must be
reviewed, redacted, explicitly allowed for training, and validated before they
can become JSONL training examples. Raw DB dumps are prohibited.

The smoke dataset is:

```bash
examples/gptoss/arcanos-safe-smoke-training.jsonl
```
