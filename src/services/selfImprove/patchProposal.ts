import { z } from "zod";
import { callOpenAI, getDefaultModel } from "@services/openai.js";
import { getEnv, getEnvNumber } from "@platform/runtime/env.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { applySecurityCompliance } from "@services/securityCompliance.js";

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
  ].filter(Boolean).join("\n");
}

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

  const prompt = buildPatchProposalPrompt(args);

  const resp = await callOpenAI(model, prompt, tokenLimit, true, {
    systemPrompt: "You are a careful senior engineer. Follow the schema. Output only JSON.",
    temperature: 0.1,
    top_p: 1,
    metadata: { feature: "self-improve-patch-proposal", trigger: args.trigger, component: args.component || "system" },
  });

  const parsed = parseJsonObjectFromModelOutput(resp.output || "");

  const proposal = patchProposalSchema.parse(parsed);

  // If files list wasn't accurate, derive from diff and merge.
  const fromDiff = extractFilesFromUnifiedDiff(proposal.diff);
  const merged = Array.from(new Set([...(proposal.files || []), ...fromDiff]));
  proposal.files = merged;

  return proposal;
}
