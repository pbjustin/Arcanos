#!/usr/bin/env python3
"""
Local Unsloth GPT-OSS-20B QLoRA smoke trainer.

Dry-run is the default. Execute mode is intentionally capped to a tiny smoke run.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import inspect
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_DATASET = REPO_ROOT / "examples" / "gptoss" / "arcanos-safe-smoke-training.jsonl"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "local_artifacts" / "gptoss-smoke"
DEFAULT_HF_HOME = Path("/root/huggingface")
DEFAULT_HF_HUB_CACHE = DEFAULT_HF_HOME / "hub"
DEFAULT_UNSLOTH_CACHE = Path("/root/unsloth-cache")
DEFAULT_MODEL = "openai/gpt-oss-20b"
SAFE_SOURCES = {
    "arcanos_owned_spec",
    "repo_schema",
    "human_authored",
    "redacted_consented_log",
}
REJECTED_SOURCES = {
    "openai_output",
    "openai_judgment",
    "custom_gpt_action_request",
    "hidden_reasoning",
    "raw_secret",
    "unknown",
    "third_party_copyrighted",
    "model_generated_label_without_human_review",
}
SECRET_MARKERS = ("OPENAI_API_KEY", "RAILWAY_TOKEN", "DATABASE_URL", "Bearer ")
ASSISTANT_TARGET_REJECT_MARKERS = (
    "Input:",
    "Expected:",
    "Analysis:",
    "Reasoning:",
    "chain-of-thought",
    "chain of thought",
    "hidden reasoning",
    "<|analysis",
    "<|commentary",
    "<|channel",
    "system:",
    "developer:",
    "user:",
)
MASK_AUDIT_SAMPLE_COUNT = 3
MIN_FREE_GB = 80
MAX_SAFE_STEPS = 100
MAX_SINGLE_RECORD_OVERFIT_STEPS = 150
MAX_SAFE_SAMPLES = 80
MAX_PHASE35_SAMPLES = 120
MAX_PHASE36_SAMPLES = 152
MAX_PHASE37_SAMPLES = 186


def main() -> int:
    options = parse_args(sys.argv[1:])
    configure_cache_env()

    try:
        options.max_steps = min(options.max_steps, max_steps_cap(options.output_dir))
        options.max_samples = min(options.max_samples, max_samples_cap(options.output_dir))
        records = validate_dataset(options.dataset)
        mask_audit = build_mask_audit(options, records)
        if options.mask_audit:
            write_json_file(options.mask_audit_report, mask_audit)
            write_loss_mask_audit(options.output_dir, mask_audit)
            print_json(mask_audit)
            return 0 if mask_audit["ok"] else 6
        runtime = inspect_runtime()
        disk = inspect_disk(options.cache_dir)
        config = build_config(options, runtime, disk, records, mask_audit)
        write_loss_mask_audit(options.output_dir, mask_audit)
    except Exception as error:
        print_json({
            "ok": False,
            "mode": "execute" if options.execute else "dry-run",
            "executed": False,
            "error": "preflight_failed",
            "message": str(error),
        })
        return 2

    print_json(config)

    if not mask_audit["ok"]:
        print_json({**config, "ok": False, "executed": False, "error": "response_mask_audit_failed"})
        return 6

    if not options.execute:
        return 0

    if not runtime["cudaAvailable"]:
        print_json({**config, "ok": False, "executed": False, "error": "cuda_unavailable"})
        return 3

    if disk["freeGb"] < MIN_FREE_GB:
        print_json({
            **config,
            "ok": False,
            "executed": False,
            "error": "insufficient_disk",
            "message": f"{options.cache_dir} has {disk['freeGb']} GB free; require at least {MIN_FREE_GB} GB.",
        })
        return 4

    try:
        return run_training(options, records, config)
    except Exception as error:
        print_json({**config, "ok": False, "executed": False, "error": "training_failed", "message": str(error)})
        return 5


def parse_args(raw_args: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local Unsloth GPT-OSS QLoRA smoke fine-tune.")
    parser.add_argument("--execute", action="store_true", help="Actually run the capped smoke training.")
    parser.add_argument("--dataset", type=Path, default=Path(os.environ.get("ARCANOS_SMOKE_DATASET", DEFAULT_DATASET)))
    parser.add_argument("--model", default=os.environ.get("ARCANOS_GPTOSS_MODEL", DEFAULT_MODEL))
    parser.add_argument("--output-dir", type=Path, default=Path(os.environ.get("ARCANOS_UNSLOTH_OUTPUT_DIR", DEFAULT_OUTPUT_DIR)))
    parser.add_argument("--cache-dir", type=Path, default=Path(os.environ.get("HF_HOME", DEFAULT_HF_HOME)))
    parser.add_argument("--max-seq-length", type=positive_int, default=int(os.environ.get("ARCANOS_MAX_SEQ_LENGTH", "512")))
    parser.add_argument("--max-steps", type=positive_int, default=int(os.environ.get("ARCANOS_UNSLOTH_MAX_STEPS", os.environ.get("ARCANOS_SMOKE_MAX_STEPS", "25"))))
    parser.add_argument("--max-samples", type=positive_int, default=int(os.environ.get("ARCANOS_SMOKE_MAX_SAMPLES", "8")))
    parser.add_argument("--repeat-repair-records", type=positive_int, default=int(os.environ.get("ARCANOS_REPAIR_RECORD_REPEAT", "1")))
    parser.add_argument("--learning-rate", type=positive_float, default=float(os.environ.get("ARCANOS_UNSLOTH_LEARNING_RATE", "2e-4")))
    parser.add_argument("--warmup-ratio", type=ratio_float, default=float(os.environ.get("ARCANOS_UNSLOTH_WARMUP_RATIO", "0")))
    parser.add_argument("--lora-dropout", type=ratio_float, default=float(os.environ.get("ARCANOS_UNSLOTH_LORA_DROPOUT", "0")))
    parser.add_argument("--lora-r", type=positive_int, default=int(os.environ.get("ARCANOS_UNSLOTH_LORA_R", "16")))
    parser.add_argument("--lora-alpha", type=positive_int, default=int(os.environ.get("ARCANOS_UNSLOTH_LORA_ALPHA", "16")))
    parser.add_argument("--save-adapter", action="store_true", help="Save final LoRA adapter, tokenizer, and metadata after execute mode.")
    parser.add_argument("--mask-audit", action="store_true", help="Render and verify response-only assistant label masks without training.")
    parser.add_argument("--mask-audit-samples", type=positive_int, default=MASK_AUDIT_SAMPLE_COUNT)
    parser.add_argument("--mask-audit-report", type=Path, default=REPO_ROOT / "local_artifacts" / "gptoss-phase3" / "mask-audit-report.json")
    return parser.parse_args(raw_args)


def configure_cache_env() -> None:
    os.environ.setdefault("HF_HOME", str(DEFAULT_HF_HOME))
    os.environ.setdefault("HF_HUB_CACHE", str(DEFAULT_HF_HUB_CACHE))
    os.environ.setdefault("UNSLOTH_CACHE_DIR", str(DEFAULT_UNSLOTH_CACHE))
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("UNSLOTH_CE_LOSS_TARGET_GB", "0.05")


def validate_dataset(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Smoke dataset is missing: {path}")

    records: list[dict[str, Any]] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        if any(marker in raw_line for marker in SECRET_MARKERS):
            raise ValueError(f"line {line_number}: secret marker is not allowed")
        record = json.loads(raw_line)
        source = record.get("source")
        if source in REJECTED_SOURCES or source not in SAFE_SOURCES:
            raise ValueError(f"line {line_number}: source {source!r} is not allowed for training")
        if record.get("allowed_for_training") is not True:
            raise ValueError(f"line {line_number}: allowed_for_training must be true")
        if source == "human_authored" and record.get("reviewed") is not True:
            raise ValueError(f"line {line_number}: human_authored records require reviewed=true")
        if source == "redacted_consented_log" and (record.get("redacted") is not True or record.get("consent") is not True):
            raise ValueError(f"line {line_number}: redacted_consented_log requires redacted=true and consent=true")
        if any(field in record for field in ("openai_output", "openai_judgment", "hidden_reasoning")):
            raise ValueError(f"line {line_number}: OpenAI/hidden-reasoning marker fields are rejected")
        metadata = record.get("metadata")
        if not isinstance(metadata, dict):
            raise ValueError(f"line {line_number}: metadata is required")
        if metadata.get("no_openai_output_used") is not True:
            raise ValueError(f"line {line_number}: metadata.no_openai_output_used must be true")
        if metadata.get("target_shape") not in {"label_only", "json_only", "compact_final"}:
            raise ValueError(f"line {line_number}: metadata.target_shape must be label_only, json_only, or compact_final")
        if "messages" in record:
            validate_messages(record["messages"], line_number)
        else:
            text = record.get("text")
            if not isinstance(text, str) or not text.strip():
                raise ValueError(f"line {line_number}: text or messages must be non-empty")
        records.append(record)

    if not records:
        raise ValueError("Smoke dataset has no records")

    return records


def validate_messages(messages: Any, line_number: int) -> None:
    if not isinstance(messages, list) or not messages:
        raise ValueError(f"line {line_number}: messages must be a non-empty list")

    assistant_targets = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise ValueError(f"line {line_number}: message {index} must be an object")
        if message.get("role") not in {"system", "developer", "user", "assistant"}:
            raise ValueError(f"line {line_number}: message {index} has an invalid role")
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f"line {line_number}: message {index} content must be non-empty")
        if message["role"] == "assistant":
            assistant_targets.append(content)

    if len(assistant_targets) != 1:
        raise ValueError(f"line {line_number}: messages must contain exactly one assistant target")
    assistant_target = assistant_targets[0]
    lowered = assistant_target.lower()
    if any(marker.lower() in lowered for marker in ASSISTANT_TARGET_REJECT_MARKERS):
        raise ValueError(f"line {line_number}: assistant target must be final-only")


def inspect_runtime() -> dict[str, Any]:
    import torch

    unsloth_version = None
    try:
        import unsloth
        unsloth_version = getattr(unsloth, "__version__", "present")
    except Exception as error:  # pragma: no cover - depends on local env
        unsloth_version = f"unavailable: {type(error).__name__}: {error}"

    return {
        "python": sys.version.split()[0],
        "torch": getattr(torch, "__version__", "unknown"),
        "cudaAvailable": bool(torch.cuda.is_available()),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "unsloth": unsloth_version,
    }


def inspect_disk(cache_dir: Path) -> dict[str, Any]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(cache_dir)
    return {
        "cacheDir": str(cache_dir),
        "hfHome": os.environ["HF_HOME"],
        "hfHubCache": os.environ["HF_HUB_CACHE"],
        "unslothCacheDir": os.environ["UNSLOTH_CACHE_DIR"],
        "freeGb": round(usage.free / 1024**3, 2),
        "minFreeGb": MIN_FREE_GB,
    }


def build_config(
    options: argparse.Namespace,
    runtime: dict[str, Any],
    disk: dict[str, Any],
    records: list[dict[str, Any]],
    mask_audit: dict[str, Any],
) -> dict[str, Any]:
    metadata_path = options.output_dir / "adapter-metadata.json"
    training_args_save_strategy = "steps" if options.save_adapter else "no"
    dataset_count = len(records)
    message_count = sum(1 for record in records if "messages" in record)
    sample_weighting = build_sample_weighting_report(records, options)
    return {
        "ok": True,
        "script": "scripts/gptoss/unsloth-train-smoke.py",
        "mode": "execute" if options.execute else "dry-run",
        "executed": False,
        "dataset": str(options.dataset),
        "datasetRecords": dataset_count,
        "datasetFormat": {
            "messagesFormatRecords": message_count,
            "textFormatRecords": dataset_count - message_count,
        },
        "outputDir": str(options.output_dir),
        "runtime": runtime,
        "disk": disk,
        "cachePolicy": {
            "hfHubDisableXet": os.environ.get("HF_HUB_DISABLE_XET") == "1",
            "unslothCeLossTargetGb": os.environ.get("UNSLOTH_CE_LOSS_TARGET_GB"),
        },
        "trainingConfig": {
            "model_name": options.model,
            "max_seq_length": options.max_seq_length,
            "load_in_4bit": True,
            "qlora_only": True,
            "bf16_full_finetune": False,
            "responseOnlyTrainingEnabled": mask_audit["responseOnlyTrainingEnabled"],
            "assistantTargetSpansFound": mask_audit["assistantTargetSpansFound"],
            "supervisedStartsAtGenerationCursor": mask_audit["supervisedStartsAtGenerationCursor"],
            "harmonyBoundaryTokensSupervised": mask_audit["harmonyBoundaryTokensSupervised"],
            "assistantContentSupervised": mask_audit["assistantContentSupervised"],
            "maskStrategy": "harmony_final_boundary_plus_content",
            "allLabelsMasked": mask_audit["allLabelsMasked"],
            "promptTokensSupervised": mask_audit["promptTokensSupervised"],
            "per_device_train_batch_size": 1,
            "gradient_accumulation_steps": 4,
            "use_gradient_checkpointing": "unsloth",
            "max_steps": options.max_steps,
            "learning_rate": options.learning_rate,
            "warmup_ratio": options.warmup_ratio,
            "lora_r": options.lora_r,
            "lora_alpha": options.lora_alpha,
            "lora_dropout": options.lora_dropout,
            "max_steps_cap": max_steps_cap(options.output_dir),
            "max_samples": options.max_samples,
            "max_samples_cap": max_samples_cap(options.output_dir),
            "repairRepeatFactor": sample_weighting["repairRepeatFactor"],
            "repairRecordCount": sample_weighting["repairRecordCount"],
            "effectiveRepairSampleCount": sample_weighting["effectiveRepairSampleCount"],
            "expandedTrainSampleCount": sample_weighting["expandedTrainSampleCount"],
            "save_strategy": training_args_save_strategy,
        },
        "sampleWeighting": sample_weighting,
        "artifactConfig": {
            "saveAdapter": options.save_adapter,
            "outputDir": str(options.output_dir),
            "metadataPath": str(metadata_path),
            "expectedFiles": [
                "adapter_config.json",
                "adapter_model.safetensors",
                "adapter-metadata.json",
                "tokenizer_config.json",
            ],
            "fullModelExport": False,
            "pushToHub": False,
        },
        "safety": {
            "openAiReferenceCalled": False,
            "openAiOutputUsed": False,
            "longTrainingAllowed": False,
            "requiresExplicitExecute": True,
        },
    }


def run_training(options: argparse.Namespace, records: list[dict[str, Any]], config: dict[str, Any]) -> int:
    from datasets import Dataset
    from transformers import DataCollatorForSeq2Seq
    from transformers import TrainingArguments
    from trl import SFTTrainer
    from unsloth import FastLanguageModel

    options.output_dir.mkdir(parents=True, exist_ok=True)

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=options.model,
        max_seq_length=options.max_seq_length,
        load_in_4bit=True,
    )
    selected = select_training_records(records, options)
    dataset = Dataset.from_list([build_response_only_training_example(record, tokenizer, options.max_seq_length) for record in selected])
    model = FastLanguageModel.get_peft_model(
        model,
        r=options.lora_r,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_alpha=options.lora_alpha,
        lora_dropout=options.lora_dropout,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        data_collator=DataCollatorForSeq2Seq(tokenizer=tokenizer),
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=options.max_seq_length,
        args=TrainingArguments(
            **build_training_args(options, TrainingArguments),
        ),
    )
    trainer.train()

    saved_artifacts: dict[str, Any] | None = None
    if options.save_adapter:
        saved_artifacts = save_adapter_artifacts(options, model, tokenizer)
        assert_adapter_artifacts(options.output_dir)

    print_json({**config, "executed": True, "outputDir": str(options.output_dir), "savedArtifacts": saved_artifacts})
    return 0


def build_training_args(options: argparse.Namespace, training_arguments_type: Any) -> dict[str, Any]:
    args = {
        "output_dir": str(options.output_dir),
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 4,
        "max_steps": options.max_steps,
        "learning_rate": options.learning_rate,
        "warmup_ratio": options.warmup_ratio,
        "logging_steps": 1,
        "save_strategy": "steps" if options.save_adapter else "no",
        "save_steps": options.max_steps,
        "save_total_limit": 1,
        "report_to": [],
    }
    supported_args = inspect.signature(training_arguments_type.__init__).parameters
    if "save_only_model" in supported_args:
        args["save_only_model"] = True
    if "save_safetensors" in supported_args:
        args["save_safetensors"] = True
    return args


def save_adapter_artifacts(options: argparse.Namespace, model: Any, tokenizer: Any) -> dict[str, Any]:
    options.output_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(options.output_dir))

    tokenizer_saved = False
    if hasattr(tokenizer, "save_pretrained"):
        tokenizer.save_pretrained(str(options.output_dir))
        tokenizer_saved = True

    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "mode": artifact_mode(options.output_dir),
        "modelName": options.model,
        "maxSeqLength": options.max_seq_length,
        "maxSteps": options.max_steps,
        "learningRate": options.learning_rate,
        "warmupRatio": options.warmup_ratio,
        "loraDropout": options.lora_dropout,
        "loraR": options.lora_r,
        "loraAlpha": options.lora_alpha,
        "batchSize": 1,
        "gradientAccumulationSteps": 4,
        "loadIn4bit": True,
        "useGradientCheckpointing": "unsloth",
        "unslothCeLossTargetGb": os.environ.get("UNSLOTH_CE_LOSS_TARGET_GB"),
        "datasetPath": str(options.dataset),
        "trainingSourcePolicy": "safe_arcanos_owned_repo_schema_human_reviewed_only",
        "noOpenAiOutputUsed": True,
        "responseOnlyTrainingEnabled": True,
        "supervisedStartsAtGenerationCursor": True,
        "harmonyBoundaryTokensSupervised": True,
        "assistantContentSupervised": True,
        "maskStrategy": "harmony_final_boundary_plus_content",
        "repairRepeatFactor": options.repeat_repair_records,
    }
    metadata_path = options.output_dir / "adapter-metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    return {
        "outputDir": str(options.output_dir),
        "metadataPath": str(metadata_path),
        "tokenizerSaved": tokenizer_saved,
        "fullModelExport": False,
        "pushToHub": False,
    }


def render_training_record(record: dict[str, Any], tokenizer: Any) -> str:
    if "messages" not in record:
        return record["text"]
    messages = record["messages"]
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        try:
            return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        except Exception:
            pass
    return "\n".join([f"<|{message['role']}|>\n{message['content']}" for message in messages])


def build_mask_audit(options: argparse.Namespace, records: list[dict[str, Any]]) -> dict[str, Any]:
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(options.model)
    audited_records = select_training_records(records, options)
    audited_samples = [audit_response_only_mask(record, tokenizer, options.max_seq_length) for record in audited_records]
    samples = audited_samples[: min(options.mask_audit_samples, len(audited_samples))]
    assistant_spans_found = all(sample["assistantTargetFound"] for sample in audited_samples)
    assistant_tokens_supervised = all(sample["supervisedLabelCount"] > 0 for sample in audited_samples)
    supervised_starts_at_generation_cursor = all(sample["supervisedStartsAtGenerationCursor"] for sample in audited_samples)
    harmony_boundary_supervised = all(sample["harmonyBoundaryTokensSupervised"] for sample in audited_samples)
    assistant_content_supervised = all(sample["assistantContentSupervised"] for sample in audited_samples)
    all_labels_masked = any(sample["allLabelsMasked"] for sample in audited_samples)
    prompt_tokens_supervised = any(sample["promptTokensSupervised"] for sample in audited_samples)
    prompt_text_supervised = any(sample["systemDeveloperUserTextSupervised"] for sample in audited_samples)
    ok = (
        bool(audited_samples)
        and assistant_spans_found
        and assistant_tokens_supervised
        and supervised_starts_at_generation_cursor
        and harmony_boundary_supervised
        and assistant_content_supervised
        and not all_labels_masked
        and not prompt_tokens_supervised
        and not prompt_text_supervised
    )
    return {
        "ok": ok,
        "mode": "mask-audit",
        "executed": False,
        "trained": False,
        "dataset": str(options.dataset),
        "model": options.model,
        "sampleCount": len(samples),
        "auditedRecordCount": len(audited_samples),
        "reportPath": str(options.mask_audit_report),
        "responseOnlyTrainingEnabled": ok,
        "assistantTargetSpansFound": assistant_spans_found,
        "supervisedStartsAtGenerationCursor": supervised_starts_at_generation_cursor,
        "harmonyBoundaryTokensSupervised": harmony_boundary_supervised,
        "assistantContentSupervised": assistant_content_supervised,
        "maskStrategy": "harmony_final_boundary_plus_content",
        "allLabelsMasked": all_labels_masked,
        "promptTokensMasked": not prompt_tokens_supervised,
        "promptTokensSupervised": prompt_tokens_supervised,
        "systemDeveloperUserTextSupervised": prompt_text_supervised,
        "assistantTokensSupervised": assistant_tokens_supervised,
        "openAiReferenceCalled": False,
        "openAiOutputUsed": False,
        "noOpenAiOutputUsed": True,
        "vllmCalled": False,
        "saveAdapterPath": str(options.output_dir),
        "sampleWeighting": build_sample_weighting_report(records, options),
        "records": samples,
    }


def audit_response_only_mask(record: dict[str, Any], tokenizer: Any, max_seq_length: int) -> dict[str, Any]:
    example = build_response_only_training_example(record, tokenizer, max_seq_length)
    labels = example["labels"]
    input_ids = example["input_ids"]
    supervised_ids = [token_id for token_id, label in zip(input_ids, labels) if label != -100]
    decoded_supervised = tokenizer.decode(supervised_ids, skip_special_tokens=False) if supervised_ids else ""
    prompt_tokens_supervised = any(label != -100 for label in labels[: example["generationCursorTokenStart"]])
    roles = [message.get("role") for message in record.get("messages", [])]
    prompt_contents = [message.get("content", "") for message in record.get("messages", []) if message.get("role") != "assistant"]
    prompt_text_supervised = any(content and content in decoded_supervised for content in prompt_contents)
    boundary_ids = input_ids[example["generationCursorTokenStart"]:example["assistantTokenStart"]]
    boundary_preview = tokenizer.decode(boundary_ids, skip_special_tokens=False) if boundary_ids else ""
    supervised_starts_at_generation_cursor = example["supervisedTokenStart"] == example["generationCursorTokenStart"]
    boundary_supervised = bool(boundary_ids) and all(labels[index] != -100 for index in range(example["generationCursorTokenStart"], example["assistantTokenStart"]))
    assistant_content_supervised = all(labels[index] != -100 for index in range(example["assistantTokenStart"], example["assistantTokenEnd"]))
    return {
        "id": record.get("id"),
        "source": record.get("source"),
        "taskType": record.get("task_type"),
        "roles": roles,
        "renderedTextLength": len(example["text"]),
        "renderedCharCount": len(example["text"]),
        "tokenCount": len(input_ids),
        "assistantTargetText": example["assistantTarget"],
        "assistantTargetAppearsExactly": example["assistantTarget"] in example["text"],
        "assistantTargetFound": True,
        "assistantStartChar": example["assistantStartChar"],
        "assistantEndChar": example["assistantEndChar"],
        "assistantTokenStart": example["assistantTokenStart"],
        "assistantTokenEnd": example["assistantTokenEnd"],
        "generationCursorTokenStart": example["generationCursorTokenStart"],
        "supervisedTokenStart": example["supervisedTokenStart"],
        "supervisedTokenEnd": example["supervisedTokenEnd"],
        "supervisedLabelCount": len(supervised_ids),
        "supervisedTokenCount": len(supervised_ids),
        "ignoredLabelCount": len(labels) - len(supervised_ids),
        "ignoredTokenCount": len(labels) - len(supervised_ids),
        "decodedSupervisedSpanPreview": decoded_supervised[:200],
        "boundaryTokenPreview": boundary_preview,
        "supervisedStartsAtGenerationCursor": supervised_starts_at_generation_cursor,
        "harmonyBoundaryTokensSupervised": boundary_supervised,
        "assistantContentSupervised": assistant_content_supervised,
        "promptTokensSupervised": prompt_tokens_supervised,
        "systemDeveloperUserTextSupervised": prompt_text_supervised,
        "allLabelsMasked": len(supervised_ids) == 0,
        "chatTemplateUsed": example["chatTemplateUsed"],
    }


def build_response_only_training_example(record: dict[str, Any], tokenizer: Any, max_seq_length: int) -> dict[str, Any]:
    if "messages" not in record:
        raise ValueError("response-only training requires messages-format records")
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
    boundary_ids = input_ids[generation_cursor:target_start]
    if not boundary_ids:
        raise ValueError(f"{record.get('id', '<unknown>')}: Harmony final boundary tokens were not found before assistant content")
    labels = [-100] * len(input_ids)
    for index in range(generation_cursor, target_end):
        labels[index] = input_ids[index]
    if not any(label != -100 for label in labels):
        raise ValueError(f"{record.get('id', '<unknown>')}: all labels are masked")
    if any(label != -100 for label in labels[:generation_cursor]):
        raise ValueError(f"{record.get('id', '<unknown>')}: prompt tokens would be supervised")
    decoded_supervised = tokenizer.decode(input_ids[generation_cursor:target_end], skip_special_tokens=False)
    for message in record["messages"]:
        if message["role"] != "assistant" and message["content"] in decoded_supervised:
            raise ValueError(f"{record.get('id', '<unknown>')}: prompt text would be supervised")
    return {
        "text": rendered,
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "labels": labels,
        "assistantTarget": assistant_target,
        "assistantStartChar": start_char,
        "assistantEndChar": end_char,
        "generationCursorTokenStart": generation_cursor,
        "supervisedTokenStart": generation_cursor,
        "supervisedTokenEnd": target_end,
        "assistantTokenStart": target_start,
        "assistantTokenEnd": target_end,
        "chatTemplateUsed": has_chat_template(tokenizer),
    }


def render_generation_prefix(record: dict[str, Any], tokenizer: Any) -> str:
    messages = [message for message in record["messages"] if message.get("role") != "assistant"]
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        try:
            return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        except Exception:
            pass
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


def write_loss_mask_audit(output_dir: Path, mask_audit: dict[str, Any]) -> None:
    report = {
        "responseOnlyTrainingEnabled": mask_audit["responseOnlyTrainingEnabled"],
        "supervisedStartsAtGenerationCursor": mask_audit["supervisedStartsAtGenerationCursor"],
        "harmonyBoundaryTokensSupervised": mask_audit["harmonyBoundaryTokensSupervised"],
        "assistantContentSupervised": mask_audit["assistantContentSupervised"],
        "maskStrategy": "harmony_final_boundary_plus_content",
        "previousResponseOnlyTrainingEnabled": False,
        "allLabelsMaskedRisk": mask_audit["allLabelsMasked"],
        "promptTokensMasked": mask_audit["promptTokensMasked"],
        "assistantTokensSupervised": mask_audit["assistantTokensSupervised"],
        "rootCauseHypothesis": "Phase 3.0 passed fully rendered chat transcripts to SFTTrainer without assistant-only labels, so prompt and role/template tokens were supervised.",
        "safeToTrainAgain": False,
    }
    write_json_file(output_dir / "loss-mask-audit.json", report)


def write_json_file(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def is_repair_record(record: dict[str, Any]) -> bool:
    metadata = record.get("metadata")
    return isinstance(metadata, dict) and (
        metadata.get("phase3_7_repair") is True or metadata.get("phase3_8_repair") is True
    )


def select_training_records(records: list[dict[str, Any]], options: argparse.Namespace) -> list[dict[str, Any]]:
    selected = records[: options.max_samples]
    if options.repeat_repair_records <= 1:
        return selected

    repair_records = [record for record in selected if is_repair_record(record)]
    expanded = selected + repair_records * (options.repeat_repair_records - 1)
    return expanded[: options.max_samples]


def build_sample_weighting_report(records: list[dict[str, Any]], options: argparse.Namespace) -> dict[str, Any]:
    selected = records[: options.max_samples]
    expanded = select_training_records(records, options)
    repair_records = [record for record in selected if is_repair_record(record)]
    effective_repair_samples = sum(1 for record in expanded if is_repair_record(record))
    return {
        "originalRecordCount": len(records),
        "selectedSourceRecordCount": len(selected),
        "expandedTrainSampleCount": len(expanded),
        "repairRecordCount": len(repair_records),
        "repairRepeatFactor": options.repeat_repair_records,
        "effectiveRepairSampleCount": effective_repair_samples,
        "repairOversamplingEnabled": options.repeat_repair_records > 1,
    }


def artifact_mode(output_dir: Path) -> str:
    output_text = str(output_dir)
    if "gptoss-single-json-overfit" in output_text:
        return "single-json-overfit"
    if "gptoss-single-safety-overfit" in output_text:
        return "single-safety-overfit"
    if "gptoss-micro-overfit" in output_text:
        return "micro-overfit"
    if "gptoss-phase3-4-lowlr" in output_text:
        return "phase3-4-lowlr"
    if "gptoss-phase3-5-lowlr" in output_text:
        return "phase3-5-lowlr"
    if "gptoss-phase3-6-lowlr" in output_text:
        return "phase3-6-lowlr"
    if "gptoss-phase3-7-lowlr" in output_text:
        return "phase3-7-lowlr"
    if "gptoss-phase3-lowlr" in output_text:
        return "phase3-lowlr"
    if "gptoss-phase3" in output_text:
        return "phase3"
    if "gptoss-phase2" in output_text:
        return "phase2"
    return "smoke"


def max_steps_cap(output_dir: Path) -> int:
    mode = artifact_mode(output_dir)
    if mode in {"single-json-overfit", "single-safety-overfit"}:
        return MAX_SINGLE_RECORD_OVERFIT_STEPS
    return MAX_SAFE_STEPS


def max_samples_cap(output_dir: Path) -> int:
    if artifact_mode(output_dir) == "phase3-5-lowlr":
        return MAX_PHASE35_SAMPLES
    if artifact_mode(output_dir) == "phase3-6-lowlr":
        return MAX_PHASE36_SAMPLES
    if artifact_mode(output_dir) == "phase3-7-lowlr":
        return MAX_PHASE37_SAMPLES
    return MAX_SAFE_SAMPLES


def assert_adapter_artifacts(output_dir: Path) -> None:
    required = [
        output_dir / "adapter_config.json",
        output_dir / "adapter-metadata.json",
    ]
    missing = [str(path) for path in required if not path.exists()]
    adapter_files = list(output_dir.glob("adapter_model.*"))
    tokenizer_files = [
        path
        for path in (
            output_dir / "tokenizer.json",
            output_dir / "tokenizer_config.json",
            output_dir / "special_tokens_map.json",
        )
        if path.exists()
    ]
    if not adapter_files:
        missing.append(str(output_dir / "adapter_model.*"))
    if not tokenizer_files:
        missing.append(str(output_dir / "tokenizer.json|tokenizer_config.json|special_tokens_map.json"))
    if missing:
        raise RuntimeError(f"adapter artifact save failed; missing expected files: {', '.join(missing)}")


def positive_int(raw_value: str) -> int:
    value = int(raw_value)
    if value < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return value


def positive_float(raw_value: str) -> float:
    value = float(raw_value)
    if value <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return value


def ratio_float(raw_value: str) -> float:
    value = float(raw_value)
    if value < 0 or value > 1:
        raise argparse.ArgumentTypeError("value must be between 0 and 1")
    return value


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
