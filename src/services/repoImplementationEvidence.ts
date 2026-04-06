import { invokeTool } from "@arcanos/cli/client";

import { isPromptAuthoringRequest } from '@services/promptDebugTraceService.js';

export interface ImplementationDoctorCheck {
  name: string;
  status: "pass" | "missing";
}

export interface ImplementationDoctorEvidence {
  rootPath: string;
  filesFound: string[];
  commandsDetected: string[];
  repoToolsDetected: string[];
}

export interface ImplementationDoctorResult {
  status: "implemented" | "partially_implemented";
  checks: ImplementationDoctorCheck[];
  evidence: ImplementationDoctorEvidence;
}

export interface RepoInspectionToolResult {
  toolId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: unknown;
}

export interface RepoInspectionEvidence {
  tree: RepoInspectionToolResult;
  status: RepoInspectionToolResult;
  log: RepoInspectionToolResult;
  searches: RepoInspectionToolResult[];
}

const repoTargetPatterns = [
  /\brepo\b/,
  /\brepository\b/,
  /\bcodebase\b/,
  /\bcode\b/,
  /\bsource\b/,
  /\bfiles?\b/,
  /\bimplementation\b/,
  /\bcli\b/,
  /\bprotocol\b/,
  /\bschemas?\b/,
  /\bdaemon\b/,
  /\btools?\b/,
  /\bcommands?\b/,
  /\bgit\b/
];

const repoInspectionIntentPatterns = [
  /\binspect\b/,
  /\bshow\b/,
  /\blist\b/,
  /\bfind\b/,
  /\blocate\b/,
  /\bwhere\b/,
  /\bwhich\b/,
  /\bwhat\b/,
  /\bread\b/,
  /\bopen\b/,
  /\bverify\b/,
  /\bcheck\b/,
  /\bdo i have\b/,
  /\bcan you see\b/,
  /\b(?:is|are)\b.*\b(?:implemented|present|missing|available|configured)\b/,
  /\b(?:what|which)\b.*\b(?:files?|commands?|tools?|schemas?|implementations?)\b/,
  /\bstatus\b/
];

const repoInspectionDisallowedPatterns = [
  /\bdo\s+not\s+use\s+repo(?:\s+inspection)?\b/i,
  /\bno\s+repo(?:\s+inspection)?\b/i,
  /\bonly\s+return\s+runtime\s+values\b/i,
  /\bruntime\s+values\s+only\b/i,
];

const verificationPhrases = [
  "is it implemented",
  "implemented",
  "can you see my codebase",
  "what files exist",
  "what commands exist",
  "is my cli implemented",
  "do i have",
  "what is missing",
];

/**
 * Detects whether a prompt is asking for implementation or repository inspection evidence.
 * Inputs: raw user prompt text.
 * Outputs: boolean flag for whether repo inspection should run before answering.
 * Edge cases: conservative substring matching biases toward inspection rather than unsupported, chat-only answers.
 */
export function shouldInspectRepoPrompt(prompt: string | null): boolean {
  if (!prompt) {
    return false;
  }

  if (isPromptAuthoringRequest(prompt)) {
    return false;
  }

  const normalizedPrompt = prompt.toLowerCase();
  if (repoInspectionDisallowedPatterns.some((pattern) => pattern.test(normalizedPrompt))) {
    return false;
  }
  if (verificationPhrases.some((phrase) => normalizedPrompt.includes(phrase))) {
    return true;
  }

  const hasRepoTarget = repoTargetPatterns.some((pattern) => pattern.test(normalizedPrompt));
  if (!hasRepoTarget) {
    return false;
  }

  return repoInspectionIntentPatterns.some((pattern) => pattern.test(normalizedPrompt));
}

/**
 * Detect whether a prompt is explicitly asking for verification that must be grounded in repository evidence.
 * Inputs: raw user prompt text.
 * Outputs: boolean flag requiring repo evidence before the backend answers.
 * Edge cases: conservative phrase matching biases toward failing closed instead of letting the model bluff.
 */
