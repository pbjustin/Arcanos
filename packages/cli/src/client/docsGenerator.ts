import {
  ARCANOS_DEGRADED_FALLBACK_MESSAGE,
  isPipelineFallback,
  runArcanosJob,
  type ArcanosJobResult,
  type RunArcanosJobOptions,
} from "./arcanosJob.js";
import { mapWithConcurrency, normalizeConcurrency as normalizeBoundedConcurrency } from "./concurrency.js";

export interface DocsGenerationSection {
  id: string;
  title: string;
  promptTitle?: string;
  prompt: string;
  retryPrompt: string;
}

export interface DocsSectionGenerationResult {
  id: string;
  title: string;
  jobId?: string;
  poll?: string;
  stream?: string;
  timedOut?: boolean;
  status: string;
  markdown?: string;
  attempts: number;
  degraded: boolean;
  error?: string;
}

export interface DocsUpdateFile {
  file: string;
  content: string;
  reason: string;
}

export interface GenerateDocsUpdateResult {
  ok: boolean;
  summary: string;
  updates: DocsUpdateFile[];
  sections: DocsSectionGenerationResult[];
  failures: DocsSectionGenerationResult[];
}

export interface GenerateDocsUpdateOptions extends RunArcanosJobOptions {
  sections?: DocsGenerationSection[];
  strict?: boolean;
  outputFile?: string;
  generatedAt?: string;
  maxConcurrency?: number;
  runJob?: (prompt: string, options: RunArcanosJobOptions) => Promise<ArcanosJobResult>;
}

export const DEFAULT_DOCS_UPDATE_FILE = "docs/GPT_ASYNC_DOCUMENTATION_WORKFLOW.md";
const DEFAULT_DOCS_GENERATION_CONCURRENCY = 2;
const MAX_DOCS_GENERATION_CONCURRENCY = 4;
const DOCUMENTATION_PLACEHOLDERS: Record<string, string> = {
  GPT_WRITE_ROUTE: "/gpt/:gptId",
  JOB_RESULT_ROUTE: "/jobs/:id/result",
  JOB_STREAM_ROUTE: "/jobs/:id/stream",
  STATUS_ROUTE: "/status",
  WORKERS_STATUS_ROUTE: "/workers/status",
  WORKER_HEALTH_ROUTE: "/worker-helper/health",
  MCP_ROUTE: "/mcp",
  DAG_RUN_ROUTE: "/api/arcanos/dag/runs/{runId}",
  DAG_TRACE_ROUTE: "/api/arcanos/dag/runs/{runId}/trace",
};

export class DocsGenerationError extends Error {
  result: GenerateDocsUpdateResult;

  constructor(message: string, result: GenerateDocsUpdateResult) {
    super(message);
    this.name = "DocsGenerationError";
    this.result = result;
  }
}

export const DOCS_GENERATION_SECTIONS: DocsGenerationSection[] = [
  createDocsSection({
    id: "gpt-api-behavior",
    title: "/gpt/:gptId API behavior",
    promptTitle: "GPT writing route behavior",
    focus: [
      "the writing-plane role of POST GPT_WRITE_ROUTE",
      "direct execution versus async fallback",
      "why async completion data and operator controls must use direct endpoints",
    ],
  }),
  createDocsSection({
    id: "job-polling-contract",
    title: "Job polling and async contract",
    promptTitle: "Async completion contract",
    focus: [
      "canonical queued/running/completed response fields",
      "bounded polling with JOB_RESULT_ROUTE",
      "timeout handling and stream metadata via JOB_STREAM_ROUTE",
    ],
  }),
  createDocsSection({
    id: "priority-gpt-behavior",
    title: "Priority GPT behavior",
    focus: [
      "priority GPTs still use the same async contract",
      "priority routing is not a guarantee of inline completion",
      "clients must poll even when the GPT is allowlisted or fast-path capable",
    ],
  }),
  createDocsSection({
    id: "queue-diagnostics",
    title: "Queue diagnostics",
    promptTitle: "Queue observability documentation",
    focus: [
      "worker and queue operational state via WORKERS_STATUS_ROUTE and WORKER_HEALTH_ROUTE",
      "operator-only health checks through STATUS_ROUTE and MCP_ROUTE",
      "avoiding observability prompts through GPT_WRITE_ROUTE",
    ],
  }),
  createDocsSection({
    id: "dag-tracing",
    title: "DAG tracing and slow-node timing",
    promptTitle: "Trace timing documentation",
    focus: [
      "trace records via DAG_TRACE_ROUTE",
      "slow trace timing and node metrics",
      "why trace records are control-plane data",
    ],
  }),
  createDocsSection({
    id: "operational-caveats",
    title: "Known limitations / operational caveats",
    focus: [
      "degraded pipeline fallback detection",
      "splitting large documentation prompts",
      "actionable operator response after repeated degraded fallback",
    ],
  }),
];

