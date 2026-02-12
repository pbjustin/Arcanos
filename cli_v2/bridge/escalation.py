import json
from pathlib import Path
from logs.logger import log_decision


POLICY_PATH = Path(__file__).resolve().parent.parent / "policy" / "escalation.json"


def load_policy():
    with open(POLICY_PATH) as f:
        policy = json.load(f)

    required_keys = ["max_local_tokens", "multi_file_limit", "security_keywords"]
    for key in required_keys:
        if key not in policy:
            raise ValueError(f"Invalid escalation policy: missing {key}")

    return policy


def should_escalate(context_payload: dict, trace_id: str) -> bool:
    policy = load_policy()
    decision = False

    if context_payload.get("token_estimate", 0) > policy["max_local_tokens"]:
        decision = True

    elif context_payload.get("file_count", 0) > policy["multi_file_limit"]:
        decision = True

    else:
        content = context_payload.get("content", "").lower()
        for keyword in policy["security_keywords"]:
            if keyword in content:
                decision = True
                break

    log_decision(trace_id, "escalate" if decision else "local", context_payload)
    return decision
