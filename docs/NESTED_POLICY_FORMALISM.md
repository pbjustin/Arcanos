# Nested Safety Policy Formalism

This document proposes a JSON-based formalism for expressing and adjudicating layered safety policies in the Arcanos system. It extends the existing `safetyPolicy` structure by supporting recursion and conditional enforcement across nested policies.

## Data Structure

```json
{
  "policy": {
    "name": "root",
    "rule": "audit-default",
    "subPolicies": [
      {
        "name": "low-risk",
        "keywords": ["read-only query", "data analysis", "format text"],
        "rule": "allow"
      },
      {
        "name": "destructive-ops",
        "keywords": ["delete file", "remove directory", "drop database", "system shutdown"],
        "rule": "audit",
        "subPolicies": [
          {
            "name": "production-override",
            "conditions": {"environment": "production"},
            "rule": "block"
          }
        ]
      },
      {
        "name": "admin-recursion",
        "conditions": {"role": "admin"},
        "rule": "audit",
        "subPolicies": [
          { "$ref": "#/policy" }
        ]
      }
    ]
  },
  "adjudicationRules": {
    "allow": {"enforce": "noAudit"},
    "audit": {"enforce": "requireAudit"},
    "block": {"enforce": "deny"},
    "audit-default": {"enforce": "requireAudit"}
  }
}
```

## Evaluation Semantics

1. **Recursive Descent** – Policy evaluation begins at the `root`. For each policy, matching `keywords` or `conditions` trigger evaluation of its `subPolicies` before applying its own `rule`.
2. **Conditional Enforcement** – `conditions` may inspect external context (e.g., environment or user role). A policy is enforced only when its conditions evaluate to true.
3. **Rule Resolution** – When no `subPolicy` matches, the current policy's `rule` maps to an action via `adjudicationRules`.
4. **Speculative Recursion** – `$ref` allows a policy to invoke another policy (including `root`), illustrating recursive enforcement chains. Implementations should guard against infinite loops by tracking depth or visited nodes.

This formalism captures nuanced, hierarchical reasoning for complex safety decisions while remaining extensible for future policy entries.
