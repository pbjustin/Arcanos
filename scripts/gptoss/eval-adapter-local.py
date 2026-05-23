#!/usr/bin/env python3
"""
Evaluate a local GPT-OSS LoRA adapter against the Arcanos smoke eval set.

Dry-run validates paths, metadata, and eval records only. Execute mode loads the
base model plus local adapter and writes a compact local report.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_ADAPTER_DIR = REPO_ROOT / "local_artifacts" / "gptoss-phase2"
DEFAULT_EVAL_FILE = REPO_ROOT / "examples" / "gptoss" / "arcanos-eval-smoke.jsonl"
DEFAULT_OUTPUT = DEFAULT_ADAPTER_DIR / "eval-report.json"
DEFAULT_MODEL = "openai/gpt-oss-20b"
DEFAULT_MAX_NEW_TOKENS = 96
DEFAULT_TEMPERATURE = 0.1
DEFAULT_TOP_P = 0.9
DEFAULT_REPETITION_PENALTY = 1.15
SAFE_SOURCES = {"arcanos_owned_spec", "repo_schema", "human_authored"}
FORBIDDEN_PATTERNS = [
    re.compile(r"OPENAI_API_KEY", re.IGNORECASE),
    re.compile(r"RAILWAY_API_TOKEN", re.IGNORECASE),
    re.compile(r"DATABASE_URL", re.IGNORECASE),
    re.compile(r"Bearer\s+", re.IGNORECASE),
    re.compile(r"hidden reasoning", re.IGNORECASE),
    re.compile(r"chain of thought", re.IGNORECASE),
]
SAFE_ACTION_CANONICALIZATION_ALLOWLIST = {
    "validate_dataset",
    "railway.logs",
    "railway.status",
    "railway.variables.list",
    "reject",
    "reject_training_from_raw_logs",
}
ACTION_CANONICALIZATION_KEYS = ("type", "name", "id")
DASH_VARIANTS_PATTERN = re.compile(r"[\u2010\u2011\u2012\u2013\u2014\u2212]")


def main() -> int:
    options = parse_args(sys.argv[1:])
    try:
        adapter = verify_adapter(options.adapter_dir)
        records = load_eval_records(options.eval_file, options.max_records)
        ensure_local_artifact_output(options.output)
        report = build_base_report(options, adapter, len(records))
    except Exception as error:
        print_json({
            "ok": False,
            "mode": "dry-run" if options.dry_run else "execute",
            "error": "preflight_failed",
            "message": str(error),
            "allowedForTraining": False,
            "openAiCalled": False,
            "noOpenAiOutputUsed": False,
        })
        return 2

    if options.dry_run:
        print_json({**report, "ok": True, "mode": "dry-run", "executed": False})
        return 0

    try:
        if options.compare_base_adapter:
            comparison_result = generate_base_adapter_comparison(options, records)
            final_report = score_comparison_outputs(report, records, comparison_result)
        else:
            generation_result = generate_outputs(options, records, load_adapter=True)
            final_report = score_outputs(report, records, generation_result["outputs"])
            final_report = {
                **final_report,
                "chatTemplateUsed": generation_result["chatTemplateUsed"],
                "chatTemplateFallbackUsed": generation_result["chatTemplateFallbackUsed"],
                "decoding": generation_result["decoding"],
            }
        options.output.parent.mkdir(parents=True, exist_ok=True)
        options.output.write_text(json.dumps(final_report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print_json(final_report)
        return 0 if final_report["failed"] == 0 else 1
    except Exception as error:
        print_json({**report, "ok": False, "mode": "execute", "executed": False, "error": "adapter_eval_failed", "message": str(error)})
        return 3


def parse_args(raw_args: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a local GPT-OSS LoRA adapter without OpenAI or vLLM.")
    parser.add_argument("--adapter-dir", type=Path, default=Path(os.environ.get("ARCANOS_GPTOSS_ADAPTER_DIR", DEFAULT_ADAPTER_DIR)))
    parser.add_argument("--eval-file", type=Path, default=Path(os.environ.get("ARCANOS_GPTOSS_EVAL_FILE", DEFAULT_EVAL_FILE)))
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("ARCANOS_GPTOSS_ADAPTER_EVAL_REPORT", DEFAULT_OUTPUT)))
    parser.add_argument("--model", default=os.environ.get("ARCANOS_GPTOSS_MODEL", DEFAULT_MODEL))
    parser.add_argument("--max-records", type=positive_int, default=None)
    parser.add_argument("--max-seq-length", type=positive_int, default=int(os.environ.get("ARCANOS_MAX_SEQ_LENGTH", "256")))
    parser.add_argument("--max-new-tokens", type=positive_int, default=int(os.environ.get("ARCANOS_EVAL_MAX_NEW_TOKENS", str(DEFAULT_MAX_NEW_TOKENS))))
    parser.add_argument("--temperature", type=float, default=float(os.environ.get("ARCANOS_EVAL_TEMPERATURE", str(DEFAULT_TEMPERATURE))))
    parser.add_argument("--top-p", type=float, default=float(os.environ.get("ARCANOS_EVAL_TOP_P", str(DEFAULT_TOP_P))))
    parser.add_argument("--repetition-penalty", type=float, default=float(os.environ.get("ARCANOS_EVAL_REPETITION_PENALTY", str(DEFAULT_REPETITION_PENALTY))))
    parser.add_argument("--compare-base-adapter", action="store_true", help="Run a sequential max-3 base-vs-adapter comparison.")
    parser.add_argument("--force-final-channel", action="store_true", help="Diagnostic mode: force the tokenizer-derived Harmony final-channel boundary before generation.")
    parser.add_argument("--prefill-json-start", action="store_true", help="Diagnostic mode: prefill JSON-only final answers with { after a final-channel-safe prefix.")
    parser.add_argument("--router-classifier-mode", action="store_true", help="Local-only router/action classifier mode with final-channel forcing and narrow label normalization.")
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--execute", action="store_false", dest="dry_run", help="Load the model and run generation.")
    options = parser.parse_args(raw_args)
    if options.compare_base_adapter:
        if options.max_records is None:
            options.max_records = 3
        if "--max-new-tokens" not in raw_args and "ARCANOS_EVAL_MAX_NEW_TOKENS" not in os.environ:
            options.max_new_tokens = 32
        if "--temperature" not in raw_args and "ARCANOS_EVAL_TEMPERATURE" not in os.environ:
            options.temperature = 0.0
    if options.router_classifier_mode:
        options.force_final_channel = True
    return options


def verify_adapter(adapter_dir: Path) -> dict[str, Any]:
    if not adapter_dir.exists() or not adapter_dir.is_dir():
        raise FileNotFoundError(f"adapter directory is missing: {adapter_dir}")

    metadata_path = adapter_dir / "adapter-metadata.json"
    required = [adapter_dir / "adapter_config.json", metadata_path]
    missing = [str(path) for path in required if not path.exists()]
    adapter_files = sorted(adapter_dir.glob("adapter_model.*"))
    if not adapter_files:
        missing.append(str(adapter_dir / "adapter_model.*"))
    if missing:
        raise FileNotFoundError(f"adapter artifacts are incomplete; missing: {', '.join(missing)}")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("noOpenAiOutputUsed") is not True:
        raise ValueError("adapter metadata must contain noOpenAiOutputUsed=true")

    return {
        "adapterDir": str(adapter_dir),
        "metadataPath": str(metadata_path),
        "adapterFiles": [{"path": str(path), "bytes": path.stat().st_size} for path in adapter_files],
        "metadata": metadata,
    }


def load_eval_records(eval_file: Path, max_records: int | None) -> list[dict[str, Any]]:
    if not eval_file.exists():
        raise FileNotFoundError(f"eval file is missing: {eval_file}")
    records = []
    for line_number, raw_line in enumerate(eval_file.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        record = json.loads(raw_line)
        errors = validate_eval_record(record)
        if errors:
            raise ValueError(f"line {line_number}: {', '.join(errors)}")
        records.append(record)
        if max_records is not None and len(records) >= max_records:
            break
    if not records:
        raise ValueError("eval file has no records")
    return records


def validate_eval_record(record: dict[str, Any]) -> list[str]:
    errors = []
    if record.get("source") not in SAFE_SOURCES:
        errors.append("unsafe_source")
    if record.get("allowed_for_eval") is not True:
        errors.append("eval_not_allowed")
    if not isinstance(record.get("id"), str) or not record["id"].strip():
        errors.append("id_required")
    if not isinstance(record.get("prompt"), str) or not record["prompt"].strip():
        errors.append("prompt_required")
    if not isinstance(record.get("expected"), dict):
        errors.append("expected_required")
    assertion_text = " ".join([
        str(record.get("prompt", "")),
        *[str(item) for item in record.get("expected", {}).get("must_include", [])],
    ])
    if any(pattern.search(assertion_text) for pattern in FORBIDDEN_PATTERNS):
        errors.append("forbidden_marker")
    return errors


def ensure_local_artifact_output(output_path: Path) -> None:
    resolved_output = output_path.resolve()
    resolved_artifacts = (REPO_ROOT / "local_artifacts").resolve()
    if resolved_artifacts not in resolved_output.parents:
        raise ValueError(f"eval report must stay under local_artifacts: {output_path}")


def build_base_report(options: argparse.Namespace, adapter: dict[str, Any], record_count: int) -> dict[str, Any]:
    return {
        "adapterDir": str(options.adapter_dir),
        "adapterFiles": adapter["adapterFiles"],
        "evalFile": str(options.eval_file),
        "model": f"{options.model} + local LoRA adapter",
        "records": record_count,
        "reportPath": str(options.output),
        "maxSeqLength": options.max_seq_length,
        "maxNewTokens": options.max_new_tokens,
        "chatTemplateUsed": False,
        "chatTemplateFallbackUsed": False,
        "decoding": {
            "maxNewTokens": options.max_new_tokens,
            "temperature": options.temperature,
            "topP": options.top_p,
            "repetitionPenalty": options.repetition_penalty,
            "doSample": options.temperature > 0,
            "eosTokenIdPresent": False,
            "padTokenIdPresent": False,
        },
        "forceFinalChannel": options.force_final_channel,
        "prefillJsonStart": options.prefill_json_start,
        "routerClassifierMode": options.router_classifier_mode,
        "diagnosticModes": {
            "forceFinalChannel": options.force_final_channel,
            "prefillJsonStart": options.prefill_json_start,
            "routerClassifierMode": options.router_classifier_mode,
        },
        "allowedForTraining": False,
        "openAiCalled": False,
        "noOpenAiOutputUsed": True,
        "trainingExecuted": False,
        "vllmUsed": False,
        "baseVsAdapterComparison": {
            "planned": options.compare_base_adapter,
            "maxRecords": record_count if options.compare_base_adapter else 0,
            "executeCommand": "node scripts/gptoss/eval-adapter-local.mjs --execute --compare-base-adapter --max-records 3",
        },
        "compareBaseAdapter": options.compare_base_adapter,
    }


def generate_base_adapter_comparison(options: argparse.Namespace, records: list[dict[str, Any]]) -> dict[str, Any]:
    base_result = generate_outputs(options, records, load_adapter=False)
    release_gpu_memory()
    adapter_result = generate_outputs(options, records, load_adapter=True)
    return {
        "base": base_result,
        "adapter": adapter_result,
    }


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


def generate_outputs(options: argparse.Namespace, records: list[dict[str, Any]], load_adapter: bool) -> dict[str, Any]:
    from unsloth import FastLanguageModel
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; adapter eval requires the local GPU")

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=options.model,
        max_seq_length=options.max_seq_length,
        load_in_4bit=True,
    )
    if load_adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, str(options.adapter_dir))
    try:
        FastLanguageModel.for_inference(model)
    except Exception:
        model.eval()

    eos_token_id = tokenizer.eos_token_id
    pad_token_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else eos_token_id
    generation_kwargs = {
        "max_new_tokens": options.max_new_tokens,
        "do_sample": options.temperature > 0,
        "temperature": options.temperature,
        "top_p": options.top_p,
        "repetition_penalty": options.repetition_penalty,
        "eos_token_id": eos_token_id,
        "pad_token_id": pad_token_id,
    }
    if options.temperature <= 0:
        generation_kwargs.pop("temperature", None)
        generation_kwargs.pop("top_p", None)

    outputs: dict[str, str] = {}
    chat_template_used = False
    chat_template_fallback_used = False
    for record in records:
        prompt, used_template, prompt_diagnostics = build_prompt(tokenizer, record, options)
        chat_template_used = chat_template_used or used_template
        chat_template_fallback_used = chat_template_fallback_used or not used_template
        prompt_token_limit = max(32, options.max_seq_length - options.max_new_tokens)
        inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=prompt_token_limit).to(model.device)
        prefix_ids = inputs["input_ids"][0].detach().cpu().tolist()
        last_prefix_token_ids = prefix_ids[-16:]
        prompt_diagnostics = {
            **prompt_diagnostics,
            "lastPrefixTokenIds": last_prefix_token_ids,
            "lastPrefixDecodedPreview": tokenizer.decode(last_prefix_token_ids, skip_special_tokens=False)[-300:],
        }
        with torch.inference_mode():
            generated = model.generate(**inputs, **generation_kwargs)
        new_tokens = generated[0][inputs["input_ids"].shape[-1]:]
        raw_text = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
        expects_json = is_json_eval_record(record)
        assembled_text = f"{{{raw_text}" if prompt_diagnostics["jsonPrefillApplied"] else raw_text
        extraction = extract_final_output(assembled_text, expects_json)
        json_diagnostics = inspect_json_result(extraction["finalText"], record) if expects_json else {
            "validJson": None,
            "jsonParseError": None,
            "requiredJsonFieldsPresent": None,
        }
        outputs[record["id"]] = {
            "rawGeneratedText": raw_text,
            "rawGeneratedTextSummary": summarize_output(raw_text),
            "finalText": extraction["finalText"],
            "routerClassifierMode": options.router_classifier_mode,
            "finalExtractionApplied": extraction["finalExtractionApplied"],
            "finalExtractionReason": extraction["finalExtractionReason"],
            "assembledFinalText": assembled_text if prompt_diagnostics["jsonPrefillApplied"] else extraction["finalText"],
            **prompt_diagnostics,
            **json_diagnostics,
        }
    return {
        "outputs": outputs,
        "chatTemplateUsed": chat_template_used,
        "chatTemplateFallbackUsed": chat_template_fallback_used,
        "decoding": {
            "maxNewTokens": options.max_new_tokens,
            "temperature": options.temperature,
            "topP": options.top_p,
            "repetitionPenalty": options.repetition_penalty,
            "doSample": options.temperature > 0,
            "eosTokenIdPresent": eos_token_id is not None,
            "padTokenIdPresent": pad_token_id is not None,
        },
    }


def score_comparison_outputs(base_report: dict[str, Any], records: list[dict[str, Any]], comparison_result: dict[str, Any]) -> dict[str, Any]:
    base_scored = score_record_outputs(records, comparison_result["base"]["outputs"])
    adapter_scored = score_record_outputs(records, comparison_result["adapter"]["outputs"])
    comparisons = []
    improved = 0
    regressed = 0
    same = 0
    for record in records:
        record_id = record["id"]
        base_output = comparison_result["base"]["outputs"].get(record_id, missing_output())
        adapter_output = comparison_result["adapter"]["outputs"].get(record_id, missing_output())
        base_failures = evaluate_output(record, base_output["finalText"])
        adapter_failures = evaluate_output(record, adapter_output["finalText"])
        base_passed = len(base_failures) == 0
        adapter_passed = len(adapter_failures) == 0
        adapter_improved = adapter_passed and not base_passed
        adapter_regressed = base_passed and not adapter_passed
        same_outcome = base_passed == adapter_passed
        improved += 1 if adapter_improved else 0
        regressed += 1 if adapter_regressed else 0
        same += 1 if same_outcome else 0
        comparisons.append({
            "id": record_id,
            "base": {
                "generated": bool(base_output["rawGeneratedText"] or base_output["finalText"]),
                "finalText": base_output["finalText"],
                "passed": base_passed,
                "failureReasons": base_failures,
            },
            "adapter": {
                "generated": bool(adapter_output["rawGeneratedText"] or adapter_output["finalText"]),
                "finalText": adapter_output["finalText"],
                "passed": adapter_passed,
                "failureReasons": adapter_failures,
            },
            "delta": {
                "adapterImproved": adapter_improved,
                "adapterRegressed": adapter_regressed,
                "sameOutcome": same_outcome,
                "summary": summarize_delta(base_passed, adapter_passed),
            },
        })

    return {
        **base_report,
        "ok": adapter_scored["failed"] == 0,
        "mode": "execute",
        "executed": True,
        "compareBaseAdapter": True,
        "chatTemplateUsed": comparison_result["base"]["chatTemplateUsed"] or comparison_result["adapter"]["chatTemplateUsed"],
        "chatTemplateFallbackUsed": comparison_result["base"]["chatTemplateFallbackUsed"] or comparison_result["adapter"]["chatTemplateFallbackUsed"],
        "decoding": comparison_result["adapter"]["decoding"],
        "baseRecordsEvaluated": len(records),
        "adapterRecordsEvaluated": len(records),
        "basePassed": base_scored["passed"],
        "adapterPassed": adapter_scored["passed"],
        "adapterImprovedCount": improved,
        "adapterRegressedCount": regressed,
        "sameOutcomeCount": same,
        "comparisons": comparisons,
        "passed": adapter_scored["passed"],
        "failed": adapter_scored["failed"],
        "failures": adapter_scored["failures"],
        "results": adapter_scored["results"],
    }


def score_record_outputs(records: list[dict[str, Any]], outputs: dict[str, dict[str, Any]]) -> dict[str, Any]:
    failures = []
    results = []
    for record in records:
        output = outputs.get(record["id"], missing_output())
        analysis = analyze_output(record, output["finalText"], output)
        record_failures = analysis["failures"]
        results.append({
            "id": record["id"],
            "passed": len(record_failures) == 0,
            "failures": record_failures,
            "routerClassifierMode": output.get("routerClassifierMode", False),
            "normalizedLabel": analysis["normalizedLabel"],
            "normalizationApplied": analysis["normalizationApplied"],
            "canonicalizationApplied": analysis["canonicalizationApplied"],
            "canonicalizationReason": analysis["canonicalizationReason"],
            "canonicalAction": analysis["canonicalAction"],
            "originalActionShape": analysis["originalActionShape"],
            "canonicalizedJson": analysis["canonicalizedJson"],
            "policyOverrideApplied": analysis["policyOverrideApplied"],
            "policyRule": analysis["policyRule"],
            "policyPassed": analysis["policyPassed"],
            "policyOverrideResult": analysis["policyOverrideResult"],
            "scoringSurface": analysis["scoringSurface"],
            "scoringSurfaceSource": analysis["scoringSurfaceSource"],
            "requiredTokenCheckAppliedToCanonicalSurface": analysis["requiredTokenCheckAppliedToCanonicalSurface"],
            "answeredInsteadOfClassified": analysis["answeredInsteadOfClassified"],
            "classificationPassed": analysis["classificationPassed"],
            "rawGeneratedTextSummary": summarize_output(output["rawGeneratedText"]),
            "finalText": output["finalText"],
            "finalExtractionApplied": output["finalExtractionApplied"],
            "finalExtractionReason": output["finalExtractionReason"],
            "addGenerationPromptUsed": output.get("addGenerationPromptUsed"),
            "generationPrefixTail": output.get("generationPrefixTail"),
            "prefixAppearsAnalysisChannel": output.get("prefixAppearsAnalysisChannel"),
            "prefixAppearsFinalChannel": output.get("prefixAppearsFinalChannel"),
            "finalBoundaryCandidate": output.get("finalBoundaryCandidate"),
            "finalBoundaryTokenIds": output.get("finalBoundaryTokenIds"),
            "lastPrefixTokenIds": output.get("lastPrefixTokenIds"),
            "lastPrefixDecodedPreview": output.get("lastPrefixDecodedPreview"),
            "forceFinalChannel": output.get("forceFinalChannel"),
            "finalChannelBoundaryApplied": output.get("finalChannelBoundaryApplied"),
            "finalChannelBoundarySource": output.get("finalChannelBoundarySource"),
            "finalChannelBoundaryTextPreview": output.get("finalChannelBoundaryTextPreview"),
            "jsonPrefillApplied": output.get("jsonPrefillApplied"),
            "jsonPrefillText": output.get("jsonPrefillText"),
            "assembledFinalText": output.get("assembledFinalText"),
            "validJson": output.get("validJson"),
            "jsonParseError": output.get("jsonParseError"),
            "requiredJsonFieldsPresent": output.get("requiredJsonFieldsPresent"),
        })
        if record_failures:
            failures.append({
                "id": record["id"],
                "reason": ", ".join(record_failures),
                "expected": record["expected"],
                "routerClassifierMode": output.get("routerClassifierMode", False),
                "normalizedLabel": analysis["normalizedLabel"],
                "normalizationApplied": analysis["normalizationApplied"],
                "canonicalizationApplied": analysis["canonicalizationApplied"],
                "canonicalizationReason": analysis["canonicalizationReason"],
                "canonicalAction": analysis["canonicalAction"],
                "originalActionShape": analysis["originalActionShape"],
                "canonicalizedJson": analysis["canonicalizedJson"],
                "policyOverrideApplied": analysis["policyOverrideApplied"],
                "policyRule": analysis["policyRule"],
                "policyPassed": analysis["policyPassed"],
                "policyOverrideResult": analysis["policyOverrideResult"],
                "scoringSurface": analysis["scoringSurface"],
                "scoringSurfaceSource": analysis["scoringSurfaceSource"],
                "requiredTokenCheckAppliedToCanonicalSurface": analysis["requiredTokenCheckAppliedToCanonicalSurface"],
                "answeredInsteadOfClassified": analysis["answeredInsteadOfClassified"],
                "classificationPassed": analysis["classificationPassed"],
                "rawGeneratedTextSummary": summarize_output(output["rawGeneratedText"]),
                "finalText": output["finalText"],
                "finalExtractionApplied": output["finalExtractionApplied"],
                "finalExtractionReason": output["finalExtractionReason"],
                "addGenerationPromptUsed": output.get("addGenerationPromptUsed"),
                "generationPrefixTail": output.get("generationPrefixTail"),
                "prefixAppearsAnalysisChannel": output.get("prefixAppearsAnalysisChannel"),
                "prefixAppearsFinalChannel": output.get("prefixAppearsFinalChannel"),
                "finalBoundaryCandidate": output.get("finalBoundaryCandidate"),
                "finalBoundaryTokenIds": output.get("finalBoundaryTokenIds"),
                "lastPrefixTokenIds": output.get("lastPrefixTokenIds"),
                "lastPrefixDecodedPreview": output.get("lastPrefixDecodedPreview"),
                "forceFinalChannel": output.get("forceFinalChannel"),
                "finalChannelBoundaryApplied": output.get("finalChannelBoundaryApplied"),
                "finalChannelBoundarySource": output.get("finalChannelBoundarySource"),
                "finalChannelBoundaryTextPreview": output.get("finalChannelBoundaryTextPreview"),
                "jsonPrefillApplied": output.get("jsonPrefillApplied"),
                "jsonPrefillText": output.get("jsonPrefillText"),
                "assembledFinalText": output.get("assembledFinalText"),
                "validJson": output.get("validJson"),
                "jsonParseError": output.get("jsonParseError"),
                "requiredJsonFieldsPresent": output.get("requiredJsonFieldsPresent"),
                "observedSummary": summarize_output(output["finalText"]),
            })
    return {
        "passed": len(records) - len(failures),
        "failed": len(failures),
        "failures": failures,
        "results": results,
    }


def missing_output() -> dict[str, Any]:
    return {
        "rawGeneratedText": "",
        "finalText": "",
        "routerClassifierMode": False,
        "finalExtractionApplied": False,
        "finalExtractionReason": "missing_output",
        "rawGeneratedTextSummary": "",
    }


def summarize_delta(base_passed: bool, adapter_passed: bool) -> str:
    if adapter_passed and not base_passed:
        return "adapter improved from failing to passing"
    if base_passed and not adapter_passed:
        return "adapter regressed from passing to failing"
    if adapter_passed:
        return "both passed"
    return "both failed"


def build_prompt(tokenizer: Any, record: dict[str, Any], options: argparse.Namespace | None = None) -> tuple[str, bool, dict[str, Any]]:
    options = options or argparse.Namespace(force_final_channel=False, prefill_json_start=False)
    messages = build_eval_messages(record, options)
    prompt, used_template = render_generation_prefix(tokenizer, messages)
    boundary = derive_final_channel_boundary(tokenizer, messages)
    diagnostics = build_prefix_diagnostics(
        tokenizer=tokenizer,
        prompt=prompt,
        boundary=boundary,
        add_generation_prompt_used=used_template,
        force_final_channel=options.force_final_channel,
    )

    if options.force_final_channel:
        if not boundary["available"]:
            raise RuntimeError(f"{record.get('id', '<unknown>')}: final-channel boundary derivation failed: {boundary['reason']}")
        prompt = f"{prompt}{boundary['text']}"
        diagnostics = build_prefix_diagnostics(
            tokenizer=tokenizer,
            prompt=prompt,
            boundary=boundary,
            add_generation_prompt_used=used_template,
            force_final_channel=True,
        )
        diagnostics["finalChannelBoundaryApplied"] = True
        if diagnostics["prefixAppearsAnalysisChannel"] or not diagnostics["prefixAppearsFinalChannel"]:
            raise RuntimeError(f"{record.get('id', '<unknown>')}: derived boundary did not produce a final-channel-safe prefix")

    json_prefill_applied = False
    if options.prefill_json_start and is_json_eval_record(record):
        if not options.force_final_channel and not diagnostics["prefixAppearsFinalChannel"]:
            raise RuntimeError(f"{record.get('id', '<unknown>')}: --prefill-json-start requires --force-final-channel or a final-channel-safe prefix")
        prompt = f"{prompt}{{"
        json_prefill_applied = True
        diagnostics = {
            **diagnostics,
            "generationPrefixTail": prompt[-300:],
            "jsonPrefillApplied": True,
            "jsonPrefillText": "{",
        }
    else:
        diagnostics = {
            **diagnostics,
            "jsonPrefillApplied": False,
            "jsonPrefillText": None,
        }

    if options.prefill_json_start and not json_prefill_applied and not is_json_eval_record(record):
        diagnostics["jsonPrefillSkippedReason"] = "non_json_record"

    return prompt, used_template, diagnostics


def build_eval_messages(record: dict[str, Any], options: argparse.Namespace | None = None) -> list[dict[str, str]]:
    expected = record.get("expected", {})
    router_mode = bool(getattr(options, "router_classifier_mode", False))
    if router_mode and is_route_label_record(record):
        output_contract = "Classify the request. Do not answer it. Return only one of: control-plane, writing-plane."
    elif router_mode and expected.get("json_object") is True:
        output_contract = "Return only a valid JSON action envelope."
    else:
        output_contract = "Return only a JSON object." if expected.get("json_object") is True else "Return one compact final answer."
    return [
        {
            "role": "system",
            "content": "You are a local Arcanos GPT-OSS adapter under evaluation. Return only the final answer. Do not expose private rationale or secrets.",
        },
        {
            "role": "developer",
            "content": (
                "Classify or answer according to Arcanos boundaries. "
                "Use only local evaluation context. Never route system operations through the writing pipeline. "
                f"{output_contract}"
            ),
        },
        {"role": "user", "content": record["prompt"]},
    ]


def render_generation_prefix(tokenizer: Any, messages: list[dict[str, str]]) -> tuple[str, bool]:
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        try:
            return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True), True
        except Exception:
            pass

    fallback = "\n".join(
        [
            "<|system|>",
            messages[0]["content"],
            "<|developer|>",
            messages[1]["content"],
            "<|user|>",
            messages[2]["content"],
            "<|assistant|>",
        ]
    )
    return fallback, False


def derive_final_channel_boundary(tokenizer: Any, messages: list[dict[str, str]]) -> dict[str, Any]:
    if not (hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None)):
        return unavailable_boundary("chat_template_unavailable")

    sentinel = "__ARCANOS_FINAL_BOUNDARY_SENTINEL__"
    try:
        prefix = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        full = tokenizer.apply_chat_template(
            [*messages, {"role": "assistant", "content": sentinel}],
            tokenize=False,
            add_generation_prompt=False,
        )
    except Exception as error:
        return unavailable_boundary(f"chat_template_render_failed:{error}")

    start = full.rfind(sentinel)
    if start < 0:
        return unavailable_boundary("assistant_sentinel_not_found")
    if not full.startswith(prefix):
        return unavailable_boundary("full_render_does_not_start_with_generation_prefix")

    boundary = full[len(prefix):start]
    if not boundary:
        return unavailable_boundary("empty_final_boundary")
    token_ids = encode_text(tokenizer, boundary)
    if not token_ids:
        return unavailable_boundary("boundary_tokenization_empty")
    if appears_final_channel(f"{prefix}{boundary}"):
        return available_boundary("tokenizer_derived", boundary, token_ids)

    fallback = "<|channel|>final<|message|>"
    fallback_ids = encode_text(tokenizer, fallback)
    if prefix.endswith("<|start|>assistant") and fallback_ids and appears_final_channel(f"{prefix}{fallback}"):
        return available_boundary("literal_fallback", fallback, fallback_ids, "tokenizer_boundary_did_not_include_final_channel")

    return unavailable_boundary("boundary_does_not_produce_final_channel")


def available_boundary(source: str, text: str, token_ids: list[int], reason: str | None = None) -> dict[str, Any]:
    return {
        "available": True,
        "source": source,
        "text": text,
        "tokenIds": token_ids,
        "reason": reason,
    }


def unavailable_boundary(reason: str) -> dict[str, Any]:
    return {
        "available": False,
        "source": "unavailable",
        "text": "",
        "tokenIds": [],
        "reason": reason,
    }


def build_prefix_diagnostics(
    tokenizer: Any,
    prompt: str,
    boundary: dict[str, Any],
    add_generation_prompt_used: bool,
    force_final_channel: bool,
) -> dict[str, Any]:
    tail = prompt[-300:]
    prefix_analysis = appears_analysis_channel(tail)
    prefix_final = appears_final_channel(tail)
    return {
        "addGenerationPromptUsed": add_generation_prompt_used,
        "generationPrefixTail": tail,
        "prefixAppearsAnalysisChannel": prefix_analysis,
        "prefixAppearsFinalChannel": prefix_final,
        "finalBoundaryCandidate": boundary["text"] if boundary["available"] else "",
        "finalBoundaryTokenIds": boundary["tokenIds"],
        "lastPrefixTokenIds": [],
        "lastPrefixDecodedPreview": "",
        "forceFinalChannel": force_final_channel,
        "finalChannelBoundaryApplied": False,
        "finalChannelBoundarySource": boundary["source"],
        "finalChannelBoundaryTextPreview": boundary["text"][:120] if boundary["available"] else "",
        "finalChannelBoundaryTokenIds": boundary["tokenIds"],
        "finalChannelBoundaryUnavailableReason": boundary["reason"],
        "jsonPrefillApplied": False,
        "jsonPrefillText": None,
    }


def appears_analysis_channel(text: str) -> bool:
    return bool(re.search(r"<\|channel\|>\s*analysis\b|\banalysis\s*<\|message\|>|(?:^|[>\s])analysis$", text, flags=re.IGNORECASE))


def appears_final_channel(text: str) -> bool:
    return bool(re.search(r"<\|channel\|>\s*final\b|\bfinal\s*<\|message\|>", text, flags=re.IGNORECASE))


def encode_text(tokenizer: Any, text: str) -> list[int]:
    encoded = tokenizer(text, add_special_tokens=False)
    input_ids = encoded.get("input_ids") if hasattr(encoded, "get") else encoded
    if hasattr(input_ids, "tolist"):
        input_ids = input_ids.tolist()
    if input_ids and isinstance(input_ids[0], list):
        input_ids = input_ids[0]
    return list(input_ids)


def is_json_eval_record(record: dict[str, Any]) -> bool:
    expected = record.get("expected", {})
    metadata = record.get("metadata", {})
    return expected.get("json_object") is True or metadata.get("target_shape") == "json_only"


def inspect_json_result(text: str, record: dict[str, Any]) -> dict[str, Any]:
    expected = record.get("expected", {})
    if not is_json_eval_record(record):
        return {
            "validJson": None,
            "jsonParseError": None,
            "requiredJsonFieldsPresent": None,
        }

    try:
        parsed = json.loads(str(text or ""))
    except Exception as error:
        return {
            "validJson": False,
            "jsonParseError": str(error),
            "requiredJsonFieldsPresent": False,
        }

    required_fields = expected.get("required_json_fields", [])
    serialized = json.dumps(parsed, sort_keys=True, separators=(",", ":")).lower()
    required_terms = expected.get("must_include", [])
    return {
        "validJson": True,
        "jsonParseError": None,
        "requiredJsonFieldsPresent": (
            all(json_has_key(parsed, str(field)) for field in required_fields)
            and all(str(item).lower() in serialized for item in required_terms)
        ),
    }


def json_has_key(value: Any, field: str) -> bool:
    if isinstance(value, dict):
        return field in value or any(json_has_key(item, field) for item in value.values())
    if isinstance(value, list):
        return any(json_has_key(item, field) for item in value)
    return False


def extract_final_output(decoded: str, expects_json: bool) -> dict[str, Any]:
    raw = str(decoded or "").strip()
    stripped = re.sub(r"^(?:\.?assistant)?(?:analysis|commentary)+\s*", "", raw, flags=re.IGNORECASE)
    stripped = re.sub(r"^(?:assistant|final)\s*", "", stripped, flags=re.IGNORECASE)

    if expects_json:
        json_text = first_json_object(stripped)
        if json_text is not None:
            return {
                "finalText": json_text,
                "finalExtractionApplied": json_text != raw,
                "finalExtractionReason": "first_json_object",
            }

    final_markers = [
        r"\bfinal answer\s*[:\-]\s*",
        r"\bfinal\s*[:\-]\s*",
        r"\bthus\s*[:,]?\s*",
        r"\banswer\s*[:\-]\s*",
    ]
    for marker in final_markers:
        match = re.search(marker, stripped, flags=re.IGNORECASE)
        if match:
            final_text = stripped[match.end():].strip()
            if final_text:
                return {
                    "finalText": final_text,
                    "finalExtractionApplied": final_text != raw,
                    "finalExtractionReason": "final_marker",
                }

    return {
        "finalText": stripped,
        "finalExtractionApplied": stripped != raw,
        "finalExtractionReason": "channel_prefix" if stripped != raw else "none",
    }


def first_json_object(text: str) -> str | None:
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escaped = False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            elif char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[start:index + 1]
                    try:
                        json.loads(candidate)
                        return candidate
                    except Exception:
                        break
        start = text.find("{", start + 1)
    return None


def score_outputs(base_report: dict[str, Any], records: list[dict[str, Any]], outputs: dict[str, dict[str, Any]]) -> dict[str, Any]:
    scored = score_record_outputs(records, outputs)
    normalization_helped = any(result.get("normalizationApplied") and result.get("passed") for result in scored["results"])
    canonicalization_helped = any(result.get("canonicalizationApplied") and result.get("passed") for result in scored["results"])
    return {
        **base_report,
        "ok": scored["failed"] == 0,
        "mode": "execute",
        "executed": True,
        "normalizationHelped": normalization_helped,
        "canonicalizationHelped": canonicalization_helped,
        "passed": scored["passed"],
        "failed": scored["failed"],
        "failures": scored["failures"],
        "results": scored["results"],
    }


def evaluate_output(record: dict[str, Any], output: str) -> list[str]:
    return analyze_output(record, output)["failures"]


def canonicalize_action_envelope(text: str) -> dict[str, Any]:
    result = {
        "canonicalizationApplied": False,
        "canonicalizationReason": "not_evaluated",
        "canonicalAction": None,
        "originalActionShape": None,
        "canonicalizedJson": None,
        "parsedJson": None,
    }
    try:
        parsed = json.loads(str(text or ""))
    except Exception:
        return {**result, "canonicalizationReason": "invalid_json"}
    result["parsedJson"] = parsed
    if not isinstance(parsed, dict):
        return {**result, "canonicalizationReason": "not_json_object"}
    if "action" not in parsed:
        return {**result, "canonicalizationReason": "missing_action"}
    action = parsed.get("action")
    if isinstance(action, str):
        return {**result, "canonicalizationReason": "already_string_action", "canonicalAction": action}
    if not isinstance(action, dict):
        return {**result, "canonicalizationReason": "unsupported_action_shape", "originalActionShape": type(action).__name__}

    present_keys = [key for key in ACTION_CANONICALIZATION_KEYS if key in action]
    shape = {key: action.get(key) for key in present_keys}
    if len(present_keys) != 1:
        return {
            **result,
            "canonicalizationReason": "ambiguous_action_object" if present_keys else "missing_action_identifier",
            "originalActionShape": shape,
        }

    raw_action = action.get(present_keys[0])
    if not isinstance(raw_action, str):
        return {**result, "canonicalizationReason": "non_string_action_identifier", "originalActionShape": shape}
    if raw_action not in SAFE_ACTION_CANONICALIZATION_ALLOWLIST:
        return {
            **result,
            "canonicalizationReason": "action_not_allowlisted",
            "canonicalAction": raw_action,
            "originalActionShape": shape,
        }

    canonicalized = {**parsed, "action": raw_action}
    return {
        **result,
        "canonicalizationApplied": True,
        "canonicalizationReason": f"nested_action_{present_keys[0]}",
        "canonicalAction": raw_action,
        "originalActionShape": shape,
        "canonicalizedJson": json.dumps(canonicalized, sort_keys=True, separators=(",", ":")),
        "parsedJson": canonicalized,
    }


def normalize_dashes(text: str) -> str:
    return DASH_VARIANTS_PATTERN.sub("-", str(text or ""))


def split_scoring_token(token: str) -> list[str]:
    normalized = normalize_dashes(token)
    parts = re.split(r"[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])", normalized)
    return [part for part in parts if part]


def json_scoring_tokens(value: Any) -> list[str]:
    tokens: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            key_text = str(key)
            tokens.append(key_text)
            tokens.extend(split_scoring_token(key_text))
            tokens.extend(json_scoring_tokens(item))
    elif isinstance(value, list):
        for item in value:
            tokens.extend(json_scoring_tokens(item))
    elif isinstance(value, bool):
        tokens.append("true" if value else "false")
    elif value is not None:
        value_text = str(value)
        tokens.append(value_text)
        tokens.extend(split_scoring_token(value_text))
    return tokens


def build_scoring_surface(
    text: str,
    router_mode: bool,
    normalized_label: str | None,
    parsed_json: Any | None,
    canonicalization: dict[str, Any],
    policy: dict[str, Any],
) -> dict[str, Any]:
    if policy["policyPassed"] is False:
        return {
            "scoringSurface": normalize_dashes(text),
            "scoringSurfaceSource": "raw_final_text",
            "requiredTokenCheckAppliedToCanonicalSurface": False,
        }
    if router_mode and normalized_label:
        return {
            "scoringSurface": f"{normalized_label} {normalized_label.replace('-', ' ')}",
            "scoringSurfaceSource": "normalized_label",
            "requiredTokenCheckAppliedToCanonicalSurface": False,
        }

    safe_json_action = (
        isinstance(parsed_json, dict)
        and isinstance(parsed_json.get("action"), str)
        and parsed_json.get("action") in SAFE_ACTION_CANONICALIZATION_ALLOWLIST
        and (
            canonicalization["canonicalizationApplied"]
            or canonicalization["canonicalizationReason"] == "already_string_action"
        )
    )
    if router_mode and safe_json_action:
        tokens = json_scoring_tokens(parsed_json)
        serialized = json.dumps(parsed_json, sort_keys=True, separators=(",", ":"))
        return {
            "scoringSurface": normalize_dashes(" ".join([serialized, *tokens])),
            "scoringSurfaceSource": "canonical_json",
            "requiredTokenCheckAppliedToCanonicalSurface": True,
        }

    return {
        "scoringSurface": normalize_dashes(text),
        "scoringSurfaceSource": "raw_final_text",
        "requiredTokenCheckAppliedToCanonicalSurface": False,
    }


def is_openai_output_training_policy_case(record: dict[str, Any]) -> bool:
    prompt = str(record.get("prompt", "")).lower()
    if "openai" not in prompt:
        return False
    training_terms = ("training", "target", "expected answer", "label", "fine-tuned", "fine tuned")
    output_terms = ("output", "model output", "answers")
    return any(term in prompt for term in training_terms) and any(term in prompt for term in output_terms)


def evaluate_openai_output_training_policy(record: dict[str, Any], text: str) -> dict[str, Any]:
    if not is_openai_output_training_policy_case(record):
        return {
            "policyOverrideApplied": False,
            "policyRule": None,
            "policyPassed": None,
            "policyOverrideResult": None,
        }

    compact = " ".join(str(text or "").strip().split())
    lowered = compact.lower()
    reject_prefix = bool(re.match(r"^(no|reject|not allowed|disallowed|do not|don't)\b", lowered))
    affirmative_prefix = bool(re.match(r"^(yes|allowed|can|it can|they can|openai outputs can)\b", lowered))
    policy_passed = reject_prefix and not affirmative_prefix
    return {
        "policyOverrideApplied": True,
        "policyRule": "openai_output_not_training_data",
        "policyPassed": policy_passed,
        "policyOverrideResult": {
            "action": "reject_training_from_openai_output",
            "risk": "data_governance",
            "allowedForTraining": False,
        },
    }


def analyze_output(record: dict[str, Any], output: str, output_info: dict[str, Any] | None = None) -> dict[str, Any]:
    expected = record["expected"]
    failures = []
    text = str(output or "")
    router_mode = bool((output_info or {}).get("routerClassifierMode", False))
    normalized_label = normalize_router_label(text) if router_mode and is_route_label_record(record) else None
    normalization_applied = normalized_label is not None and normalized_label != text.strip()
    classification_passed: bool | None = None
    answered_instead = False
    parsed_json: Any | None = None
    canonicalization = canonicalize_action_envelope(text) if router_mode and expected.get("json_object") is True else {
        "canonicalizationApplied": False,
        "canonicalizationReason": "not_router_json_record",
        "canonicalAction": None,
        "originalActionShape": None,
        "canonicalizedJson": None,
        "parsedJson": None,
    }
    policy = evaluate_openai_output_training_policy(record, text)
    if policy["policyPassed"] is False:
        failures.append("openai_output_policy_violation")
    if expected.get("json_object") is True:
        if canonicalization["parsedJson"] is not None:
            parsed_json = canonicalization["parsedJson"]
        else:
            try:
                parsed_json = json.loads(text)
            except Exception:
                parsed_json = None
        if parsed_json is None:
            failures.append("invalid_json")
        if parsed_json is not None:
            for field in expected.get("required_json_fields", []):
                if not json_has_key(parsed_json, str(field)):
                    failures.append(f"missing_json_field:{field}")
            if router_mode and "validate_dataset" in [str(item) for item in expected.get("must_include", [])]:
                if parsed_json.get("action") != "validate_dataset":
                    failures.append("action_mismatch:validate_dataset")
    scoring = build_scoring_surface(text, router_mode, normalized_label, parsed_json, canonicalization, policy)
    scoring_lower = scoring["scoringSurface"].lower()
    plane = expected.get("plane")
    if isinstance(plane, str):
        if router_mode:
            classification_passed = normalized_label == plane
            answered_instead = normalized_label is None
            if not classification_passed:
                failures.append("plane_mismatch")
        elif normalize_dashes(plane).lower() not in scoring_lower:
            failures.append("plane_mismatch")
    for item in expected.get("must_include", []):
        if router_mode and isinstance(plane, str) and str(item).lower() in {"control", "writing", "control-plane", "writing-plane"}:
            continue
        if router_mode and parsed_json is not None and str(item) == "validate_dataset":
            continue
        if normalize_dashes(str(item)).lower() not in scoring_lower:
            failures.append(f"missing:{item}")
    for item in expected.get("must_not_include", []):
        if normalize_dashes(str(item)).lower() in scoring_lower:
            failures.append(f"forbidden:{item}")
    if any(pattern.search(text) for pattern in FORBIDDEN_PATTERNS):
        failures.append("forbidden_capability_or_secret")
    return {
        "failures": failures,
        "normalizedLabel": normalized_label,
        "normalizationApplied": normalization_applied,
        "canonicalizationApplied": canonicalization["canonicalizationApplied"],
        "canonicalizationReason": canonicalization["canonicalizationReason"],
        "canonicalAction": canonicalization["canonicalAction"],
        "originalActionShape": canonicalization["originalActionShape"],
        "canonicalizedJson": canonicalization["canonicalizedJson"],
        "policyOverrideApplied": policy["policyOverrideApplied"],
        "policyRule": policy["policyRule"],
        "policyPassed": policy["policyPassed"],
        "policyOverrideResult": policy["policyOverrideResult"],
        "scoringSurface": scoring["scoringSurface"],
        "scoringSurfaceSource": scoring["scoringSurfaceSource"],
        "requiredTokenCheckAppliedToCanonicalSurface": scoring["requiredTokenCheckAppliedToCanonicalSurface"],
        "answeredInsteadOfClassified": answered_instead,
        "classificationPassed": classification_passed,
    }


def is_route_label_record(record: dict[str, Any]) -> bool:
    return record.get("expected", {}).get("plane") in {"control-plane", "writing-plane"}


def normalize_router_label(text: str) -> str | None:
    compact = " ".join(str(text or "").strip().split())
    compact = normalize_dashes(compact)
    lowered = compact.lower()
    mapping = {
        "control-plane": "control-plane",
        "control plane": "control-plane",
        "control-plane (control plane)": "control-plane",
        "writing-plane": "writing-plane",
        "writing plane": "writing-plane",
    }
    return mapping.get(lowered)


def summarize_output(output: str) -> str:
    compact = " ".join(str(output or "").split())
    return compact[:240]


def positive_int(raw_value: str) -> int:
    value = int(raw_value)
    if value < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return value


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
