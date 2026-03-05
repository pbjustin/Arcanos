import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { callOpenAI, getDefaultModel } from "@services/openai.js";
import { getEnv, getEnvNumber } from "@platform/runtime/env.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { applySecurityCompliance } from "@services/securityCompliance.js";

const execAsync = promisify(execCallback);

export const patchProposalSchema = z.object({
  kind: z.literal("self_improve_patch"),
  goal: z.string().min(1).max(400),
  summary: z.string().min(1).max(600),
  risk: z.enum(["low", "medium", "high"]),
  files: z.array(z.string().min(1)).max(80),
  diff: z.string().min(1),
  commands: z.array(z.string().min(1)).max(20).default([]),
  successMetrics: z.array(z.string().min(1)).max(20).default([]),
});

export type PatchProposal = z.infer<typeof patchProposalSchema>;

interface DiffValidationResult {
  valid: boolean;
  reason?: string;
}

interface GeneratedDiffResult {
  diff: string;
  fallbackTargetPath: string;
}

/**
 * Parse a JSON object from model text output with robust fallbacks.
 * Inputs: raw model output text.
 * Outputs: parsed JSON value.
 * Edge cases: handles fenced JSON and extra prose before/after object payloads.
 */
function parseJsonObjectFromModelOutput(rawOutput: string): unknown {
  const raw = (rawOutput || "").trim();
  //audit Assumption: some model runs return clean JSON; risk: parse failure on decorated output; invariant: parser should accept strict JSON first; handling: direct JSON.parse attempt.
  try {
    return JSON.parse(raw);
  } catch {
    // Continue to robust extraction fallbacks.
  }

  //audit Assumption: model may wrap JSON in markdown fences; risk: non-JSON fence content; invariant: fenced payload should be tried before generic brace slicing; handling: extract fenced body and parse.
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    const fencedBody = fencedMatch[1].trim();
    try {
      return JSON.parse(fencedBody);
    } catch {
      // Continue to brace extraction.
    }
  }

  //audit Assumption: output may include prose around a JSON object; risk: first/last brace span may still include noise; invariant: parser should recover the largest plausible object; handling: slice from first "{" to last "}" and parse.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = raw.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue to progressive trimming fallback.
    }
  }

  //audit Assumption: model sometimes appends trailing non-JSON tokens; risk: O(n^2) parse attempts on very long output; invariant: bounded token limits keep this tractable; handling: progressively trim trailing chars until parse succeeds.
  for (let end = raw.length - 1; end > 0; end--) {
    if (raw[end] !== "}") continue;
    const start = raw.indexOf("{");
    if (start < 0 || end <= start) continue;
    const candidate = raw.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning.
    }
  }

  throw new Error("Patch proposal is not valid JSON.");
}

/**
 * Validate unified diff structure before applying git-level checks.
 * Inputs: raw unified diff text.
 * Outputs: structural validation status with failure reason.
 * Edge cases: rejects placeholder lines (e.g. "..."), missing headers, and missing hunks.
 */
function validateUnifiedDiffShape(diff: string): DiffValidationResult {
  const normalized = (diff || "").replace(/\r\n/g, "\n");
  //audit Assumption: a valid proposal must include git diff headers; risk: malformed patch reaches actuator; invariant: diff starts with at least one file header; handling: fail-fast before git apply check.
  if (!/^diff --git a\/.+ b\/.+/m.test(normalized)) {
    return { valid: false, reason: "Missing required 'diff --git a/... b/...' header." };
  }

  //audit Assumption: model may emit placeholder scaffolding tokens; risk: non-applicable patches; invariant: diff must not contain placeholder-only lines; handling: reject and request regeneration.
  const hasPlaceholders = normalized.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed === "..." || trimmed === "<existing code>" || trimmed === "[existing code]";
  });
  if (hasPlaceholders) {
    return { valid: false, reason: "Diff contains placeholder lines (for example '...')." };
  }

  //audit Assumption: unified diff requires both old/new file markers and at least one hunk; risk: git apply corruption errors; invariant: each proposal includes hunk metadata; handling: reject malformed shape.
  if (!/^--- a\/.+$/m.test(normalized) || !/^\+\+\+ b\/.+$/m.test(normalized)) {
    return { valid: false, reason: "Missing '--- a/...' or '+++ b/...' file markers." };
  }
  if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(normalized)) {
    return { valid: false, reason: "Missing valid unified hunk header (@@ -x,y +x,y @@)." };
  }

  return { valid: true };
}

/**
 * Verify diff can be applied cleanly in check mode.
 * Inputs: unified diff text and optional repository root.
 * Outputs: git apply compatibility validation result.
 * Edge cases: cleans up temp files even when git apply fails.
 */
