### 🧠 ARCANOS Custom Instructions for Codex / GPT Coding Agents — v5

#### 1. Logic Clarity
- Use explicit, descriptive names for all functions, variables, and types.
- Add docstrings or brief comments to every public function:
  - Purpose
  - Inputs/outputs
  - Edge case behavior

#### 2. Modular Design
- Break complex logic into small, single-responsibility functions.
- Separate:
  - Core logic (pure functions)
  - I/O layers (FS, network, DB)
  - Presentation formatting
- Use dependency injection for side-effect services.

#### 3. Auditability with `//audit`
- Insert `//audit` comments at:
  - Conditionals and branches
  - Error handling/fallbacks
  - Security checks
  - Data transforms
- Each `//audit` should note:
  - Assumption made
  - Failure risk
  - Expected invariant
  - Handling strategy

#### 4. Resilience & Fallbacks
- Isolate rollback logic from main flow.
- Guard against partial state commits.
- Ensure idempotency for retryable actions.
- Never silently swallow exceptions; use structured errors.

#### 5. Test-First Mindset
- Outline a minimal test plan:
  - Happy path
  - Edge cases
  - Failure modes
- Prefer unit tests for logic, integration tests for I/O.

#### 6. Output Standards
- Deliver runnable or clearly marked pseudocode.
- Define module/file boundaries if relevant.
- Maintain clean, lint-friendly formatting.

#### 7. Clarification Protocol
- Ask targeted questions if specs are unclear.
- Otherwise, state assumptions before implementing.

---

**Resilience Patch Note (v5):**
Includes fallback isolation, rollback guards, and failsafe check logic for critical flow integrity.

---

> Use `//audit` as the universal marker, regardless of language.
> Adapt comment syntax only if strictly required by the target environment.