export function isVerificationQuestion(prompt: string | null): boolean {
  if (!prompt) {
    return false;
  }

  const normalizedPrompt = prompt.toLowerCase();
  return verificationPhrases.some((phrase) => normalizedPrompt.includes(phrase));
}

/**
 * Collects implementation evidence through the protocol-visible doctor tool.
 * Inputs: none.
 * Outputs: normalized implementation diagnostic result.
 * Edge cases: tool failures throw so callers can fail closed instead of answering without evidence.
 */
export async function collectRepoImplementationEvidence(): Promise<ImplementationDoctorResult> {
  return await invokeTool({
    toolId: "doctor.implementation",
    inputs: {},
  }) as ImplementationDoctorResult;
}

/**
 * Collect deterministic repository evidence through protocol-visible repo tools before model execution.
 * Inputs: original user prompt.
 * Outputs: bounded tree/status/log/search evidence payload.
 * Edge cases: individual tool failures are preserved in-band so callers can still ground answers in partial evidence.
 */
export async function collectRepoInspectionEvidence(userPrompt: string): Promise<RepoInspectionEvidence> {
  const promptLower = userPrompt.toLowerCase();
  let treeInput: Record<string, unknown> = { path: ".", depth: 3, limit: 200 };
  const likelyQueries = [
    "task.create|plan.generate|exec.start|tool.invoke",
    "repo.listTree|repo.readFile|repo.search|repo.getStatus|repo.getLog|repo.getDiff",
    "protocol|schema|schemas|arcanos-v1|arcanos.v1",
    "cli|command|commands",
  ];

  if (promptLower.includes("cli")) {
    treeInput = { path: "packages/cli", depth: 3, limit: 200 };
    likelyQueries.push("cli");
  }
  if (promptLower.includes("protocol") || promptLower.includes("schema")) {
    treeInput = { path: "packages/protocol", depth: 4, limit: 200 };
    likelyQueries.push("protocol|schema");
  }
  if (promptLower.includes("tool") || promptLower.includes("repo")) {
    likelyQueries.push("tool.registry|tool.describe|tool.invoke");
  }

  const tree = await safeInvokeRepoTool("repo.listTree", treeInput);
  const status = await safeInvokeRepoTool("repo.getStatus", {});
  const log = await safeInvokeRepoTool("repo.getLog", { limit: 10 });
  const searches: RepoInspectionToolResult[] = [];

  for (const query of likelyQueries) {
    searches.push(
      await safeInvokeRepoTool("repo.search", { query })
    );
  }

  return {
    tree,
    status,
    log,
    searches,
  };
}

/**
 * Builds a grounded prompt that forces the answering model to rely on collected repo evidence.
 * Inputs: original user prompt plus structured implementation evidence.
 * Outputs: enriched prompt text safe for `trinity.query`.
 * Edge cases: evidence is serialized as JSON to preserve deterministic facts over narrative paraphrase.
 */
export function buildRepoInspectionPrompt(
  userPrompt: string,
  evidence: unknown
): string {
  return [
    "Answer the user's repository implementation question using only the direct inspection evidence below.",
    "When repository evidence is provided, do not say that you cannot inspect the repository.",
    "If the evidence does not support a claim, say that explicitly instead of guessing.",
    `User question: ${userPrompt}`,
    `Repository evidence JSON:\n${JSON.stringify(evidence, null, 2)}`,
  ].join("\n\n");
}

/**
 * Build a deterministic user-facing summary from collected repository evidence.
 * Inputs: original user prompt plus structured implementation evidence.
 * Outputs: concise answer grounded only in the inspected repository facts.
 * Edge cases: missing evidence arrays degrade to explicit "none detected" text instead of guessing.
 */
export function buildRepoInspectionAnswer(
  userPrompt: string,
  evidence: unknown
): string {
  if (isImplementationDoctorResult(evidence)) {
    return buildDoctorInspectionAnswer(userPrompt, evidence);
  }

  if (isRepoInspectionEvidence(evidence)) {
    return buildCollectedRepoInspectionAnswer(userPrompt, evidence);
  }

  return "Repository inspection evidence was collected, but it could not be summarized safely.";
}

