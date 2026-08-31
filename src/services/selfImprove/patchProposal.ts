import { z } from "zod";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { callOpenAI } from "@services/openai/chatFlow/index.js";
import { rethrowWorkerAiBudgetError } from "@core/adapters/openai.adapter.js";
import { getDefaultModel } from "@services/openai/credentialProvider.js";
import { getEnv, getEnvNumber } from "@platform/runtime/env.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { applySecurityCompliance } from "@services/securityCompliance.js";
import { renderPromptGuidanceSections } from "@shared/promptGuidance.js";

const execFileAsync = promisify(execFile);
const GIT_APPLY_TIMEOUT_MS = 15_000;
const GIT_APPLY_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 512 * 1024;
const MAX_PATCH_DIFF_BYTES = 256 * 1024;
const MAX_PATCH_PATH_CHARS = 1024;
const MAX_PATCH_FILES = 80;
const MAX_PATCH_SECTIONS = 80;
const MAX_PATCH_HUNKS = 256;
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

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
  diagnosticCode?: PatchProposalDiagnosticCode;
  reason?: string;
}

interface DiffPathValidationResult extends DiffValidationResult {
  files?: string[];
}

type PatchProposalDiagnosticCode =
  | "MODEL_OUTPUT_TOO_LARGE"
  | "MODEL_OUTPUT_INVALID_JSON"
  | "PROVIDER_REQUEST_FAILED"
  | "PROPOSAL_SCHEMA_INVALID"
  | "DIFF_TOO_LARGE"
  | "DIFF_SECTION_LIMIT_EXCEEDED"
  | "DIFF_HUNK_LIMIT_EXCEEDED"
  | "DIFF_SHAPE_INVALID"
  | "DIFF_PATH_INVALID"
  | "DIFF_PATH_PROHIBITED"
  | "DIFF_PATH_UNSAFE"
  | "DIFF_GIT_APPLY_REJECTED"
  | "PATCH_PROPOSAL_ATTEMPT_FAILED";

class PatchProposalValidationError extends Error {
  constructor(
    readonly diagnosticCode: PatchProposalDiagnosticCode,
    message: string
  ) {
    super(message);
    this.name = "PatchProposalValidationError";
  }
}

/**
 * Parse a JSON object from model text output with robust fallbacks.
 * Inputs: raw model output text.
 * Outputs: parsed JSON value.
 * Edge cases: handles fenced JSON and extra prose before/after object payloads.
 */
function parseJsonObjectFromModelOutput(rawOutput: string): unknown {
  if (Buffer.byteLength(rawOutput || "", "utf8") > MAX_MODEL_OUTPUT_BYTES) {
    throw new PatchProposalValidationError(
      "MODEL_OUTPUT_TOO_LARGE",
      "Patch proposal model output exceeds the byte limit."
    );
  }
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
  let trailingObjectAttempts = 0;
  for (let end = raw.length - 1; end > 0 && trailingObjectAttempts < 32; end--) {
    if (raw[end] !== "}") continue;
    const start = raw.indexOf("{");
    if (start < 0 || end <= start) continue;
    trailingObjectAttempts += 1;
    const candidate = raw.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning.
    }
  }

  throw new PatchProposalValidationError(
    "MODEL_OUTPUT_INVALID_JSON",
    "Patch proposal is not valid JSON."
  );
}

function validateDiffResourceLimits(diff: string): DiffValidationResult {
  if (Buffer.byteLength(diff || "", "utf8") > MAX_PATCH_DIFF_BYTES) {
    return {
      valid: false,
      diagnosticCode: "DIFF_TOO_LARGE",
      reason: "Unified diff exceeds the byte limit.",
    };
  }

  let sectionCount = 0;
  let hunkCount = 0;
  for (const line of (diff || "").replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      sectionCount += 1;
      if (sectionCount > MAX_PATCH_SECTIONS) {
        return {
          valid: false,
          diagnosticCode: "DIFF_SECTION_LIMIT_EXCEEDED",
          reason: "Unified diff exceeds the file-section limit.",
        };
      }
    }
    if (line.startsWith("@@ ")) {
      hunkCount += 1;
      if (hunkCount > MAX_PATCH_HUNKS) {
        return {
          valid: false,
          diagnosticCode: "DIFF_HUNK_LIMIT_EXCEEDED",
          reason: "Unified diff exceeds the hunk limit.",
        };
      }
    }
  }
  return { valid: true };
}

