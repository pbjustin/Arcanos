import { invokeTool } from "@arcanos/cli/client";

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

const repoInspectionPhrases = [
  "implemented",
  "codebase",
  "repo",
  "repository",
  "files",
  "commands",
  "protocol",
  "protocol v1",
  "cli",
  "scaffold",
  "missing",
  "what exists",
  "what is missing",
  "can you see my codebase"
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

  const normalizedPrompt = prompt.toLowerCase();
  return repoInspectionPhrases.some((phrase) => normalizedPrompt.includes(phrase));
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
 * Builds a grounded prompt that forces the answering model to rely on collected repo evidence.
 * Inputs: original user prompt plus structured implementation evidence.
 * Outputs: enriched prompt text safe for `trinity.ask`.
 * Edge cases: evidence is serialized as JSON to preserve deterministic facts over narrative paraphrase.
 */
export function buildRepoInspectionPrompt(
  userPrompt: string,
  evidence: ImplementationDoctorResult
): string {
  return [
    "Answer the user's repository implementation question using only the direct inspection evidence below.",
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