function buildDoctorInspectionAnswer(
  userPrompt: string,
  evidence: ImplementationDoctorResult
): string {
  const filesFound = evidence.evidence.filesFound ?? [];
  const repoToolsDetected = evidence.evidence.repoToolsDetected ?? [];
  const commandsDetected = evidence.evidence.commandsDetected ?? [];
  const protocolFile =
    filesFound.find((filePath) => filePath.includes("protocol/schemas"))
    ?? filesFound.find((filePath) => filePath.endsWith("envelope.schema.json"))
    ?? "none detected";

  const lines = [
    evidence.status === "implemented"
      ? "Yes, I can see your codebase structure and implementation signals."
      : "I can inspect the codebase, and the implementation appears only partially complete.",
  ];

  if (userPrompt.toLowerCase().includes("cli")) {
    lines.push(
      filesFound.includes("packages/cli/src")
        ? "- CLI implementation: The CLI is implemented — I see `packages/cli/src`."
        : "- CLI implementation: I do not see `packages/cli/src` in the inspected evidence."
    );
  }

  lines.push(
    repoToolsDetected.length > 0
      ? `- Repo tools available: ${repoToolsDetected.map((toolId) => `\`${toolId}\``).join(", ")}.`
      : "- Repo tools available: none detected."
  );

  if (commandsDetected.length > 0) {
    lines.push(`- Commands detected: ${commandsDetected.map((command) => `\`${command}\``).join(", ")}.`);
  }

  lines.push(`- One concrete protocol file: \`${protocolFile}\`.`);

  return lines.join("\n");
}