/**
 * Validate unified diff structure before applying git-level checks.
 * Inputs: raw unified diff text.
 * Outputs: structural validation status with failure reason.
 * Edge cases: rejects placeholder lines (e.g. "..."), missing headers, and missing hunks.
 */
function validateUnifiedDiffShape(diff: string): DiffValidationResult {
  const resourceValidation = validateDiffResourceLimits(diff);
  if (!resourceValidation.valid) {
    return resourceValidation;
  }

  const normalized = (diff || "").replace(/\r\n/g, "\n");
  //audit Assumption: a valid proposal must include git diff headers; risk: malformed patch reaches actuator; invariant: diff starts with at least one file header; handling: fail-fast before git apply check.
  if (!/^diff --git a\/.+ b\/.+/m.test(normalized)) {
    return {
      valid: false,
      diagnosticCode: "DIFF_SHAPE_INVALID",
      reason: "Missing required 'diff --git a/... b/...' header.",
    };
  }

  //audit Assumption: model may emit placeholder scaffolding tokens; risk: non-applicable patches; invariant: diff must not contain placeholder-only lines; handling: reject and request regeneration.
  const hasPlaceholders = normalized.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed === "..." || trimmed === "<existing code>" || trimmed === "[existing code]";
  });
  if (hasPlaceholders) {
    return {
      valid: false,
      diagnosticCode: "DIFF_SHAPE_INVALID",
      reason: "Diff contains placeholder lines (for example '...').",
    };
  }

  //audit Assumption: unified diff requires both old/new file markers and at least one hunk; risk: git apply corruption errors; invariant: each proposal includes hunk metadata; handling: reject malformed shape.
  if (
    !/^--- (?:a\/.+|\/dev\/null)$/m.test(normalized) ||
    !/^\+\+\+ (?:b\/.+|\/dev\/null)$/m.test(normalized)
  ) {
    return {
      valid: false,
      diagnosticCode: "DIFF_SHAPE_INVALID",
      reason: "Missing valid old or new file markers.",
    };
  }
  if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(normalized)) {
    return {
      valid: false,
      diagnosticCode: "DIFF_SHAPE_INVALID",
      reason: "Missing valid unified hunk header (@@ -x,y +x,y @@).",
    };
  }

  return { valid: true };
}

function normalizeRepositoryPath(rawPath: string): string | null {
  if (
    rawPath.length === 0 ||
    rawPath.length > MAX_PATCH_PATH_CHARS ||
    rawPath.includes("\0") ||
    rawPath.includes("\r") ||
    rawPath.includes("\n")
  ) {
    return null;
  }

  const slashPath = rawPath.replace(/\\/g, "/");
  if (
    path.posix.isAbsolute(slashPath) ||
    path.win32.isAbsolute(rawPath) ||
    /^[A-Za-z]:/u.test(rawPath)
  ) {
    return null;
  }

  const segments = slashPath.split("/");
  if (
    segments.some(segment =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      /[ .]$/u.test(segment) ||
      WINDOWS_DEVICE_NAME_PATTERN.test(segment)
    )
  ) {
    return null;
  }

  const normalized = path.posix.normalize(slashPath);
  return normalized === slashPath ? normalized : null;
}

function escapeRegularExpressionCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function prohibitedPathPatternToRegExp(rawPattern: string): RegExp | null {
  const normalizedPattern = rawPattern
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//u, "");
  if (normalizedPattern.length === 0 || normalizedPattern.includes("\0")) {
    return null;
  }

  let source = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === "*") {
      if (normalizedPattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegularExpressionCharacter(character);
    }
  }

  if (normalizedPattern.endsWith("/")) {
    source += ".*";
  }
  return new RegExp(`^${source}$`, "iu");
}

function isProhibitedPatchPath(
  repositoryPath: string,
  prohibitedPaths: string[]
): boolean {
  return prohibitedPaths.some(pattern =>
    prohibitedPathPatternToRegExp(pattern)?.test(repositoryPath) === true
  );
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isMissingPathError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && (error as { code?: unknown }).code === "ENOENT";
}