/**
 * Generates a documentation update by asking ARCANOS for narrow markdown sections and rejecting degraded fallback completions.
 * Inputs/Outputs: ARCANOS job client options -> deterministic update payload for the existing docs workflow.
 * Edge cases: each section retries once with a narrower prompt; strict mode fails on repeated degraded fallback.
 */
export async function generateDocsUpdate(
  options: GenerateDocsUpdateOptions
): Promise<GenerateDocsUpdateResult> {
  const sections = options.sections ?? DOCS_GENERATION_SECTIONS;
  const runJob = options.runJob ?? runArcanosJob;
  const strict = options.strict ?? true;
  const maxConcurrency = normalizeConcurrency(options.maxConcurrency);
  const sectionResults = await mapWithConcurrency(sections, maxConcurrency, async (section) => {
    const initial = await runDocsSectionJob(section, section.prompt, 1, options, runJob);

    if (initial.degraded) {
      const retry = await runDocsSectionJob(section, section.retryPrompt, 2, options, runJob);
      return retry;
    }

    return initial;
  });
  const failures = sectionResults.filter((section) => section.degraded || Boolean(section.error));

  const successfulSections = sectionResults.filter((section) => section.markdown && !section.degraded && !section.error);
  const content = renderDocsUpdateMarkdown({
    sections: successfulSections,
    failures,
    generatedAt: options.generatedAt,
  });
  const outputFile = options.outputFile ?? DEFAULT_DOCS_UPDATE_FILE;

  const result = {
    ok: failures.length === 0,
    summary: failures.length === 0
      ? `Generated ${successfulSections.length} ARCANOS async documentation sections.`
      : `Generated ${successfulSections.length} ARCANOS async documentation sections with ${failures.length} failure(s).`,
    updates: [
      {
        file: outputFile,
        content,
        reason: "Document ARCANOS async GPT polling and degraded fallback handling.",
      },
    ],
    sections: sectionResults,
    failures,
  };

  if (strict && failures.length > 0) {
    const degradedFailure = failures.find((failure) => failure.degraded);
    if (degradedFailure) {
      throw new DocsGenerationError(
        `${ARCANOS_DEGRADED_FALLBACK_MESSAGE} Section: ${degradedFailure.title}.`,
        result
      );
    }

    throw new DocsGenerationError(
      `ARCANOS documentation generation failed for ${failures.length} section(s).`,
      result
    );
  }

  return result;
}

function createDocsSection(input: {
  id: string;
  title: string;
  promptTitle?: string;
  focus: string[];
}): DocsGenerationSection {
  const focusList = input.focus.map((item) => `- ${item}`).join("\n");
  const promptTitle = input.promptTitle ?? input.title;
  const prompt = [
    `Write the documentation section "${promptTitle}" for ARCANOS.`,
    "Return markdown only.",
    "This is a static documentation-writing task, not a runtime operation.",
    "Use placeholder route tokens exactly as provided; do not expand them.",
    "Do not perform a full repository analysis.",
    "Do not call tools or describe tool usage.",
    "Keep the section scoped to these points:",
    focusList,
  ].join("\n");
  const retryPrompt = [
    `Write only a compact markdown subsection for "${promptTitle}".`,
    "Return markdown only.",
    "Use placeholder route tokens exactly as provided; do not expand them.",
    "Limit the answer to one heading and no more than six bullets.",
    "Cover only the most important client/operator contract details.",
  ].join("\n");

  return {
    id: input.id,
    title: input.title,
    promptTitle: input.promptTitle,
    prompt,
    retryPrompt,
  };
}