function buildCollectedRepoInspectionAnswer(
  userPrompt: string,
  evidence: RepoInspectionEvidence
): string {
  const normalizedPrompt = userPrompt.toLowerCase();
  const treeEntries = readRecordArray(evidence.tree.data, "entries");
  const allTreePaths = treeEntries
    .map((entry) => (typeof entry.path === "string" ? entry.path : ""))
    .filter((path) => path.length > 0);
  const treePaths = allTreePaths.slice(0, 12);
  const statusChanges = readRecordArray(evidence.status.data, "changes");
  const statusBranch = readStringValue(evidence.status.data, "branch");
  const statusClean = readBooleanValue(evidence.status.data, "clean");
  const logCommits = readRecordArray(evidence.log.data, "commits");
  const searchMatchObjects = evidence.searches.flatMap((search) => readRecordArray(search.data, "matches"));
  const searchMatches = searchMatchObjects
    .map((match) => {
      const path = typeof match.path === "string" ? match.path : "";
      const preview = typeof match.preview === "string" ? match.preview : "";
      return [path, preview].filter((value) => value.length > 0).join(": ");
    })
    .filter((value): value is string => value.length > 0);
  const combinedSearchText = searchMatches.join("\n");
  const detectedRepoTools = collectMatches(
    combinedSearchText,
    /\brepo\.(?:listTree|readFile|search|getStatus|getLog|getDiff)\b/g
  );
  const detectedCommands = collectMatches(
    combinedSearchText,
    /\b(?:task\.create|plan\.generate|exec\.start|exec\.resume|tool\.invoke|tool\.describe|tool\.registry)\b/g
  );
  const cliPaths = allTreePaths.filter((item) => item.startsWith("packages/cli"));
  const protocolPaths = allTreePaths.filter((item) => item.startsWith("packages/protocol/schemas/v1"));
  const lines: string[] = [];

  if (
    normalizedPrompt.includes("can you see my codebase")
    || normalizedPrompt.includes("repo")
    || normalizedPrompt.includes("repository")
    || normalizedPrompt.includes("codebase")
  ) {
    lines.push("Yes. I can inspect the repository through the repo tools.");
  }

  if (normalizedPrompt.includes("file")) {
    lines.push(
      treePaths.length > 0
        ? `Files and directories found include: ${treePaths.map((item) => `\`${item}\``).join(", ")}.`
        : "I did not get a usable tree listing from the repository tools."
    );
  }

  if (normalizedPrompt.includes("cli")) {
    lines.push(
      cliPaths.length > 0
        ? `CLI implementation is present. I found ${cliPaths.slice(0, 4).map((item) => `\`${item}\``).join(", ")}.`
        : "I did not find a CLI package path in the inspected tree output."
    );
  }

  if (normalizedPrompt.includes("protocol") || normalizedPrompt.includes("schema")) {
    lines.push(
      protocolPaths.length > 0
        ? `Protocol v1 schemas are present under ${protocolPaths.slice(0, 4).map((item) => `\`${item}\``).join(", ")}.`
        : "I did not find `packages/protocol/schemas/v1` in the inspected tree output."
    );
  }

  if (normalizedPrompt.includes("tool")) {
    lines.push(
      detectedRepoTools.length > 0
        ? `Repo tools detected in code search: ${detectedRepoTools.map((toolId) => `\`${toolId}\``).join(", ")}.`
        : `Repo tool calls succeeded for ${["repo.listTree", "repo.getStatus", "repo.getLog", "repo.search"].map((toolId) => `\`${toolId}\``).join(", ")}.`
    );
  }

  if (detectedCommands.length > 0) {
    lines.push(`Commands detected in search results: ${detectedCommands.map((command) => `\`${command}\``).join(", ")}.`);
  }

  if (statusBranch || statusChanges.length > 0 || statusClean !== null) {
    const changeSummary = statusChanges
      .slice(0, 5)
      .map((entry) => {
        const path = typeof entry.path === "string" ? entry.path : "unknown";
        const indexStatus = typeof entry.indexStatus === "string" ? entry.indexStatus : "?";
        const workTreeStatus = typeof entry.workTreeStatus === "string" ? entry.workTreeStatus : "?";
        return `${indexStatus}${workTreeStatus} ${path}`;
      });
    const cleanSummary = statusClean === true ? "clean" : "dirty";
    lines.push(
      `Git status snapshot: branch=${statusBranch || "unknown"}, ${cleanSummary}${changeSummary.length > 0 ? `, changes=${changeSummary.join("; ")}` : ""}.`
    );
  }

  if (logCommits.length > 0) {
    const firstCommit = logCommits[0];
    const shortHash = typeof firstCommit.shortHash === "string" ? firstCommit.shortHash : "";
    const subject = typeof firstCommit.subject === "string" ? firstCommit.subject : "";
    if (shortHash || subject) {
      lines.push(`Recent commit sample: \`${[shortHash, subject].filter((value) => value.length > 0).join(" ")}\`.`);
    }
  }

  if (lines.length === 0) {
    return "Repository inspection ran, but it did not return enough evidence to answer the question.";
  }

  return lines.join("\n");
}

function isImplementationDoctorResult(value: unknown): value is ImplementationDoctorResult {
  return typeof value === "object"
    && value !== null
    && "status" in value
    && "checks" in value
    && "evidence" in value;
}

function isRepoInspectionEvidence(value: unknown): value is RepoInspectionEvidence {
  return typeof value === "object"
    && value !== null
    && "tree" in value
    && "status" in value
    && "log" in value
    && "searches" in value;
}

function readRecordArray(
  value: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown>[] {
  const candidate = value?.[key];
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)
  );
}

function readStringValue(
  value: Record<string, unknown> | undefined,
  key: string
): string {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : "";
}

function readBooleanValue(
  value: Record<string, unknown> | undefined,
  key: string
): boolean | null {
  const candidate = value?.[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function collectMatches(text: string, pattern: RegExp): string[] {
  return Array.from(new Set(text.match(pattern) ?? []));
}

async function safeInvokeRepoTool(
  toolId: string,
  inputs: Record<string, unknown>
): Promise<RepoInspectionToolResult> {
  try {
    const data = await invokeTool({ toolId, inputs }) as Record<string, unknown>;
    return {
      toolId,
      ok: true,
      data,
    };
  } catch (error) {
    return {
      toolId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