async function validateRepositoryPathAccess(
  canonicalRepoRoot: string,
  repositoryPath: string
): Promise<DiffValidationResult> {
  const candidate = path.resolve(canonicalRepoRoot, ...repositoryPath.split("/"));
  if (!isContainedPath(canonicalRepoRoot, candidate)) {
    return {
      valid: false,
      diagnosticCode: "DIFF_PATH_UNSAFE",
      reason: "Patch path escapes the repository root.",
    };
  }

  let cursor = canonicalRepoRoot;
  const segments = repositoryPath.split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);

    let stats;
    try {
      stats = await fs.lstat(cursor);
    } catch (error) {
      if (isMissingPathError(error)) {
        return { valid: true };
      }
      return {
        valid: false,
        diagnosticCode: "DIFF_PATH_UNSAFE",
        reason: "Patch path could not be inspected.",
      };
    }

    if (stats.isSymbolicLink()) {
      return {
        valid: false,
        diagnosticCode: "DIFF_PATH_UNSAFE",
        reason: "Patch path contains a symbolic link.",
      };
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      return {
        valid: false,
        diagnosticCode: "DIFF_PATH_UNSAFE",
        reason: "Patch path has a non-directory parent.",
      };
    }
    if (index === segments.length - 1 && !stats.isFile()) {
      return {
        valid: false,
        diagnosticCode: "DIFF_PATH_UNSAFE",
        reason: "Patch path does not reference a regular file.",
      };
    }

    let canonicalCursor: string;
    try {
      canonicalCursor = await fs.realpath(cursor);
    } catch {
      return {
        valid: false,
        diagnosticCode: "DIFF_PATH_UNSAFE",
        reason: "Patch path could not be resolved.",
      };
    }
    if (!isContainedPath(canonicalRepoRoot, canonicalCursor)) {
      return {
        valid: false,
        diagnosticCode: "DIFF_PATH_UNSAFE",
        reason: "Patch path resolves outside the repository root.",
      };
    }
  }

  return { valid: true };
}