async function runDocsSectionJob(
  section: DocsGenerationSection,
  prompt: string,
  attempt: number,
  options: GenerateDocsUpdateOptions,
  runJob: (prompt: string, options: RunArcanosJobOptions) => Promise<ArcanosJobResult>
): Promise<DocsSectionGenerationResult> {
  try {
    const result = await runJob(prompt, {
      ...options,
      context: {
        ...(options.context ?? {}),
        docsGenerationSection: section.id,
        docsGenerationAttempt: attempt,
      },
    });
    const degraded = isDegradedResult(result);

    if (degraded) {
      return {
        id: section.id,
        title: section.title,
        jobId: result.jobId,
        poll: result.poll,
        stream: result.stream,
        timedOut: result.timedOut,
        status: result.status,
        attempts: attempt,
        degraded: true,
        error: ARCANOS_DEGRADED_FALLBACK_MESSAGE,
      };
    }

    const markdown = extractMarkdown(result);
    if (!markdown) {
      return {
        id: section.id,
        title: section.title,
        jobId: result.jobId,
        poll: result.poll,
        stream: result.stream,
        timedOut: result.timedOut,
        status: result.status,
        attempts: attempt,
        degraded: false,
        error: "ARCANOS documentation section returned no markdown content.",
      };
    }

    return {
      id: section.id,
      title: section.title,
      jobId: result.jobId,
      poll: result.poll,
      stream: result.stream,
      timedOut: result.timedOut,
      status: result.status,
      markdown: restoreDocumentationPlaceholders(markdown),
      attempts: attempt,
      degraded: false,
    };
  } catch (error) {
    return {
      id: section.id,
      title: section.title,
      status: "failed",
      attempts: attempt,
      degraded: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isDegradedResult(result: ArcanosJobResult): boolean {
  return result.degraded ||
    isPipelineFallback(result) ||
    isPipelineFallback(result.raw) ||
    isPipelineFallback(result.result);
}

function extractMarkdown(result: ArcanosJobResult): string | undefined {
  const candidates = collectTextCandidates(result.result, result.raw);
  const markdown = candidates.find((candidate) => candidate.trim().length > 0)?.trim();
  return markdown ? stripMarkdownFence(markdown) : undefined;
}

function collectTextCandidates(...values: unknown[]): string[] {
  const candidates: string[] = [];
  const queue = [...values];
  const seen = new Set<unknown>();

  while (queue.length > 0 && candidates.length < 24) {
    const current = queue.shift();
    if (typeof current === "string") {
      candidates.push(current);
      continue;
    }

    if (!isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);

    for (const key of ["markdown", "text", "content", "message", "result", "output", "response"]) {
      if (key in current) {
        queue.push(current[key]);
      }
    }
  }

  return candidates;
}

function stripMarkdownFence(markdown: string): string {
  const trimmed = markdown.trim();
  const fenceMatch = /^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function restoreDocumentationPlaceholders(markdown: string): string {
  let restored = markdown;
  for (const [placeholder, value] of Object.entries(DOCUMENTATION_PLACEHOLDERS)) {
    restored = restored.replaceAll(placeholder, value);
  }
  return restored;
}

function normalizeConcurrency(value: number | undefined): number {
  return normalizeBoundedConcurrency(
    value,
    DEFAULT_DOCS_GENERATION_CONCURRENCY,
    MAX_DOCS_GENERATION_CONCURRENCY
  );
}

function renderDocsUpdateMarkdown(input: {
  sections: DocsSectionGenerationResult[];
  failures: DocsSectionGenerationResult[];
  generatedAt?: string;
}): string {
  const lines = [
    "# ARCANOS GPT Async Documentation Workflow",
    "",
    "This document is generated from narrow ARCANOS jobs. Control-plane operations stay on direct control endpoints; `/gpt/:gptId` is used only for writing jobs.",
    "",
    "## Canonical Routes",
    "",
    "- Writing route: `POST /gpt/:gptId`",
    "- Job result polling: `GET /jobs/:id/result`",
    "- Job stream: `GET /jobs/:id/stream`",
    "- Queue and worker health: `GET /workers/status`, `GET /worker-helper/health`",
    "- DAG trace: `GET /api/arcanos/dag/runs/{runId}/trace`",
    "",
  ];

  if (input.generatedAt) {
    lines.splice(2, 0, `Generated at: ${input.generatedAt}`, "");
  }

  for (const section of input.sections) {
    lines.push(section.markdown!.trim(), "");
  }

  if (input.failures.length > 0) {
    lines.push("## Generation Gaps", "");
    for (const failure of input.failures) {
      lines.push(`- ${failure.title}: ${failure.error ?? "generation failed"}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
