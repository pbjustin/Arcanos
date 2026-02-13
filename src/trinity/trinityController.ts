import { detectTier } from "./reasoning/tierDetector";
import { buildReasoningConfig } from "./reasoning/reasoningConfig";
import { InvocationBudget } from "./reasoning/invocationBudget";
import { runReflection } from "./reasoning/reflectionController";

import { enforceTokenCap } from "./guards/tokenCap";
import { Watchdog } from "./guards/watchdog";
import { tierLimits } from "./guards/concurrencyGovernor";
import { recordSessionTokens } from "./guards/sessionTokenAuditor";
import { detectDowngrade } from "./guards/downgradeDetector";

import { logTelemetry } from "./observability/telemetry";
import { recordLatency } from "./observability/driftMonitor";

export async function trinityController(
  prompt: string,
  sessionId: string,
  lineageId: string,
  callGPT: Function
) {
  const start = Date.now();
  const tier = detectTier(prompt);

  const watchdog = new Watchdog();

  const maxBudget =
    tier === "critical" ? 4 :
    tier === "complex" ? 2 : 1;

  const budget = new InvocationBudget(maxBudget);

  const [release] = await tierLimits[tier].acquire();

  try {
    budget.increment();
    watchdog.check();

    const response = await callGPT({
      model: "gpt-5.1-2025-11-13",
      reasoning: buildReasoningConfig(tier),
      max_tokens: enforceTokenCap(),
      messages: [{ role: "user", content: prompt }]
    });

    let final = response.output_text;
    let totalTokens = response.usage.total_tokens;

    if (tier === "critical") {
      const critique = await runReflection(
        callGPT,
        final,
        budget,
        watchdog
      );

      final +=
        "\n\n--- CRITICAL REVIEW ---\n" +
        critique.output_text;

      totalTokens += critique.usage.total_tokens;
    }

    recordSessionTokens(sessionId, totalTokens);

    const downgradeDetected =
      detectDowngrade(
        "gpt-5.1-2025-11-13",
        response.model
      );

    const latency = Date.now() - start;
    recordLatency(latency);

    logTelemetry({
      tier,
      totalTokens,
      downgradeDetected,
      latency
    });

    return {
      final,
      tier,
      totalTokens,
      downgradeDetected
    };

  } finally {
    release();
  }
}
