# Why We Fine-Tune Our AI Model

## Overview
We fine-tune our base AI model to deliver consistent, domain-specific behavior that aligns with Arcanos product requirements, safety posture, and operational constraints. This document explains the rationale, decision criteria, and governance behind fine-tuning.

## Assumptions
- We operate in a domain that requires consistent terminology, workflows, and response formats.
- We must meet latency and cost targets at production scale.
- We need deterministic behavior for key product flows and integrations.

## Primary Reasons We Fine-Tune
1. **Domain alignment and precision**
   Fine-tuning teaches the model our proprietary vocabulary, workflows, and task framing so that outputs match internal standards and reduce post-processing.

2. **Consistency across products and teams**
   A fine-tuned model reduces variance across deployments, giving teams reliable behavior and lowering the need for prompt-level patches.

3. **Tooling and integration compliance**
   We can enforce consistent input/output schemas so downstream systems (APIs, databases, automation) receive predictable, machine-parseable responses.

4. **Safety and policy adherence**
   Fine-tuning helps encode policy boundaries and preferred refusals so the model handles restricted content in a controlled, auditable way.

5. **Efficiency gains (latency and cost)**
   With a fine-tuned model, prompts can be shorter and more standardized, reducing token usage and improving response time.

## When We Do NOT Fine-Tune
- **Rapid experimentation or prototyping:** We use prompting first to validate product fit.
- **Sparse or noisy data:** We avoid fine-tuning if the training set is too small or inconsistent.
- **Highly dynamic requirements:** If the behavior is expected to change weekly, we prefer prompt iteration over model retraining.

## Data and Privacy Considerations
- Training data is curated and reviewed to avoid leakage of sensitive information.
- We separate public, internal, and restricted datasets to enforce policy-based access.
- We retain audit trails of data sources, preprocessing steps, and evaluation results.

## Governance, Evaluation, and Rollback
- We run regression evaluations against baseline prompts and critical workflows.
- We maintain a rollback-capable deployment plan so a fine-tuned model can be replaced with the base model if issues are detected.
- We re-evaluate at scheduled intervals to ensure the model remains aligned with updated policies and product goals.

## Decision Checkpoints (//audit)
- `//audit`
  - **Assumption**: fine-tuning improves domain accuracy
  - **Risk**: overfitting reduces generalization
  - **Invariant**: model must pass baseline QA
  - **Handling**: compare against baseline eval set before release.
- `//audit`
  - **Assumption**: structured outputs are required for integrations
  - **Risk**: schema drift breaks clients
  - **Invariant**: schema remains stable
  - **Handling**: validate outputs with contract tests.
- `//audit`
  - **Assumption**: training data is policy-compliant
  - **Risk**: sensitive data leaks
  - **Invariant**: data is sanitized
  - **Handling**: enforce data review and redaction gates.
- `//audit`
  - **Assumption**: fine-tuning reduces cost
  - **Risk**: model becomes too specialized and slower
  - **Invariant**: latency targets met
  - **Handling**: benchmark before rollout.

## Minimal Test Plan
- **Happy path:** Run standard evaluation prompts and verify domain-specific outputs match expected formats.
- **Edge case:** Evaluate ambiguous or multi-intent queries and confirm the model follows policy and formatting rules.
- **Failure mode:** Inject invalid or adversarial prompts and confirm the model refuses or de-escalates per policy.