async function validateDiffWithGitApplyCheck(diff: string, repoRoot: string = process.cwd()): Promise<DiffValidationResult> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const tempFileName = `.arcanos_patch_check_${stamp}.diff`;
  const tempFilePath = path.join(repoRoot, tempFileName);

  try {
    await fs.writeFile(tempFilePath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
    await execAsync(`git apply --check "${tempFileName}"`, { cwd: repoRoot });
    return { valid: true };
  } catch (error: unknown) {
    return { valid: false, reason: `git apply --check failed: ${String((error as { stderr?: string }).stderr || (error as { message?: string }).message || error).trim()}` };
  } finally {
    try {
      await fs.unlink(tempFilePath);
    } catch {
      //audit Assumption: temp cleanup can fail on transient file locking; risk: stale temp files accumulate; invariant: cleanup failures must not fail main flow; handling: ignore cleanup failure.
    }
  }
}

/**
 * Build a deterministic fallback diff when model-generated diffs repeatedly fail.
 * Inputs: optional target component path and last failure reason for traceability.
 * Outputs: unified diff and target path when fallback can be generated.
 * Edge cases: returns null if no safe fallback target exists.
 */
async function buildDeterministicFallbackDiff(component: string | undefined, lastFailureReason: string): Promise<GeneratedDiffResult | null> {
  const repoRoot = process.cwd();
  const candidate = component || "src/services/selfImprove/controller.ts";
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  const absolute = path.resolve(repoRoot, normalized);

  //audit Assumption: fallback must only touch repository-local text files; risk: invalid or unsafe file mutation target; invariant: resolved path remains inside repo and file exists; handling: reject unsupported targets.
  if (!absolute.startsWith(repoRoot) || !/\.(ts|js|mjs|cjs)$/i.test(normalized)) {
    return null;
  }

  try {
    await fs.access(absolute);
  } catch {
    return null;
  }

  const original = await fs.readFile(absolute, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const marker = `//audit Assumption: deterministic fallback patch is comment-only; risk: model diff generation failed (${lastFailureReason.slice(0, 120)}); invariant: runtime behavior remains unchanged; handling: append observability breadcrumb.`;

  //audit Assumption: duplicate fallback marker reduces patch utility on retries; risk: generating empty or redundant diffs; invariant: fallback must create a net new line; handling: add a retry-safe suffix when marker already exists.
  const markerLine = original.includes(marker)
    ? `${marker} [retry-${Date.now()}]`
    : marker;
  const updated = original.endsWith("\n") || original.endsWith("\r\n")
    ? `${original}${markerLine}${eol}`
    : `${original}${eol}${markerLine}${eol}`;

  let diffOutput = "";
  try {
    await fs.writeFile(absolute, updated, "utf8");
    const { stdout } = await execAsync(`git -c core.autocrlf=false diff -- "${normalized}"`, { cwd: repoRoot });
    diffOutput = stdout || "";
  } finally {
    try {
      await fs.writeFile(absolute, original, "utf8");
    } catch {
      //audit Assumption: restore can fail on transient locks; risk: dirty working tree after fallback synthesis; invariant: best-effort restoration should never hide failure; handling: continue and let downstream cleanliness checks fail loudly.
    }
  }

  if (!diffOutput.trim()) return null;
  return { diff: diffOutput, fallbackTargetPath: normalized };
}

export function extractFilesFromUnifiedDiff(diff: string): string[] {
  const files = new Set<string>();
  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    // +++ b/path or --- a/path
    const m = line.match(/^[+]{3}\s+b\/(.+)$/) || line.match(/^[-]{3}\s+a\/(.+)$/);
    if (m && m[1]) files.add(m[1].trim());
  }
  return Array.from(files);
}

function buildPatchProposalPrompt(args: {
  trigger: string;
  component?: string;
  clearOverall?: number;
  clearMin?: number;
  context?: Record<string, unknown>;
  prohibitedPaths: string[];
  retryFeedback?: string;
}): string {
  const cfg = getConfig();
  //audit Assumption: default security redaction config is sufficient for proposal context; risk: partial leakage in prompt context; invariant: context is always scrubbed before prompt interpolation; handling: apply centralized security compliance redaction.
  const safeContext = applySecurityCompliance(JSON.stringify(args.context ?? {})).content;
  const outputContractExample = JSON.stringify(
    {
      kind: "self_improve_patch",
      goal: "One-sentence objective of the change",
      summary: "Short summary of what will change and why",
      risk: "low",
      files: ["src/example.ts"],
      diff: "diff --git a/src/example.ts b/src/example.ts\\n--- a/src/example.ts\\n+++ b/src/example.ts\\n@@ -1,1 +1,1 @@\\n-console.log('old')\\n+console.log('new')\\n",
      commands: ["npm run type-check", "npm test -- tests/ask-validation.test.ts"],
      successMetrics: ["Type-check passes", "Targeted tests pass"]
    },
    null,
    2
  );

  return [
    "You are the ARCANOS patch-proposal engine.",
    "Output ONLY valid JSON that matches this contract example exactly (same keys and value types):",
    outputContractExample,
    "",
    "Constraints:",
    `- Environment: ${cfg.selfImproveEnvironment}`,
    "- Provide a SMALL unified diff (git apply compatible).",
    "- The diff MUST pass `git apply --check` against the current repository state.",
    "- Use exact real code context lines from existing files; do not invent placeholder context.",
    "- NEVER output placeholder lines such as `...`, `<existing code>`, or `[existing code]`.",
    "- Only modify files that are necessary.",
    `- DO NOT touch prohibited paths/patterns: ${args.prohibitedPaths.join(", ") || "(none)"}`,
    "- If you cannot safely propose a patch, still output JSON but use risk='high' and an empty diff is NOT allowed; instead propose a minimal safe no-op change (e.g., add tests or docs) that improves observability.",
    "- Include a short list of commands to validate the change (e.g., npm test).",
    "",
    "Signals:",
    `- trigger: ${args.trigger}`,
    args.component ? `- component: ${args.component}` : "- component: (none)",
    typeof args.clearOverall === "number" ? `- CLEAR overall: ${args.clearOverall}` : "",
    typeof args.clearMin === "number" ? `- CLEAR min: ${args.clearMin}` : "",
    "",
    "Context (sanitized):",
    safeContext,
    args.retryFeedback ? "" : "",
    args.retryFeedback ? "Previous attempt failed validation. Fix the patch based on this feedback:" : "",
    args.retryFeedback ? `- ${args.retryFeedback}` : "",
  ].filter(Boolean).join("\n");
}

