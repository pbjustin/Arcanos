import json
from functools import lru_cache
from pathlib import Path


POLICY_PATH = Path(__file__).resolve().parent.parent / "policy" / "escalation.json"
DECISION_LOG_PATH = Path(__file__).resolve().parent.parent / "logs" / "decisions.log"


def log_decision(trace_id: str, route: str, context_payload: dict) -> None:
    """
    Purpose: Persist a structured escalation decision record for traceability.
    Inputs/Outputs: trace id + route + context payload; appends one JSON line.
    Edge cases: Logging failures are printed but never break routing flow.
    """
    payload = {
        "trace_id": trace_id,
        "route": route,
        "token_estimate": context_payload.get("token_estimate"),
        "file_count": context_payload.get("file_count"),
    }

    try:
        DECISION_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(DECISION_LOG_PATH, "a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(payload, ensure_ascii=True) + "\n")
    except OSError as error:
        # //audit Assumption: logging is best-effort; risk: dropped audit traces; invariant: decision returned; handling: warn and continue.
        print(f"[WARN][{trace_id}] Failed to write escalation log: {error}")


@lru_cache(maxsize=1)
def load_policy():
    """
    Purpose: Load and validate escalation policy configuration from disk.
    Inputs/Outputs: None; returns validated policy dictionary.
    Edge cases: Raises ValueError when required policy keys are missing.
    """
    with open(POLICY_PATH, "r", encoding="utf-8") as policy_file:
        policy = json.load(policy_file)

    required_keys = ["max_local_tokens", "multi_file_limit", "security_keywords"]
    for key in required_keys:
        # //audit Assumption: policy file can be malformed; risk: unsafe default routing; invariant: required keys present; handling: fail fast with ValueError.
        if key not in policy:
            raise ValueError(f"Invalid escalation policy: missing {key}")

    return policy


def should_escalate(context_payload: dict, trace_id: str) -> bool:
    """
    Purpose: Decide whether request processing should escalate to backend execution.
    Inputs/Outputs: context payload + trace id; returns escalation decision boolean.
    Edge cases: Missing payload fields default to non-escalating safe values.
    """
    policy = load_policy()
    content = str(context_payload.get("content", "")).lower()
    # //audit Assumption: policy thresholds are local trust boundaries; risk: unsafe local execution for risky prompts; invariant: escalate on any threshold/keyword match; handling: combined boolean gate.
    decision = (
        context_payload.get("token_estimate", 0) > policy["max_local_tokens"]
        or context_payload.get("file_count", 0) > policy["multi_file_limit"]
        or any(keyword.lower() in content for keyword in policy["security_keywords"])
    )

    log_decision(trace_id, "escalate" if decision else "local", context_payload)
    return decision
