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

Phase 4 is local serving and eval against a local endpoint. Phase 5 is a future
cloud provider path. Neither phase should modify Railway production routing or
replace OpenAI reasoning configuration without an explicit separate-provider
design.

The OpenAI reference model remains evaluation-only and disabled for this local
training phase.

## Dataset Gate

Training data must pass the local dataset gate. Allowed sources are:

- `arcanos_owned_spec`
- `repo_schema`
- `human_authored`
- `redacted_consented_log`

Rejected sources include `openai_output`, `openai_judgment`,
`custom_gpt_action_request`, `hidden_reasoning`, `raw_secret`, `unknown`,
`third_party_copyrighted`, and `model_generated_label_without_human_review`.
OpenAI API model outputs must not be harvested into GPT-OSS training labels.

The smoke dataset is:

```bash
examples/gptoss/arcanos-safe-smoke-training.jsonl
```
