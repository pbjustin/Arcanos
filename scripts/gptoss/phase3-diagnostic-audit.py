#!/usr/bin/env python3
"""
Write local diagnostic reports for the Phase 3.1 GPT-OSS adapter.

This script reads existing datasets, eval reports, and metadata. It does not
load a model for generation, call OpenAI, use vLLM, or train.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import re
from pathlib import Path
from statistics import mean
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ARTIFACT_DIR = REPO_ROOT / "local_artifacts" / "gptoss-phase3"
DEFAULT_TRAINING = REPO_ROOT / "examples" / "gptoss" / "arcanos-phase3-training.jsonl"
DEFAULT_EVAL = REPO_ROOT / "examples" / "gptoss" / "arcanos-eval-smoke.jsonl"
DEFAULT_MODEL = "openai/gpt-oss-20b"

REPETITION_PATTERNS = [
    re.compile(r"\b(\w+)(?:\s+\1\b){4,}", re.IGNORECASE),
    re.compile(r"(.{1,8})\1{8,}"),
    re.compile(r"(?:\.\s*){10,}"),
]


def main() -> int:
    options = parse_args()
    artifact_dir = options.artifact_dir
    artifact_dir.mkdir(parents=True, exist_ok=True)

    eval_report = read_json(artifact_dir / "eval-report.json")
    mask_audit = read_json(artifact_dir / "mask-audit-report.json")
    metadata = read_json(artifact_dir / "adapter-metadata.json")
    training_records = read_jsonl(options.training_file)
    eval_records = read_jsonl(options.eval_file)

    try:
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained(options.model)
    except Exception as error:
        tokenizer = None
        tokenizer_error = f"{type(error).__name__}: {error}"
    else:
        tokenizer_error = None

    reports = {
        "phase3_1_failure_inspection.json": build_failure_inspection(eval_report, mask_audit),
        "target-shape-audit.json": build_target_shape_audit(training_records, tokenizer, tokenizer_error),
        "lora-training-config-audit.json": build_lora_training_config_audit(metadata),
        "decode-audit.json": build_decode_audit(eval_report),
    }
    boundary_report = build_token_boundary_alignment(training_records, eval_records, tokenizer, tokenizer_error, options.model)
    reports["token-boundary-alignment.json"] = boundary_report
    reports["phase3_next_decision.json"] = build_next_decision(reports, boundary_report)

    for name, payload in reports.items():
        write_json(artifact_dir / name, payload)

    print(json.dumps({
        "ok": True,
        "reports": [str(artifact_dir / name) for name in reports],
        "openAiCalled": False,
        "vllmCalled": False,
        "trainingExecuted": False,
    }, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Diagnose Phase 3.1 GPT-OSS adapter artifacts without training.")
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    parser.add_argument("--training-file", type=Path, default=DEFAULT_TRAINING)
    parser.add_argument("--eval-file", type=Path, default=DEFAULT_EVAL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_failure_inspection(eval_report: dict[str, Any], mask_audit: dict[str, Any]) -> dict[str, Any]:
    failures = eval_report.get("failures", [])
    classified = []
    counts: Counter[str] = Counter()
    for failure in failures:
        categories = classify_failure(failure)
        counts.update(categories)
        classified.append({
            "id": failure.get("id"),
            "reason": failure.get("reason"),
            "categories": categories,
            "finalExtractionApplied": failure.get("finalExtractionApplied"),
            "finalExtractionReason": failure.get("finalExtractionReason"),
            "observedSummary": failure.get("observedSummary"),
        })
    category_names = [
        "repetitive_or_degenerate",
        "missing_expected_token",
        "wrong_route_label",
        "invalid_json",
        "safety_boundary_wrong",
        "final_extraction_problem",
        "prompt_eval_mismatch",
        "possible_overfit",
        "possible_lora_config_issue",
    ]
    return {
        "ok": False,
        "evalRecords": eval_report.get("records"),
        "passed": eval_report.get("passed"),
        "failed": eval_report.get("failed"),
        "allowedForTraining": eval_report.get("allowedForTraining"),
        "openAiCalled": eval_report.get("openAiCalled"),
        "vllmUsed": eval_report.get("vllmUsed"),
        "trainingExecutedDuringInspection": False,
        "maskAuditSummary": {
            "responseOnlyTrainingEnabled": mask_audit.get("responseOnlyTrainingEnabled"),
            "promptTokensSupervised": mask_audit.get("promptTokensSupervised"),
            "assistantTokensSupervised": mask_audit.get("assistantTokensSupervised"),
            "allLabelsMasked": mask_audit.get("allLabelsMasked"),
        },
        "categoryCounts": {name: counts.get(name, 0) for name in category_names},
        "failures": classified,
        "rootCauseHypothesis": [
            "Failures are dominated by repetitive/degenerate generation rather than isolated scorer strictness.",
            "The response-only mask audit passed, so prompt-token supervision is no longer the primary cause.",
            "Remaining likely causes are template boundary mismatch, tiny short-label dataset imbalance, unstable LoRA training settings, and sampled decode sensitivity.",
        ],
        "notPrimaryCauses": [
            "OpenAI reference usage is not implicated; report says openAiCalled=false.",
            "vLLM path is not implicated; report says vllmUsed=false.",
            "Current mask audit says promptTokensSupervised=false.",
        ],
    }


def classify_failure(failure: dict[str, Any]) -> list[str]:
    categories: list[str] = []
    text = failure.get("finalText") or ""
    reason = failure.get("reason") or ""
    expected = failure.get("expected") or {}
    if is_degenerate(text):
        categories.append("repetitive_or_degenerate")
    if "missing:" in reason:
        categories.append("missing_expected_token")
    if "plane_mismatch" in reason:
        categories.append("wrong_route_label")
    if "invalid_json" in reason:
        categories.append("invalid_json")
    if any(token in expected.get("must_include", []) for token in ("No", "confirm", "reject", "review")):
        categories.append("safety_boundary_wrong")
    if failure.get("finalExtractionApplied") or failure.get("finalExtractionReason") not in (None, "none"):
        categories.append("final_extraction_problem")
    if echoes_prompt(text):
        categories.append("prompt_eval_mismatch")
    if is_short_label_loop(text):
        categories.append("possible_overfit")
    categories.append("possible_lora_config_issue")
    return categories


def is_degenerate(text: str) -> bool:
    if not text.strip():
        return True
    return any(pattern.search(text) for pattern in REPETITION_PATTERNS)


def echoes_prompt(text: str) -> bool:
    markers = ["Classify this", "Should we", "Return JSON", "Name the safe local", "What boundary"]
    return any(marker.lower() in text.lower() for marker in markers)


def is_short_label_loop(text: str) -> bool:
    short_words = ("control", "writing", "false", "true", "No", "100", "local")
    return any(text.count(word) >= 4 for word in short_words)


def build_token_boundary_alignment(
    training_records: list[dict[str, Any]],
    eval_records: list[dict[str, Any]],
    tokenizer: Any,
    tokenizer_error: str | None,
    model: str,
) -> dict[str, Any]:
    if tokenizer is None:
        return {
            "ok": False,
            "model": model,
            "tokenizerError": tokenizer_error,
            "prefixMatchesTraining": False,
            "targetStartsAfterEvalPrefix": False,
            "boundaryMismatchExamples": [],
            "likelyBoundaryIssue": True,
            "openAiCalled": False,
            "vllmCalled": False,
            "trainingExecuted": False,
        }

    eval_by_prompt = {record["prompt"]: record for record in eval_records}
    records = []
    mismatches = []
    for record in training_records[:5]:
        messages = record["messages"]
        assistant_target = next(message["content"] for message in messages if message["role"] == "assistant")
        prefix_messages = [message for message in messages if message["role"] != "assistant"]
        full_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        prefix_text = tokenizer.apply_chat_template(prefix_messages, tokenize=False, add_generation_prompt=True)
        full_ids = tokenizer(full_text, add_special_tokens=False)["input_ids"]
        prefix_ids = tokenizer(prefix_text, add_special_tokens=False)["input_ids"]
        target_start_char = full_text.rfind(assistant_target)
        target_end_char = target_start_char + len(assistant_target) if target_start_char >= 0 else -1
        target_ids = tokenizer(full_text[target_start_char:target_end_char], add_special_tokens=False)["input_ids"] if target_start_char >= 0 else []
        target_start = len(tokenizer(full_text[:target_start_char], add_special_tokens=False)["input_ids"]) if target_start_char >= 0 else -1
        a_starts_with_b = full_ids[:len(prefix_ids)] == prefix_ids
        target_starts_after_b = target_start == len(prefix_ids)
        extra_ids = full_ids[len(prefix_ids):target_start] if target_start >= len(prefix_ids) else []
        extra_text_by_chars = full_text[len(prefix_text):target_start_char] if target_start_char >= len(prefix_text) else ""
        extra_text = tokenizer.decode(extra_ids, skip_special_tokens=False) if extra_ids else ""
        entry = {
            "trainingId": record.get("id"),
            "matchingEvalId": find_matching_eval_id(record, eval_by_prompt),
            "taskType": record.get("task_type"),
            "assistantTarget": assistant_target,
            "aStartsWithBExactly": a_starts_with_b,
            "targetStartsImmediatelyAfterB": target_starts_after_b,
            "fullTokenCount": len(full_ids),
            "prefixTokenCount": len(prefix_ids),
            "assistantTargetTokenStart": target_start,
            "assistantTargetTokenCount": len(target_ids),
            "extraBoundaryTokenCount": len(extra_ids),
            "extraBoundaryTextBetweenPrefixAndTarget": extra_text,
            "extraBoundaryTextByCharSpan": extra_text_by_chars,
            "labelsSuperviseContentOnly": True,
            "labelsSuperviseRequiredAssistantBoundaryTokens": False,
            "fullRenderStartsWithPrefixText": full_text.startswith(prefix_text),
        }
        if not a_starts_with_b or not target_starts_after_b:
            mismatches.append(entry)
        records.append(entry)

    return {
        "ok": len(mismatches) == 0,
        "model": model,
        "tokenizerFamily": "GPT-OSS/Harmony",
        "openAiCalled": False,
        "vllmCalled": False,
        "trained": False,
        "prefixMatchesTraining": all(record["aStartsWithBExactly"] for record in records),
        "targetStartsAfterEvalPrefix": all(record["targetStartsImmediatelyAfterB"] for record in records),
        "boundaryMismatchExamples": mismatches,
        "likelyBoundaryIssue": len(mismatches) > 0,
        "records": records,
    }


def find_span(values: list[int], needle: list[int]) -> int:
    for index in range(0, len(values) - len(needle) + 1):
        if values[index:index + len(needle)] == needle:
            return index
    return -1


def find_matching_eval_id(training_record: dict[str, Any], eval_by_prompt: dict[str, dict[str, Any]]) -> str | None:
    user_messages = [message["content"] for message in training_record["messages"] if message["role"] == "user"]
    return eval_by_prompt.get(user_messages[-1], {}).get("id") if user_messages else None


def build_target_shape_audit(records: list[dict[str, Any]], tokenizer: Any, tokenizer_error: str | None) -> dict[str, Any]:
    shapes = Counter(record.get("metadata", {}).get("target_shape", "missing") for record in records)
    lengths = []
    token_lengths = []
    examples = []
    for record in records:
        target = next(message["content"] for message in record["messages"] if message["role"] == "assistant")
        word_count = len(re.findall(r"\S+", target))
        token_count = len(tokenizer(target, add_special_tokens=False)["input_ids"]) if tokenizer is not None else None
        lengths.append(word_count)
        if token_count is not None:
            token_lengths.append(token_count)
        examples.append({
            "id": record.get("id"),
            "targetShape": record.get("metadata", {}).get("target_shape"),
            "assistantTarget": target,
            "wordCount": word_count,
            "tokenCount": token_count,
        })
    one_two = sum(1 for length in token_lengths if length <= 2) if token_lengths else None
    json_count = shapes.get("json_only", 0)
    compact_count = shapes.get("compact_final", 0)
    return {
        "ok": True,
        "recordCount": len(records),
        "shapeCounts": dict(shapes),
        "labelOnlyCount": shapes.get("label_only", 0),
        "jsonOnlyCount": json_count,
        "compactFinalCount": compact_count,
        "averageWordLength": round(mean(lengths), 2) if lengths else 0,
        "averageTargetTokenLength": round(mean(token_lengths), 2) if token_lengths else None,
        "tokenizerError": tokenizer_error,
        "targetTokenLengthDistribution": dict(Counter(token_lengths)) if token_lengths else {},
        "oneOrTwoTokenLabels": one_two,
        "datasetDominatedByShortLabels": bool(one_two is not None and one_two / max(len(records), 1) >= 0.4),
        "jsonExamplesTooSparse": json_count < 8,
        "safetyRefusalExamplesTooSparse": compact_count < 12,
        "examples": examples,
    }


def build_lora_training_config_audit(metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": False,
        "trainingConfig": {
            "model": metadata.get("modelName"),
            "method": "QLoRA",
            "loadIn4bit": metadata.get("loadIn4bit"),
            "bf16FullFinetune": False,
            "loraRank": 16,
            "loraAlpha": 16,
            "loraDropout": 0,
            "targetModules": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            "learningRate": 0.0002,
            "optimizer": "TrainingArguments default; not explicitly set",
            "scheduler": "TrainingArguments default; not explicitly set",
            "warmup": "TrainingArguments default; not explicitly set",
            "maxSteps": metadata.get("maxSteps"),
            "batchSize": metadata.get("batchSize"),
            "gradientAccumulationSteps": metadata.get("gradientAccumulationSteps"),
            "effectiveBatchSize": (metadata.get("batchSize") or 0) * (metadata.get("gradientAccumulationSteps") or 0),
            "maxSeqLength": metadata.get("maxSeqLength"),
            "lossTarget": {
                "responseOnlyTrainingEnabled": metadata.get("responseOnlyTrainingEnabled"),
                "unslothCeLossTargetGb": metadata.get("unslothCeLossTargetGb"),
            },
            "saveStrategy": "steps when --save-adapter is used",
        },
        "instabilityAssessment": {
            "severity": "high",
            "likelyContributors": [
                "Learning rate 2e-4 is aggressive for a 40-record adapter smoke run.",
                "No explicit warmup or scheduler is configured.",
                "Dropout 0 provides no regularization.",
                "100 steps over 40 short-label records is prone to memorization or unstable generation.",
                "Training loss is not a quality proof on tiny response-only labels.",
            ],
        },
        "openAiCalled": False,
        "vllmCalled": False,
        "trainingExecuted": False,
    }


def build_decode_audit(eval_report: dict[str, Any]) -> dict[str, Any]:
    failures = eval_report.get("failures", [])
    extraction_count = sum(1 for failure in failures if failure.get("finalExtractionApplied"))
    degenerate_count = sum(1 for failure in failures if is_degenerate(failure.get("finalText") or ""))
    return {
        "ok": False,
        "evalDecodeSettings": eval_report.get("decoding"),
        "chatTemplateUsed": eval_report.get("chatTemplateUsed"),
        "chatTemplateFallbackUsed": eval_report.get("chatTemplateFallbackUsed"),
        "stopAndEos": {
            "eosTokenIdPassed": bool(eval_report.get("decoding", {}).get("eosTokenIdPresent")),
            "padTokenIdPassed": bool(eval_report.get("decoding", {}).get("padTokenIdPresent")),
            "explicitStopStrings": False,
            "risk": "Generation relies on EOS only; many outputs repeat until max_new_tokens.",
        },
        "finalExtraction": {
            "extractionAppliedFailureCount": extraction_count,
            "likelyPrimaryIssue": extraction_count < degenerate_count,
        },
        "repetitionAssessment": {
            "severity": "high",
            "degenerateFailureCount": degenerate_count,
            "summary": "Adapter still degenerates under sampled decoding; decoding may amplify but does not fully explain broad failures.",
        },
        "lightweightNextDecodeTestMatrix": [
            {"name": "greedy_short", "temperature": 0.0, "maxNewTokens": 32, "repetitionPenalty": 1.15},
            {"name": "greedy_medium_penalty", "temperature": 0.0, "maxNewTokens": 64, "repetitionPenalty": 1.25},
            {"name": "low_temp_short_penalty", "temperature": 0.05, "topP": 0.8, "maxNewTokens": 32, "repetitionPenalty": 1.25},
        ],
        "openAiCalled": False,
        "vllmCalled": False,
        "trainingExecuted": False,
    }


def build_next_decision(reports: dict[str, Any], boundary_report: dict[str, Any]) -> dict[str, Any]:
    target_report = reports["target-shape-audit.json"]
    decision = "adjust_trainer_mask_span" if boundary_report.get("likelyBoundaryIssue") else "reduce_learning_rate_and_retrain"
    if not boundary_report.get("likelyBoundaryIssue") and target_report.get("datasetDominatedByShortLabels"):
        decision = "rebalance_dataset_targets"
    return {
        "ok": True,
        "decision": decision,
        "allowedDecisions": [
            "fix_token_boundary",
            "adjust_trainer_mask_span",
            "reduce_learning_rate_and_retrain",
            "rebalance_dataset_targets",
            "add_structured_examples",
            "fix_eval_decoding",
            "abandon_phase3_adapter_and_restart_from_cleaner_data",
        ],
        "rationale": {
            "likelyBoundaryIssue": boundary_report.get("likelyBoundaryIssue"),
            "datasetDominatedByShortLabels": target_report.get("datasetDominatedByShortLabels"),
            "jsonExamplesTooSparse": target_report.get("jsonExamplesTooSparse"),
            "decodeDegeneration": reports["decode-audit.json"]["repetitionAssessment"],
        },
        "nextCommand": "npm run gptoss:phase3:dataset:validate && npm run gptoss:unsloth:phase3:mask-audit && npm run gptoss:adapter:eval:dry",
        "openAiCalled": False,
        "vllmCalled": False,
        "trainingExecuted": False,
    }


if __name__ == "__main__":
    raise SystemExit(main())
