#!/usr/bin/env python3
"""
Teacher-forced target likelihood audit for local GPT-OSS LoRA adapters.

Dry-run validates local files and target span isolation. Execute mode loads the
base model and local adapter, computes loss only on the Harmony final boundary
plus assistant target span, and writes local reports.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path
from typing import Any


os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_MODEL = "openai/gpt-oss-20b"
DEFAULT_TRAINING_FILE = REPO_ROOT / "examples" / "gptoss" / "arcanos-single-json-overfit-training.jsonl"
DEFAULT_ADAPTER_DIR = REPO_ROOT / "local_artifacts" / "gptoss-single-json-overfit"
DEFAULT_OUTPUT = DEFAULT_ADAPTER_DIR / "target-likelihood-audit.json"
DEFAULT_DECISION_OUTPUT = DEFAULT_ADAPTER_DIR / "target-likelihood-decision.json"
SAFE_SOURCES = {"arcanos_owned_spec", "repo_schema", "human_authored"}


def main() -> int:
    options = parse_args(sys.argv[1:])
    try:
        adapter = verify_adapter(options.adapter_dir)
        record = load_training_record(options.training_file, options.record_id)
        ensure_local_artifact_output(options.output)
        ensure_local_artifact_output(options.decision_output)
        if options.dry_run:
            tokenizer = load_tokenizer(options.model)
            span = build_target_span(record, tokenizer, options.max_seq_length)
            report = build_dry_run_report(options, adapter, record, span)
        else:
            report = run_likelihood_audit(options, adapter, record)
        decision = build_decision(report)
        options.output.parent.mkdir(parents=True, exist_ok=True)
        options.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        options.decision_output.parent.mkdir(parents=True, exist_ok=True)
        options.decision_output.write_text(json.dumps(decision, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print_json(report)
        return 0 if report.get("ok") else 1
    except Exception as error:
        report = {
            "ok": False,
            "mode": "dry-run" if options.dry_run else "execute",
            "error": classify_error(error),
            "message": str(error),
            "adapterDir": str(options.adapter_dir),
            "allowedForTraining": False,
            "openAiCalled": False,
            "trainingExecuted": False,
            "vllmUsed": False,
            "noOpenAiOutputUsed": True,
        }
        if is_local_artifact_path(options.output):
            options.output.parent.mkdir(parents=True, exist_ok=True)
            options.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if is_local_artifact_path(options.decision_output):
            decision = build_decision(report)
            options.decision_output.parent.mkdir(parents=True, exist_ok=True)
            options.decision_output.write_text(json.dumps(decision, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print_json(report)
        return 2


def parse_args(raw_args: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit teacher-forced GPT-OSS target likelihood without OpenAI, vLLM, or training.")
    parser.add_argument("--adapter-dir", type=Path, default=Path(os.environ.get("ARCANOS_GPTOSS_ADAPTER_DIR", DEFAULT_ADAPTER_DIR)))
    parser.add_argument("--training-file", type=Path, default=Path(os.environ.get("ARCANOS_GPTOSS_TRAINING_FILE", DEFAULT_TRAINING_FILE)))
    parser.add_argument("--record-id", default=os.environ.get("ARCANOS_GPTOSS_RECORD_ID"))
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("ARCANOS_GPTOSS_LIKELIHOOD_REPORT", DEFAULT_OUTPUT)))
    parser.add_argument("--decision-output", type=Path, default=Path(os.environ.get("ARCANOS_GPTOSS_LIKELIHOOD_DECISION", DEFAULT_DECISION_OUTPUT)))
    parser.add_argument("--model", default=os.environ.get("ARCANOS_GPTOSS_MODEL", DEFAULT_MODEL))
    parser.add_argument("--max-seq-length", type=positive_int, default=int(os.environ.get("ARCANOS_MAX_SEQ_LENGTH", "256")))
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--execute", action="store_false", dest="dry_run")
    return parser.parse_args(raw_args)


def verify_adapter(adapter_dir: Path) -> dict[str, Any]:
    if not adapter_dir.exists() or not adapter_dir.is_dir():
        raise FileNotFoundError(f"adapter directory is missing: {adapter_dir}")
    adapter_config_path = adapter_dir / "adapter_config.json"
    metadata_path = adapter_dir / "adapter-metadata.json"
    adapter_files = sorted(adapter_dir.glob("adapter_model.*"))
    missing = [str(path) for path in [adapter_config_path, metadata_path] if not path.exists()]
    if not adapter_files:
        missing.append(str(adapter_dir / "adapter_model.*"))
    if missing:
        raise FileNotFoundError(f"adapter artifacts are incomplete; missing: {', '.join(missing)}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("noOpenAiOutputUsed") is not True:
        raise ValueError("adapter metadata must contain noOpenAiOutputUsed=true")
    adapter_config = json.loads(adapter_config_path.read_text(encoding="utf-8"))
    return {
        "adapterDir": str(adapter_dir),
        "adapterConfigPath": str(adapter_config_path),
        "adapterMetadataPath": str(metadata_path),
        "adapterModelPath": str(adapter_files[0]),
        "adapterModelBytes": adapter_files[0].stat().st_size,
        "adapterModelSha256": sha256_file(adapter_files[0]),
        "adapterConfig": adapter_config,
        "metadata": metadata,
    }


def load_training_record(training_file: Path, record_id: str | None) -> dict[str, Any]:
    if not training_file.exists():
        raise FileNotFoundError(f"training file is missing: {training_file}")
    records = []
    for line_number, raw_line in enumerate(training_file.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        record = json.loads(raw_line)
        errors = validate_training_record(record)
        if errors:
            raise ValueError(f"line {line_number}: {', '.join(errors)}")
        records.append(record)
    if not records:
        raise ValueError("training file has no records")
    if record_id:
        matches = [record for record in records if record.get("id") == record_id]
        if len(matches) != 1:
            raise ValueError(f"record id was not found exactly once: {record_id}")
        return matches[0]
    if len(records) != 1:
        raise ValueError("training file must contain one record unless --record-id is provided")
    return records[0]


def validate_training_record(record: dict[str, Any]) -> list[str]:
    errors = []
    if record.get("source") not in SAFE_SOURCES:
        errors.append("unsafe_source")
    if record.get("allowed_for_training") is not True:
        errors.append("training_not_allowed")
    if record.get("reviewed") is not True:
        errors.append("reviewed_required")
    metadata = record.get("metadata")
    if not isinstance(metadata, dict):
        errors.append("metadata_required")
    else:
        if metadata.get("no_openai_output_used") is not True:
            errors.append("no_openai_output_used_required")
        if metadata.get("target_shape") not in {"label_only", "json_only", "compact_final"}:
            errors.append("target_shape_invalid")
    messages = record.get("messages")
    if not isinstance(messages, list):
        errors.append("messages_required")
    else:
        assistant_messages = [message for message in messages if message.get("role") == "assistant"]
        if len(assistant_messages) != 1:
            errors.append("exactly_one_assistant_required")
    return errors


def load_tokenizer(model_name: str) -> Any:
    try:
        from transformers import AutoTokenizer

        return AutoTokenizer.from_pretrained(model_name)
    except ImportError:
        return FallbackHarmonyTokenizer()


def run_likelihood_audit(options: argparse.Namespace, adapter: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    from peft import PeftModel
    from unsloth import FastLanguageModel
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; target likelihood audit requires the local GPU")
    base_model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=options.model,
        max_seq_length=options.max_seq_length,
        load_in_4bit=True,
    )
    span = build_target_span(record, tokenizer, options.max_seq_length)
    base_loss = compute_target_loss(base_model, span)
    release_gpu_memory()

    adapter_model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=options.model,
        max_seq_length=options.max_seq_length,
        load_in_4bit=True,
    )
    adapter_model = PeftModel.from_pretrained(adapter_model, str(options.adapter_dir))
    activation = inspect_adapter_activation(adapter_model, adapter)
    adapter_loss = compute_target_loss(adapter_model, span)
    loss_improvement = base_loss - adapter_loss
    improved = loss_improvement > 0.01
    return build_report(options, adapter, record, span, activation, base_loss, adapter_loss, improved)


def compute_target_loss(model: Any, span: dict[str, Any]) -> float:
    import torch
    import torch.nn.functional as F

    model.eval()
    input_ids = torch.tensor([span["inputIds"]], dtype=torch.long, device=model.device)
    attention_mask = torch.tensor([span["attentionMask"]], dtype=torch.long, device=model.device)
    supervised_positions = span["supervisedPositions"]
    if not supervised_positions:
        raise ValueError("target span has no supervised token positions")
    with torch.no_grad():
        outputs = model(input_ids=input_ids, attention_mask=attention_mask)
        logits = outputs.logits[0]
        losses = []
        for position in supervised_positions:
            if position == 0:
                continue
            token_id = input_ids[0, position]
            token_logits = logits[position - 1]
            losses.append(F.cross_entropy(token_logits.unsqueeze(0).float(), token_id.unsqueeze(0), reduction="none"))
        if not losses:
            raise ValueError("target span has no teacher-forced prediction positions")
        return float(torch.cat(losses).mean().detach().cpu().item())


def build_target_span(record: dict[str, Any], tokenizer: Any, max_seq_length: int) -> dict[str, Any]:
    rendered = render_training_record(record, tokenizer)
    assistant_target = extract_assistant_target(record)
    start_char, end_char = find_assistant_target_span(rendered, assistant_target)
    prefix_rendered = render_generation_prefix(record, tokenizer)
    if not rendered.startswith(prefix_rendered):
        raise ValueError(f"{record.get('id', '<unknown>')}: training render does not start with eval generation prefix")
    boundary_text = rendered[len(prefix_rendered):start_char]
    if not boundary_text:
        raise ValueError(f"{record.get('id', '<unknown>')}: Harmony final boundary tokens were not found before assistant content")
    encoded = tokenizer(rendered, add_special_tokens=False, truncation=True, max_length=max_seq_length)
    generation_prefix_ids = tokenizer(prefix_rendered, add_special_tokens=False)["input_ids"]
    content_prefix_ids = tokenizer(rendered[:start_char], add_special_tokens=False)["input_ids"]
    target_ids = tokenizer(rendered[start_char:end_char], add_special_tokens=False)["input_ids"]
    input_ids = list(encoded["input_ids"])
    attention_mask = list(encoded.get("attention_mask", [1] * len(input_ids)))
    generation_cursor = len(generation_prefix_ids)
    target_start, target_end = find_token_span(input_ids, target_ids, len(content_prefix_ids))
    if generation_cursor >= target_start:
        raise ValueError(f"{record.get('id', '<unknown>')}: Harmony final boundary tokens were not found before assistant content")
    supervised_positions = list(range(generation_cursor, target_end))
    if not supervised_positions:
        raise ValueError(f"{record.get('id', '<unknown>')}: all labels are masked")
    decoded_supervised = tokenizer.decode([input_ids[index] for index in supervised_positions], skip_special_tokens=False)
    for message in record["messages"]:
        if message["role"] != "assistant" and message["content"] in decoded_supervised:
            raise ValueError(f"{record.get('id', '<unknown>')}: prompt text would be supervised")
    return {
        "inputIds": input_ids,
        "attentionMask": attention_mask,
        "recordId": record["id"],
        "targetText": assistant_target,
        "targetTokenCount": len(target_ids),
        "supervisedTokenCount": len(supervised_positions),
        "supervisedPositions": supervised_positions,
        "generationCursorTokenStart": generation_cursor,
        "assistantTokenStart": target_start,
        "assistantTokenEnd": target_end,
        "renderedEvalPrefix": prefix_rendered,
        "renderedFullTrainingSample": rendered,
        "boundaryTokenPreview": tokenizer.decode(input_ids[generation_cursor:target_start], skip_special_tokens=False),
        "decodedSupervisedSpanPreview": decoded_supervised[:300],
        "chatTemplateUsed": has_chat_template(tokenizer),
    }


def inspect_adapter_activation(model: Any, adapter: dict[str, Any]) -> dict[str, Any]:
    active_adapter = getattr(model, "active_adapter", None)
    if callable(active_adapter):
        try:
            active_adapter = active_adapter()
        except Exception:
            active_adapter = None
    peft_config = getattr(model, "peft_config", {})
    adapter_names = sorted([str(name) for name in peft_config.keys()]) if isinstance(peft_config, dict) else []
    target_modules = adapter["adapterConfig"].get("target_modules")
    target_parameters = adapter["adapterConfig"].get("target_parameters")
    matched_module_names = []
    if target_modules:
        targets = [target_modules] if isinstance(target_modules, str) else list(target_modules)
        for name, _module in model.named_modules():
            if any(str(target) in name for target in targets):
                matched_module_names.append(name)
                if len(matched_module_names) >= 20:
                    break
    return {
        "adapterConfigExists": True,
        "adapterModelExists": True,
        "adapterLoaded": True,
        "activeAdapter": str(active_adapter) if active_adapter is not None else None,
        "adapterNames": adapter_names,
        "adapterTargetModules": target_modules,
        "adapterTargetParameters": target_parameters,
        "matchedModuleNameSample": matched_module_names,
        "adapterModelBytes": adapter["adapterModelBytes"],
        "adapterModelSha256": adapter["adapterModelSha256"],
        "baseForwardCompleted": True,
        "adapterForwardCompleted": True,
    }


def build_report(
    options: argparse.Namespace,
    adapter: dict[str, Any],
    record: dict[str, Any],
    span: dict[str, Any],
    activation: dict[str, Any],
    base_loss: float,
    adapter_loss: float,
    improved: bool,
) -> dict[str, Any]:
    return {
        "ok": True,
        "mode": "execute",
        "executed": True,
        "recordId": span["recordId"],
        "adapterDir": str(options.adapter_dir),
        "targetText": span["targetText"],
        "targetTokenCount": span["targetTokenCount"],
        "supervisedTokenCount": span["supervisedTokenCount"],
        "generationCursorTokenStart": span["generationCursorTokenStart"],
        "assistantTokenStart": span["assistantTokenStart"],
        "assistantTokenEnd": span["assistantTokenEnd"],
        "boundaryTokenPreview": span["boundaryTokenPreview"],
        "decodedSupervisedSpanPreview": span["decodedSupervisedSpanPreview"],
        "renderedEvalPrefixLength": len(span["renderedEvalPrefix"]),
        "renderedFullTrainingSampleLength": len(span["renderedFullTrainingSample"]),
        "renderedEvalPrefixPreview": span["renderedEvalPrefix"][:300],
        "renderedFullTrainingSamplePreview": span["renderedFullTrainingSample"][:500],
        "base": {
            "loss": base_loss,
            "perplexity": safe_perplexity(base_loss),
        },
        "adapter": {
            "loss": adapter_loss,
            "perplexity": safe_perplexity(adapter_loss),
        },
        "delta": {
            "lossImprovement": base_loss - adapter_loss,
            "adapterImprovedLikelihood": improved,
        },
        "adapterActivation": activation,
        "chatTemplateUsed": span["chatTemplateUsed"],
        "allowedForTraining": False,
        "openAiCalled": False,
        "trainingExecuted": False,
        "vllmUsed": False,
        "noOpenAiOutputUsed": True,
        "source": record["source"],
        "targetShape": record["metadata"]["target_shape"],
    }


def build_dry_run_report(options: argparse.Namespace, adapter: dict[str, Any], record: dict[str, Any], span: dict[str, Any]) -> dict[str, Any]:
    activation = {
        "adapterConfigExists": True,
        "adapterModelExists": True,
        "adapterLoaded": False,
        "activeAdapter": None,
        "adapterNames": [],
        "adapterTargetModules": adapter["adapterConfig"].get("target_modules"),
        "adapterTargetParameters": adapter["adapterConfig"].get("target_parameters"),
        "matchedModuleNameSample": [],
        "adapterModelBytes": adapter["adapterModelBytes"],
        "adapterModelSha256": adapter["adapterModelSha256"],
        "baseForwardCompleted": False,
        "adapterForwardCompleted": False,
    }
    return {
        "ok": True,
        "mode": "dry-run",
        "executed": False,
        "recordId": span["recordId"],
        "adapterDir": str(options.adapter_dir),
        "targetText": span["targetText"],
        "targetTokenCount": span["targetTokenCount"],
        "supervisedTokenCount": span["supervisedTokenCount"],
        "generationCursorTokenStart": span["generationCursorTokenStart"],
        "assistantTokenStart": span["assistantTokenStart"],
        "assistantTokenEnd": span["assistantTokenEnd"],
        "boundaryTokenPreview": span["boundaryTokenPreview"],
        "decodedSupervisedSpanPreview": span["decodedSupervisedSpanPreview"],
        "base": None,
        "adapter": None,
        "delta": None,
        "adapterActivation": activation,
        "chatTemplateUsed": span["chatTemplateUsed"],
        "allowedForTraining": False,
        "openAiCalled": False,
        "trainingExecuted": False,
        "vllmUsed": False,
        "noOpenAiOutputUsed": True,
        "source": record["source"],
        "targetShape": record["metadata"]["target_shape"],
    }


def build_decision(report: dict[str, Any]) -> dict[str, Any]:
    if not report.get("ok"):
        error = report.get("error")
        if error == "adapter_loading_suspect":
            decision = "adapter_loading_suspect"
        elif error == "target_span_suspect":
            decision = "target_span_suspect"
        else:
            decision = "adapter_loading_suspect"
    elif report.get("mode") == "dry-run":
        decision = "scorer_or_extraction_suspect"
    elif report.get("delta", {}).get("adapterImprovedLikelihood") is True:
        decision = "adapter_learned_target_generation_failed"
    else:
        decision = "adapter_did_not_learn_target"
    return {
        "decision": decision,
        "recordId": report.get("recordId"),
        "adapterDir": report.get("adapterDir"),
        "baseLoss": report.get("base", {}).get("loss") if isinstance(report.get("base"), dict) else None,
        "adapterLoss": report.get("adapter", {}).get("loss") if isinstance(report.get("adapter"), dict) else None,
        "lossImprovement": report.get("delta", {}).get("lossImprovement") if isinstance(report.get("delta"), dict) else None,
        "adapterImprovedLikelihood": report.get("delta", {}).get("adapterImprovedLikelihood") if isinstance(report.get("delta"), dict) else None,
        "allowedForTraining": False,
        "openAiCalled": False,
        "trainingExecuted": False,
        "vllmUsed": False,
        "noOpenAiOutputUsed": True,
    }


def render_training_record(record: dict[str, Any], tokenizer: Any) -> str:
    messages = record["messages"]
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    return "\n".join([f"<|{message['role']}|>\n{message['content']}" for message in messages])


def render_generation_prefix(record: dict[str, Any], tokenizer: Any) -> str:
    messages = [message for message in record["messages"] if message.get("role") != "assistant"]
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return "\n".join([f"<|{message['role']}|>\n{message['content']}" for message in messages] + ["<|assistant|>"])


def extract_assistant_target(record: dict[str, Any]) -> str:
    targets = [message["content"] for message in record.get("messages", []) if message.get("role") == "assistant"]
    if len(targets) != 1:
        raise ValueError(f"{record.get('id', '<unknown>')}: expected exactly one assistant target")
    return targets[0]


def find_assistant_target_span(rendered: str, assistant_target: str) -> tuple[int, int]:
    start_char = rendered.rfind(assistant_target)
    if start_char < 0:
        raise ValueError("assistant target span was not found in rendered chat template")
    return start_char, start_char + len(assistant_target)


def find_token_span(input_ids: list[int], target_ids: list[int], preferred_start: int) -> tuple[int, int]:
    if not target_ids:
        raise ValueError("assistant target tokenization produced no tokens")
    candidates = []
    for index in range(0, len(input_ids) - len(target_ids) + 1):
        if input_ids[index:index + len(target_ids)] == target_ids:
            candidates.append(index)
    if not candidates:
        raise ValueError("assistant target token span was not found")
    start = min(candidates, key=lambda candidate: abs(candidate - preferred_start))
    return start, start + len(target_ids)


def has_chat_template(tokenizer: Any) -> bool:
    return bool(hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None))


def release_gpu_memory() -> None:
    import gc

    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def ensure_local_artifact_output(output_path: Path) -> None:
    if not is_local_artifact_path(output_path):
        raise ValueError(f"likelihood report must stay under local_artifacts: {output_path}")


def is_local_artifact_path(output_path: Path) -> bool:
    resolved_output = output_path.resolve()
    resolved_artifacts = (REPO_ROOT / "local_artifacts").resolve()
    return resolved_artifacts == resolved_output or resolved_artifacts in resolved_output.parents


def classify_error(error: Exception) -> str:
    text = str(error)
    if isinstance(error, FileNotFoundError) and "adapter" in text:
        return "adapter_loading_suspect"
    if (
        "target span" in text
        or "Harmony final boundary" in text
        or "training render does not start" in text
        or "target token span" in text
        or "assistant target tokenization" in text
        or "all labels are masked" in text
    ):
        return "target_span_suspect"
    return "likelihood_audit_failed"


def safe_perplexity(loss: float) -> float:
    try:
        return float(math.exp(loss))
    except OverflowError:
        return float("inf")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def positive_int(raw_value: str) -> int:
    value = int(raw_value)
    if value <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return value


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


class FallbackHarmonyTokenizer:
    chat_template = "fallback-harmony"

    def apply_chat_template(self, messages: list[dict[str, str]], tokenize: bool = False, add_generation_prompt: bool = False) -> str | list[int]:
        text = ""
        for message in messages:
            text += f"<|start|>{message['role']}"
            if message["role"] == "assistant":
                text += f"<|channel|>final<|message|>{message['content']}<|end|>"
            else:
                text += f"<|message|>{message['content']}<|end|>"
        if add_generation_prompt:
            text += "<|start|>assistant"
        if tokenize:
            return self.encode_text(text)
        return text

    def __call__(self, text: str, add_special_tokens: bool = False, truncation: bool = False, max_length: int | None = None) -> dict[str, list[int]]:
        input_ids = self.encode_text(text)
        return {
            "input_ids": input_ids,
            "attention_mask": [1] * len(input_ids),
        }

    def decode(self, token_ids: list[int], skip_special_tokens: bool = False) -> str:
        return "".join(chr(token_id) for token_id in token_ids)

    @staticmethod
    def encode_text(text: str) -> list[int]:
        return [ord(character) for character in text]


if __name__ == "__main__":
    raise SystemExit(main())
