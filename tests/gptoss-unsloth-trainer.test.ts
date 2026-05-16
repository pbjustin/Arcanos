import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const trainerSource = readFileSync(join(process.cwd(), 'scripts', 'gptoss', 'unsloth-train-smoke.py'), 'utf8');

describe('gptoss Unsloth trainer artifact policy', () => {
  it('enables adapter saving for the phase2 dry-run and execute commands', () => {
    expect(packageJson.scripts['gptoss:unsloth:phase2:dry']).toContain('--save-adapter');
    expect(packageJson.scripts['gptoss:unsloth:phase2']).toContain('--save-adapter');
    expect(packageJson.scripts['gptoss:unsloth:phase2']).toContain('local_artifacts/gptoss-phase2');
  });

  it('defines phase3 dataset validation and dry-run commands', () => {
    expect(packageJson.scripts['gptoss:phase3:dataset:validate']).toContain('examples/gptoss/arcanos-phase3-training.jsonl');
    expect(packageJson.scripts['gptoss:unsloth:phase3:dry']).toContain('--dataset examples/gptoss/arcanos-phase3-training.jsonl');
    expect(packageJson.scripts['gptoss:unsloth:phase3:dry']).toContain('--output-dir local_artifacts/gptoss-phase3');
    expect(packageJson.scripts['gptoss:unsloth:phase3:dry']).toContain('--max-seq-length 256');
    expect(packageJson.scripts['gptoss:unsloth:phase3:mask-audit']).toContain('--mask-audit');
    expect(packageJson.scripts['gptoss:unsloth:phase3']).toContain('gptoss:phase3:dataset:validate');
    expect(packageJson.scripts['gptoss:unsloth:phase3']).toContain('--save-adapter');
  });

  it('defines phase3 low-learning-rate controls without overwriting phase3 artifacts', () => {
    const dryScript = packageJson.scripts['gptoss:unsloth:phase3:lowlr:dry'];
    const executeScript = packageJson.scripts['gptoss:unsloth:phase3:lowlr'];

    expect(dryScript).toContain('--learning-rate 5e-5');
    expect(dryScript).toContain('--max-steps 50');
    expect(dryScript).toContain('--warmup-ratio 0.10');
    expect(dryScript).toContain('--lora-dropout 0.05');
    expect(dryScript).toContain('--lora-r 16');
    expect(dryScript).toContain('--lora-alpha 16');
    expect(dryScript).toContain('--output-dir local_artifacts/gptoss-phase3-lowlr');
    expect(executeScript).toContain('gptoss:phase3:dataset:validate');
    expect(executeScript).toContain('--execute');
    expect(executeScript).toContain('--output-dir local_artifacts/gptoss-phase3-lowlr');
  });

  it('defines phase3.4 targeted-data low-learning-rate controls', () => {
    const dryScript = packageJson.scripts['gptoss:unsloth:phase3-4:lowlr:dry'];
    const maskAuditScript = packageJson.scripts['gptoss:unsloth:phase3-4:lowlr:mask-audit'];
    const executeScript = packageJson.scripts['gptoss:unsloth:phase3-4:lowlr'];

    expect(packageJson.scripts['gptoss:phase3-4:dataset:validate']).toContain('examples/gptoss/arcanos-phase3-4-training.jsonl');
    expect(dryScript).toContain('--dataset examples/gptoss/arcanos-phase3-4-training.jsonl');
    expect(dryScript).toContain('--learning-rate 5e-5');
    expect(dryScript).toContain('--max-steps 50');
    expect(dryScript).toContain('--max-samples 80');
    expect(dryScript).toContain('--warmup-ratio 0.10');
    expect(dryScript).toContain('--lora-dropout 0.05');
    expect(dryScript).toContain('--output-dir local_artifacts/gptoss-phase3-4-lowlr');
    expect(maskAuditScript).toContain('--mask-audit');
    expect(maskAuditScript).toContain('--output-dir local_artifacts/gptoss-phase3-4-lowlr');
    expect(executeScript).toContain('gptoss:phase3-4:dataset:validate');
    expect(executeScript).toContain('--execute');
    expect(executeScript).toContain('--save-adapter');
    expect(executeScript).toContain('--output-dir local_artifacts/gptoss-phase3-4-lowlr');
  });

  it('defines micro-overfit training and eval scripts', () => {
    const dryScript = packageJson.scripts['gptoss:unsloth:micro:dry'];
    const executeScript = packageJson.scripts['gptoss:unsloth:micro'];
    const evalScript = packageJson.scripts['gptoss:micro:eval'];

    expect(packageJson.scripts['gptoss:micro:dataset:validate']).toContain('examples/gptoss/arcanos-micro-overfit-training.jsonl');
    expect(dryScript).toContain('--dataset examples/gptoss/arcanos-micro-overfit-training.jsonl');
    expect(dryScript).toContain('--max-steps 75');
    expect(dryScript).toContain('--max-samples 3');
    expect(dryScript).toContain('--learning-rate 2e-5');
    expect(dryScript).toContain('--lora-r 8');
    expect(dryScript).toContain('--output-dir local_artifacts/gptoss-micro-overfit');
    expect(dryScript).not.toContain('--execute');
    expect(executeScript).toContain('gptoss:micro:dataset:validate');
    expect(executeScript).toContain('--execute');
    expect(executeScript).toContain('--save-adapter');
    expect(evalScript).toContain('scripts/gptoss/eval-adapter-local.mjs');
    expect(evalScript).toContain('--adapter-dir local_artifacts/gptoss-micro-overfit');
    expect(evalScript).toContain('--eval-file examples/gptoss/arcanos-micro-overfit-eval.jsonl');
    expect(evalScript).toContain('--output local_artifacts/gptoss-micro-overfit/eval-report.json');
  });

  it('defines single-record JSON and safety overfit diagnostics', () => {
    const jsonDryScript = packageJson.scripts['gptoss:single-json:dry'];
    const jsonTrainScript = packageJson.scripts['gptoss:single-json:train'];
    const jsonEvalScript = packageJson.scripts['gptoss:single-json:eval'];
    const safetyDryScript = packageJson.scripts['gptoss:single-safety:dry'];
    const safetyTrainScript = packageJson.scripts['gptoss:single-safety:train'];
    const safetyEvalScript = packageJson.scripts['gptoss:single-safety:eval'];

    expect(packageJson.scripts['gptoss:single-json:dataset:validate']).toContain('examples/gptoss/arcanos-single-json-overfit-training.jsonl');
    expect(jsonDryScript).toContain('--dataset examples/gptoss/arcanos-single-json-overfit-training.jsonl');
    expect(jsonDryScript).toContain('--max-steps 150');
    expect(jsonDryScript).toContain('--max-samples 1');
    expect(jsonDryScript).toContain('--learning-rate 1e-4');
    expect(jsonDryScript).toContain('--warmup-ratio 0.0');
    expect(jsonDryScript).toContain('--lora-dropout 0');
    expect(jsonDryScript).toContain('--lora-r 16');
    expect(jsonDryScript).toContain('--output-dir local_artifacts/gptoss-single-json-overfit');
    expect(jsonDryScript).not.toContain('--execute');
    expect(jsonTrainScript).toContain('gptoss:single-json:dataset:validate');
    expect(jsonTrainScript).toContain('--execute');
    expect(jsonEvalScript).toContain('--temperature 0');
    expect(jsonEvalScript).toContain('--max-new-tokens 32');
    expect(jsonEvalScript).toContain('--repetition-penalty 1.3');

    expect(packageJson.scripts['gptoss:single-safety:dataset:validate']).toContain('examples/gptoss/arcanos-single-safety-overfit-training.jsonl');
    expect(safetyDryScript).toContain('--dataset examples/gptoss/arcanos-single-safety-overfit-training.jsonl');
    expect(safetyDryScript).toContain('--max-steps 150');
    expect(safetyDryScript).toContain('--learning-rate 1e-4');
    expect(safetyDryScript).toContain('--lora-r 16');
    expect(safetyDryScript).toContain('--output-dir local_artifacts/gptoss-single-safety-overfit');
    expect(safetyTrainScript).toContain('gptoss:single-safety:dataset:validate');
    expect(safetyTrainScript).toContain('--execute');
    expect(safetyEvalScript).toContain('--temperature 0');
    expect(safetyEvalScript).toContain('--adapter-dir local_artifacts/gptoss-single-safety-overfit');
  });

  it('counts and renders messages-format records for trainer ingestion', () => {
    expect(trainerSource).toContain('"messagesFormatRecords": message_count');
    expect(trainerSource).toContain('build_response_only_training_example(record, tokenizer, options.max_seq_length)');
    expect(trainerSource).toContain('tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)');
    expect(trainerSource).toContain('messages must contain exactly one assistant target');
  });

  it('builds response-only labels and fails closed before phase3 training', () => {
    expect(trainerSource).toContain('"responseOnlyTrainingEnabled": mask_audit["responseOnlyTrainingEnabled"]');
    expect(trainerSource).toContain('labels = [-100] * len(input_ids)');
    expect(trainerSource).toContain('labels[index] = input_ids[index]');
    expect(trainerSource).toContain('raise ValueError(f"{record.get(\'id\', \'<unknown>\')}: all labels are masked")');
    expect(trainerSource).toContain('raise ValueError("assistant target token span was not found")');
    expect(trainerSource).toContain('"promptTokensSupervised": prompt_tokens_supervised');
    expect(trainerSource).toContain('"maskStrategy": "harmony_final_boundary_plus_content"');
    expect(trainerSource).toContain('"harmonyBoundaryTokensSupervised": harmony_boundary_supervised');
    expect(trainerSource).toContain('"supervisedStartsAtGenerationCursor": supervised_starts_at_generation_cursor');
    expect(trainerSource).toContain('"openAiReferenceCalled": False');
    expect(trainerSource).not.toContain('api.openai.com');
  });

  it('exposes configurable low-learning-rate hyperparameters in config and metadata', () => {
    expect(trainerSource).toContain('ARCANOS_UNSLOTH_LEARNING_RATE');
    expect(trainerSource).toContain('ARCANOS_UNSLOTH_MAX_STEPS');
    expect(trainerSource).toContain('ARCANOS_UNSLOTH_WARMUP_RATIO');
    expect(trainerSource).toContain('ARCANOS_UNSLOTH_LORA_DROPOUT');
    expect(trainerSource).toContain('ARCANOS_UNSLOTH_LORA_R');
    expect(trainerSource).toContain('ARCANOS_UNSLOTH_LORA_ALPHA');
    expect(trainerSource).toContain('"learning_rate": options.learning_rate');
    expect(trainerSource).toContain('"warmup_ratio": options.warmup_ratio');
    expect(trainerSource).toContain('"lora_dropout": options.lora_dropout');
    expect(trainerSource).toContain('r=options.lora_r');
    expect(trainerSource).toContain('lora_alpha=options.lora_alpha');
    expect(trainerSource).toContain('lora_dropout=options.lora_dropout');
    expect(trainerSource).toContain('"learningRate": options.learning_rate');
    expect(trainerSource).toContain('"warmupRatio": options.warmup_ratio');
    expect(trainerSource).toContain('"loraDropout": options.lora_dropout');
    expect(trainerSource).toContain('"loraR": options.lora_r');
    expect(trainerSource).toContain('"loraAlpha": options.lora_alpha');
    expect(trainerSource).toContain('return "phase3-lowlr"');
    expect(trainerSource).toContain('return "phase3-4-lowlr"');
    expect(trainerSource).toContain('return "micro-overfit"');
    expect(trainerSource).toContain('return "single-json-overfit"');
    expect(trainerSource).toContain('return "single-safety-overfit"');
  });

  it('masks prompt tokens and supervises Harmony final boundary plus assistant target tokens', () => {
    const helper = `
import importlib.util
from pathlib import Path
module_path = Path("scripts/gptoss/unsloth-train-smoke.py")
spec = importlib.util.spec_from_file_location("unsloth_train_smoke", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeTokenizer:
    chat_template = "fake"
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        text = ""
        for message in messages:
            text += f"<|start|>{message['role']}"
            if message["role"] == "assistant":
                text += f"<|channel|>final<|message|>{message['content']}<|end|>"
            else:
                text += f"<|message|>{message['content']}<|end|>"
        if add_generation_prompt:
            text += "<|start|>assistant"
        return text
    def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None):
        ids = [ord(ch) for ch in text]
        if truncation and max_length is not None:
            ids = ids[:max_length]
        return {"input_ids": ids, "attention_mask": [1] * len(ids)}
    def decode(self, ids, skip_special_tokens=False):
        return "".join(chr(i) for i in ids)

record = {
    "id": "unit-mask",
    "source": "human_authored",
    "messages": [
        {"role": "system", "content": "Return only final."},
        {"role": "developer", "content": "Use boundaries."},
        {"role": "user", "content": "Classify queue status."},
        {"role": "assistant", "content": "control-plane"},
    ],
}
example = module.build_response_only_training_example(record, FakeTokenizer(), 4096)
labels = example["labels"]
cursor = example["generationCursorTokenStart"]
assistant_start = example["assistantTokenStart"]
end = example["assistantTokenEnd"]
assert example["supervisedTokenStart"] == cursor
assert cursor < assistant_start
assert all(label == -100 for label in labels[:cursor])
assert all(label != -100 for label in labels[cursor:end])
assert all(label == -100 for label in labels[end:])
decoded = FakeTokenizer().decode([label for label in labels if label != -100])
assert decoded == "<|channel|>final<|message|>control-plane"
assert "Return only final." not in decoded
assert "Use boundaries." not in decoded
assert "Classify queue status." not in decoded
`;
    const completed = spawnSync('python', ['-c', helper], { cwd: process.cwd(), encoding: 'utf8' });

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
  });

  it('fails closed when the assistant target span is missing or fully masked', () => {
    const helper = `
import importlib.util
from pathlib import Path
module_path = Path("scripts/gptoss/unsloth-train-smoke.py")
spec = importlib.util.spec_from_file_location("unsloth_train_smoke", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class MissingTargetTokenizer:
    chat_template = "fake"
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        return "<|start|>assistant<|message|>different<|end|>"
    def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None):
        return {"input_ids": [ord(ch) for ch in text], "attention_mask": [1] * len(text)}
    def decode(self, ids, skip_special_tokens=False):
        return "".join(chr(i) for i in ids)

class TruncatingTokenizer(MissingTargetTokenizer):
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        text = "prompt <|start|>assistant<|channel|>final<|message|>" + messages[-1]["content"]
        if add_generation_prompt:
            return "prompt <|start|>assistant"
        return text
    def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None):
        ids = [ord(ch) for ch in text]
        if truncation and max_length is not None:
            ids = ids[:max_length]
        return {"input_ids": ids, "attention_mask": [1] * len(ids)}

record = {
    "id": "unit-mask-fail",
    "source": "human_authored",
    "messages": [
        {"role": "user", "content": "Classify queue status."},
        {"role": "assistant", "content": "control-plane"},
    ],
}
try:
    module.build_response_only_training_example(record, MissingTargetTokenizer(), 4096)
    raise AssertionError("missing target did not fail")
except ValueError as error:
    assert "assistant target span was not found" in str(error)

try:
    module.build_response_only_training_example(record, TruncatingTokenizer(), 4)
    raise AssertionError("truncated target did not fail")
except ValueError as error:
    assert "assistant target token span was not found" in str(error)

class MissingBoundaryTokenizer(MissingTargetTokenizer):
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        text = ""
        for message in messages:
            if message["role"] == "assistant":
                text += f"<|start|>{message['role']}{message['content']}<|end|>"
            else:
                text += f"<|start|>{message['role']}<|message|>{message['content']}<|end|>"
        if add_generation_prompt:
            text += "<|start|>assistant"
        return text

try:
    module.build_response_only_training_example(record, MissingBoundaryTokenizer(), 4096)
    raise AssertionError("missing boundary did not fail")
except ValueError as error:
    assert "Harmony final boundary tokens were not found" in str(error)
`;
    const completed = spawnSync('python', ['-c', helper], { cwd: process.cwd(), encoding: 'utf8' });

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
  });

  it('plans adapter metadata under the local phase2 artifact path', () => {
    expect(trainerSource).toContain('adapter-metadata.json');
    expect(trainerSource).toContain('"saveAdapter": options.save_adapter');
    expect(trainerSource).toContain('"metadataPath": str(metadata_path)');
    expect(trainerSource).toContain('"outputDir": str(options.output_dir)');
  });

  it('does not use no-save training arguments when adapter saving is enabled', () => {
    expect(trainerSource).toContain('"steps" if options.save_adapter else "no"');
    expect(trainerSource).toContain('"save_steps": options.max_steps');
    expect(trainerSource).toContain('"save_total_limit": 1');
    expect(trainerSource).toContain('"save_only_model"');
  });

  it('saves LoRA adapter artifacts without full-model export or hub upload behavior', () => {
    expect(trainerSource).toContain('model.save_pretrained(str(options.output_dir))');
    expect(trainerSource).toContain('tokenizer.save_pretrained(str(options.output_dir))');
    expect(trainerSource).toContain('"fullModelExport": False');
    expect(trainerSource).toContain('"pushToHub": False');
    expect(trainerSource).not.toContain('save_pretrained_merged');
    expect(trainerSource).not.toContain('push_to_hub');
  });

  it('keeps OpenAI output excluded from training metadata', () => {
    expect(trainerSource).toContain('"noOpenAiOutputUsed": True');
    expect(trainerSource).toContain('"openAiOutputUsed": False');
  });
});