export const patchProposalTestUtils = {
  parseJsonObjectFromModelOutput,
  validateUnifiedDiffShape,
};

export async function generatePatchProposal(args: {
  trigger: string;
  component?: string;
  clearOverall?: number;
  clearMin?: number;
  context?: Record<string, unknown>;
  prohibitedPaths: string[];
}): Promise<PatchProposal> {
  const model = getEnv("SELF_IMPROVE_PATCH_MODEL") || getDefaultModel();
  const tokenLimit = getEnvNumber("SELF_IMPROVE_PATCH_TOKEN_LIMIT", 900);
  const maxAttempts = Math.max(1, Math.min(5, getEnvNumber("SELF_IMPROVE_PATCH_ATTEMPTS", 3)));
  let lastFailureReason = "Unknown patch proposal failure.";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = buildPatchProposalPrompt({
      ...args,
      retryFeedback: attempt > 1 ? lastFailureReason : undefined,
    });

    try {
      const resp = await callOpenAI(model, prompt, tokenLimit, true, {
        systemPrompt: "You are a careful senior engineer. Follow the schema. Output only JSON.",
        temperature: 0.1,
        top_p: 1,
        metadata: {
          feature: "self-improve-patch-proposal",
          trigger: args.trigger,
          component: args.component || "system",
          attempt,
        },
      });

      const parsed = parseJsonObjectFromModelOutput(resp.output || "");
      const proposal = patchProposalSchema.parse(parsed);

      // If files list wasn't accurate, derive from diff and merge.
      const fromDiff = extractFilesFromUnifiedDiff(proposal.diff);
      proposal.files = Array.from(new Set([...(proposal.files || []), ...fromDiff]));

      const shapeValidation = validateUnifiedDiffShape(proposal.diff);
      //audit Assumption: malformed diff shape cannot be repaired downstream; risk: actuator failures or unsafe PR automation; invariant: only structurally valid patches proceed; handling: regenerate with explicit feedback.
      if (!shapeValidation.valid) {
        lastFailureReason = shapeValidation.reason || "Unified diff shape validation failed.";
        continue;
      }

      const applyValidation = await validateDiffWithGitApplyCheck(proposal.diff);
      //audit Assumption: git apply --check is the most reliable compatibility gate before PR creation; risk: repository-context mismatch; invariant: only check-clean patches can proceed; handling: regenerate with specific apply error context.
      if (!applyValidation.valid) {
        lastFailureReason = applyValidation.reason || "git apply --check validation failed.";
        continue;
      }

      return proposal;
    } catch (error: unknown) {
      //audit Assumption: model output can intermittently violate schema/JSON contract; risk: premature cycle failure; invariant: retries should preserve deterministic constraints; handling: retry until max attempts then raise structured error.
      lastFailureReason = error instanceof Error ? error.message : String(error);
    }
  }

  //audit Assumption: model retries can still fail under ambiguous repo context; risk: blocking actuator test workflows; invariant: fallback stays non-functional and traceable; handling: deterministic comment-only fallback patch.
  const fallback = await buildDeterministicFallbackDiff(args.component, lastFailureReason);
  if (fallback) {
    const fallbackShape = validateUnifiedDiffShape(fallback.diff);
    const fallbackApply = fallbackShape.valid
      ? await validateDiffWithGitApplyCheck(fallback.diff)
      : fallbackShape;
    if (fallbackApply.valid) {
      return {
        kind: "self_improve_patch",
        goal: "Preserve self-improve actuator continuity with a deterministic, behavior-neutral fallback patch.",
        summary: "Adds a non-functional //audit observability comment after model-generated diffs failed validation.",
        risk: "low",
        files: [fallback.fallbackTargetPath],
        diff: fallback.diff,
        commands: ["npm run type-check"],
        successMetrics: [
          "Fallback patch applies cleanly with git apply --check",
          "Type-check passes",
        ],
      };
    }
  }

  throw new Error(`Unable to generate a valid self-improve patch proposal after ${maxAttempts} attempts. Last failure: ${lastFailureReason}`);
}