function extractDiffSectionPaths(diff: string): DiffPathValidationResult {
  const resourceValidation = validateDiffResourceLimits(diff);
  if (!resourceValidation.valid) {
    return resourceValidation;
  }

  const normalized = (diff || "").replace(/\r\n/g, "\n");
  const headerMatches = Array.from(normalized.matchAll(/^diff --git /gmu));
  if (headerMatches.length === 0 || headerMatches[0]?.index !== 0) {
    return {
      valid: false,
      diagnosticCode: "DIFF_SHAPE_INVALID",
      reason: "Diff must begin with a git file header.",
    };
  }

  const files = new Set<string>();
  for (const [index, headerMatch] of headerMatches.entries()) {
    const sectionStart = headerMatch.index ?? 0;
    const sectionEnd = headerMatches[index + 1]?.index ?? normalized.length;
    const sectionLines = normalized.slice(sectionStart, sectionEnd).split("\n");
    const firstHunkIndex = sectionLines.findIndex(line => line.startsWith("@@ "));
    if (firstHunkIndex < 0) {
      return {
        valid: false,
        diagnosticCode: "DIFF_SHAPE_INVALID",
        reason: "Each diff section must contain a unified hunk.",
      };
    }
    const metadataLines = sectionLines.slice(0, firstHunkIndex);
    const oldMarkers = metadataLines.filter(line => line.startsWith("--- "));
    const newMarkers = metadataLines.filter(line => line.startsWith("+++ "));
    if (oldMarkers.length !== 1 || newMarkers.length !== 1) {
      return {
        valid: false,
        diagnosticCode: "DIFF_SHAPE_INVALID",
        reason: "Each diff section must contain one old and one new file marker.",
      };
    }

    const oldMarker = oldMarkers[0]!;
    const newMarker = newMarkers[0]!;
    const oldRawPath = oldMarker === "--- /dev/null"
      ? null
      : oldMarker.startsWith("--- a/")
        ? oldMarker.slice("--- a/".length)
        : undefined;
    const newRawPath = newMarker === "+++ /dev/null"
      ? null
      : newMarker.startsWith("+++ b/")
        ? newMarker.slice("+++ b/".length)
        : undefined;
    if (
      oldRawPath === undefined ||
      newRawPath === undefined ||
      (oldRawPath === null && newRawPath === null)
    ) {
      return {
        valid: false,
        diagnosticCode: "DIFF_SHAPE_INVALID",
        reason: "Diff contains invalid old or new file markers.",
      };
    }

    const headerOldRawPath = oldRawPath ?? newRawPath!;
    const headerNewRawPath = newRawPath ?? oldRawPath;
    if (
      sectionLines[0] !==
      `diff --git a/${headerOldRawPath} b/${headerNewRawPath}`
    ) {
      return {
        valid: false,
        diagnosticCode: "DIFF_SHAPE_INVALID",
        reason: "Diff file headers and file markers do not agree.",
      };
    }

    const oldPath = oldRawPath === null
      ? null
      : normalizeRepositoryPath(oldRawPath);
    const newPath = newRawPath === null
      ? null
      : normalizeRepositoryPath(newRawPath);
    if (
      (oldRawPath !== null && !oldPath) ||
      (newRawPath !== null && !newPath)
    ) {
      return {
        valid: false,
        diagnosticCode: "DIFF_PATH_INVALID",
        reason: "Diff contains an invalid or non-normalized repository path.",
      };
    }

    const renameFrom = metadataLines.filter(line => line.startsWith("rename from "));
    const renameTo = metadataLines.filter(line => line.startsWith("rename to "));
    const copyFrom = metadataLines.filter(line => line.startsWith("copy from "));
    const copyTo = metadataLines.filter(line => line.startsWith("copy to "));
    const hasRenameMetadata = renameFrom.length > 0 || renameTo.length > 0;
    const hasCopyMetadata = copyFrom.length > 0 || copyTo.length > 0;
    if (
      (hasRenameMetadata && hasCopyMetadata) ||
      renameFrom.length > 1 ||
      renameTo.length > 1 ||
      copyFrom.length > 1 ||
      copyTo.length > 1 ||
      (hasRenameMetadata && (renameFrom.length !== 1 || renameTo.length !== 1)) ||
      (hasCopyMetadata && (copyFrom.length !== 1 || copyTo.length !== 1))
    ) {
      return {
        valid: false,
        diagnosticCode: "DIFF_SHAPE_INVALID",
        reason: "Diff contains inconsistent rename or copy metadata.",
      };
    }

    if (hasRenameMetadata || hasCopyMetadata) {
      if (!oldPath || !newPath) {
        return {
          valid: false,
          diagnosticCode: "DIFF_SHAPE_INVALID",
          reason: "New and deleted file sections cannot contain rename or copy metadata.",
        };
      }
      const fromRawPath = hasRenameMetadata
        ? renameFrom[0]!.slice("rename from ".length)
        : copyFrom[0]!.slice("copy from ".length);
      const toRawPath = hasRenameMetadata
        ? renameTo[0]!.slice("rename to ".length)
        : copyTo[0]!.slice("copy to ".length);
      const fromPath = normalizeRepositoryPath(fromRawPath);
      const toPath = normalizeRepositoryPath(toRawPath);
      if (!fromPath || !toPath || fromPath !== oldPath || toPath !== newPath) {
        return {
          valid: false,
          diagnosticCode: "DIFF_PATH_INVALID",
          reason: "Diff rename or copy paths do not match validated file markers.",
        };
      }
    }

    if (oldPath) files.add(oldPath);
    if (newPath) files.add(newPath);
  }

  if (files.size > MAX_PATCH_FILES) {
    return {
      valid: false,
      diagnosticCode: "DIFF_SECTION_LIMIT_EXCEEDED",
      reason: "Diff exceeds the validated file limit.",
    };
  }
  return { valid: true, files: Array.from(files) };
}

async function validateDiffPaths(
  diff: string,
  prohibitedPaths: string[],
  repoRoot: string = process.cwd()
): Promise<DiffPathValidationResult> {
  const extracted = extractDiffSectionPaths(diff);
  if (!extracted.valid || !extracted.files) {
    return extracted;
  }

  let canonicalRepoRoot: string;
  try {
    canonicalRepoRoot = await fs.realpath(repoRoot);
  } catch {
    return {
      valid: false,
      diagnosticCode: "DIFF_PATH_UNSAFE",
      reason: "Repository root could not be resolved.",
    };
  }

  for (const repositoryPath of extracted.files) {
    if (isProhibitedPatchPath(repositoryPath, prohibitedPaths)) {
      return {
        valid: false,
        diagnosticCode: "DIFF_PATH_PROHIBITED",
        reason: "Patch path is prohibited by the loop contract.",
      };
    }
    const accessValidation = await validateRepositoryPathAccess(
      canonicalRepoRoot,
      repositoryPath
    );
    if (!accessValidation.valid) {
      return accessValidation;
    }
  }

  return extracted;
}

/**
 * Verify diff can be applied cleanly in check mode.
 * Inputs: unified diff text and optional repository root.
 * Outputs: git apply compatibility validation result.
 * Edge cases: cleans up temp files even when git apply fails.
 */
