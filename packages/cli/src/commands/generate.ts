import { generateGptPrompt } from "../client/backend.js";
import { serializeDeterministicJson } from "../client/protocol.js";
import { extractHumanReadableText } from "./humanOutput.js";
import type { CliCommandResult, GenerateCommandInvocation } from "./types.js";

export async function runGenerateCommand(
  invocation: GenerateCommandInvocation
): Promise<CliCommandResult<Record<string, unknown>>> {
  const startedAt = Date.now();
  const backendResponse = await generateGptPrompt({
    baseUrl: invocation.options.baseUrl,
    gptId: invocation.gptId,
    prompt: invocation.prompt,
    mode: invocation.mode
  });
  const latencyMs = Date.now() - startedAt;
  const routeDetails = extractRouteDetails(backendResponse, invocation.mode);

  return {
    command: "gpt.generate",
    request: {
      command: "gpt.generate",
      baseUrl: invocation.options.baseUrl,
      gptId: invocation.gptId,
      prompt: invocation.prompt,
      mode: invocation.mode
    },
    response: {
      ok: true,
      data: backendResponse,
      meta: {
        executedBy: "http-backend-cli",
        latencyMs,
        routeDecision: routeDetails
      }
    },
    humanOutput: extractGenerateHumanOutput(backendResponse, latencyMs, routeDetails),
    extraJson: {
      diagnostics: {
        latencyMs,
        routeDecision: routeDetails
      }
    }
  };
}

function extractRouteDetails(
  payload: Record<string, unknown>,
  requestedMode: "fast" | "orchestrated"
): Record<string, unknown> {
  const routeDecision = isRecord(payload.routeDecision) ? payload.routeDecision : {};
  const route = isRecord(payload._route) ? payload._route : {};
  const status = typeof payload.status === "string" ? payload.status : null;
  const jobId = typeof payload.jobId === "string" ? payload.jobId : null;
  const path =
    typeof routeDecision.path === "string"
      ? routeDecision.path
      : jobId
      ? "orchestrated_path"
      : route.route === "fast_path"
      ? "fast_path"
      : requestedMode === "orchestrated"
      ? "orchestrated_path"
      : "unknown";
  const queueBypassed =
    typeof routeDecision.queueBypassed === "boolean"
      ? routeDecision.queueBypassed
      : path === "fast_path";

  return {
    requestedMode,
    path,
    queueBypassed,
    ...(typeof routeDecision.reason === "string" ? { reason: routeDecision.reason } : {}),
    ...(jobId ? { jobId } : {}),
    ...(status ? { status } : {}),
    ...(typeof route.route === "string" ? { route: route.route } : {})
  };
}

function extractGenerateHumanOutput(
  payload: Record<string, unknown>,
  latencyMs: number,
  routeDetails: Record<string, unknown>
): string {
  const directText = extractHumanReadableText(payload.result, payload.message);
  const body = directText || serializeDeterministicJson(payload);
  const path = typeof routeDetails.path === "string" ? routeDetails.path : "unknown";
  const queueBypassed = routeDetails.queueBypassed === true ? "yes" : "no";
  const jobId = typeof routeDetails.jobId === "string" ? `, job ${routeDetails.jobId}` : "";

  return [
    body,
    "",
    `Latency: ${latencyMs}ms`,
    `Route: ${path}; queue bypassed: ${queueBypassed}${jobId}`
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