async function validateDiffWithGitApplyCheck(diff: string, repoRoot: string = process.cwd()): Promise<DiffValidationResult> {
  const resourceValidation = validateDiffResourceLimits(diff);
  if (!resourceValidation.valid) {
    return resourceValidation;
  }

  let tempDirectory: string | null = null;

  try {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "arcanos-patch-check-"));
    const tempFilePath = path.join(tempDirectory, "proposal.diff");
    await fs.writeFile(tempFilePath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
    await execFileAsync("git", ["apply", "--check", "--", tempFilePath], {
      cwd: repoRoot,
      windowsHide: true,
      timeout: GIT_APPLY_TIMEOUT_MS,
      maxBuffer: GIT_APPLY_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    return { valid: true };
  } catch {
    return {
      valid: false,
      diagnosticCode: "DIFF_GIT_APPLY_REJECTED",
      reason: "git apply rejected the proposed diff.",
    };
  } finally {
    if (tempDirectory) {
      try {
        await fs.rm(tempDirectory, { recursive: true, force: true });
      } catch {
        //audit Assumption: temp cleanup can fail on transient file locking; risk: stale temp files accumulate; invariant: cleanup failures must not fail main flow; handling: ignore cleanup failure.
      }
    }
  }
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

  return renderPromptGuidanceSections({
    Role: "ARCANOS patch-proposal engine for self-improvement.",
    "Personality/collaboration style": [
      "Careful senior engineer.",
      "Small, reviewable, and schema-disciplined."
    ],
    Goal: "Propose one minimal repository patch that improves the diagnosed condition.",
    "Success criteria": [
      "The proposal is valid JSON matching the contract exactly.",
      "The unified diff is small, real, and `git apply --check` compatible.",
      "The proposal includes concrete validation commands and success metrics."
    ],
    Constraints: [
      `Environment: ${cfg.selfImproveEnvironment}`,
      "Provide a SMALL unified diff (git apply compatible).",
      "The diff MUST pass `git apply --check` against the current repository state.",
      "Use exact real code context lines from existing files; do not invent placeholder context.",
      "NEVER output placeholder lines such as `...`, `<existing code>`, or `[existing code]`.",
      "Only modify files that are necessary.",
      `DO NOT touch prohibited paths/patterns: ${args.prohibitedPaths.join(", ") || "(none)"}`,
      "Do not invent a no-op, breadcrumb, or unrelated observability change; every diff must directly support the diagnosed goal."
    ],
    "Tool rules": [
      "Do not claim a command was run; only list commands that should validate the patch.",
      "Never expose credentials, bearer tokens, cookies, database URLs, or passwords.",
      "Never route protected backend diagnostics through /gpt/:gptId."
    ],
    "Retrieval or evidence rules": [
      "Use only sanitized context and exact file context present in the repository.",
      "Do not guess repo structure or invent file paths.",
      "Signals:",
      `trigger: ${args.trigger}`,
      args.component ? `component: ${args.component}` : "component: (none)",
      typeof args.clearOverall === "number" ? `CLEAR overall: ${args.clearOverall}` : "",
      typeof args.clearMin === "number" ? `CLEAR min: ${args.clearMin}` : "",
      "",
      "Context (sanitized):",
      safeContext,
      args.retryFeedback ? "" : "",
      args.retryFeedback ? "Previous attempt failed validation. Fix the patch based on this feedback:" : "",
      args.retryFeedback ? args.retryFeedback : ""
    ].filter(Boolean).join("\n"),
    "Validation rules": [
      "Output must parse as one JSON object.",
      "The diff must contain real hunk headers and no placeholders.",
      "Include a short list of commands to validate the change."
    ],
    "Output contract": [
      "Output ONLY valid JSON that matches this contract example exactly (same keys and value types):",
      outputContractExample
    ].join("\n"),
    "Stop rules": [
      "Stop immediately after the JSON object.",
      "Do not wrap the JSON in markdown fences or explanatory prose."
    ]
  });
}

export const patchProposalTestUtils = {
  parseJsonObjectFromModelOutput,
  validateDiffResourceLimits,
  validateUnifiedDiffShape,
  validateDiffPaths,
  validateDiffWithGitApplyCheck,
  buildPatchProposalPrompt,
  limits: {
    maxModelOutputBytes: MAX_MODEL_OUTPUT_BYTES,
    maxPatchDiffBytes: MAX_PATCH_DIFF_BYTES,
    maxPatchSections: MAX_PATCH_SECTIONS,
    maxPatchHunks: MAX_PATCH_HUNKS,
  },
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
  let lastDiagnosticCode: PatchProposalDiagnosticCode =
    "PATCH_PROPOSAL_ATTEMPT_FAILED";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = buildPatchProposalPrompt({
      ...args,
      retryFeedback: attempt > 1 ? lastDiagnosticCode : undefined,
    });

    let responseOutput: string;
    try {
      const resp = await callOpenAI(model, prompt, tokenLimit, true, {
        systemPrompt: renderPromptGuidanceSections({
          Role: "Careful senior engineer for ARCANOS self-improvement patch proposals.",
          "Personality/collaboration style": "Conservative, concise, and schema-disciplined.",
          Goal: "Return one JSON patch proposal that follows the user prompt contract.",
          "Success criteria": [
            "Valid JSON only.",
            "No prose outside the JSON object.",
            "No invented files or placeholder diff context."
          ],
          Constraints: [
            "Follow the schema exactly.",
            "Keep the patch minimal and reviewable."
          ],
          "Tool rules": "Do not claim tool execution or command results.",
          "Retrieval or evidence rules": "Use only evidence provided in the user prompt.",
          "Validation rules": "Validate the JSON shape before returning.",
          "Output contract": "Return only the JSON object requested by the user prompt.",
          "Stop rules": "Stop after the closing JSON brace."
        }),
        temperature: 0.1,
        top_p: 1,
        metadata: {
          feature: "self-improve-patch-proposal",
          trigger: args.trigger,
          component: args.component || "system",
          attempt,
        },
      });
      responseOutput = resp.output || "";
    } catch (error: unknown) {
      rethrowWorkerAiBudgetError(error);
      // Never retain or replay provider error text; it may contain request or transport details.
      lastDiagnosticCode = "PROVIDER_REQUEST_FAILED";
      continue;
    }

    try {
      const parsed = parseJsonObjectFromModelOutput(responseOutput);
      const schemaResult = patchProposalSchema.safeParse(parsed);
      if (!schemaResult.success) {
        lastDiagnosticCode = "PROPOSAL_SCHEMA_INVALID";
        continue;
      }
      const proposal = schemaResult.data;

      const shapeValidation = validateUnifiedDiffShape(proposal.diff);
      //audit Assumption: malformed diff shape cannot be repaired downstream; risk: actuator failures or unsafe PR automation; invariant: only structurally valid patches proceed; handling: regenerate with explicit feedback.
      if (!shapeValidation.valid) {
        lastDiagnosticCode =
          shapeValidation.diagnosticCode ?? "DIFF_SHAPE_INVALID";
        continue;
      }

      const pathValidation = await validateDiffPaths(
        proposal.diff,
        args.prohibitedPaths
      );
      //audit Assumption: model-authored paths are untrusted even when git accepts the patch; risk: traversal, symlink escape, or prohibited-surface modification; invariant: every normalized diff path stays within the canonical repository and loop contract; handling: reject and regenerate before invoking git.
      if (!pathValidation.valid || !pathValidation.files) {
        lastDiagnosticCode =
          pathValidation.diagnosticCode ?? "DIFF_PATH_INVALID";
        continue;
      }
      proposal.files = pathValidation.files;

      const applyValidation = await validateDiffWithGitApplyCheck(proposal.diff);
      //audit Assumption: git apply --check is the most reliable compatibility gate before PR creation; risk: repository-context mismatch; invariant: only check-clean patches can proceed; handling: regenerate with specific apply error context.
      if (!applyValidation.valid) {
        lastDiagnosticCode =
          applyValidation.diagnosticCode ?? "DIFF_GIT_APPLY_REJECTED";
        continue;
      }

      return proposal;
    } catch (error: unknown) {
      rethrowWorkerAiBudgetError(error);
      //audit Assumption: model output can intermittently violate schema/JSON contract; risk: premature cycle failure; invariant: retries should preserve deterministic constraints; handling: retry until max attempts then raise structured error.
      lastDiagnosticCode = error instanceof PatchProposalValidationError
        ? error.diagnosticCode
        : "PATCH_PROPOSAL_ATTEMPT_FAILED";
    }
  }

  throw new Error(
    `Unable to generate a valid self-improve patch proposal after ${maxAttempts} attempts. Last diagnostic: ${lastDiagnosticCode}`
  );
}
