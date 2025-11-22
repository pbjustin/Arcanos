// arcanosQueryGuard.ts
// Unified domain guard + OpenAI SDK dispatcher with TypeScript support

import { getOpenAIClient, getDefaultModel } from "./openai.js";

// ✅ Use centralized OpenAI client for consistency
const openai = getOpenAIClient();

// ----------------------
// Domain / Category Types
// ----------------------
export type Domain = "gaming" | "guides" | "knowledge" | "builds" | "memory patterns" | "audit logs";

export interface QueryInput {
  prompt: string;
  domain?: Domain;
  explicitSystemAccess?: boolean;
  context?: string[];
}

export interface GuardedQuery extends QueryInput {
  domain: Domain;
  prompt: string;
  context?: string[];
}

export const DOMAIN_CATEGORIES = {
  user: ["gaming", "guides", "knowledge"] as Domain[],
  system: ["builds", "memory patterns", "audit logs"] as Domain[],
};

const DOMAIN_GUIDANCE: Record<Domain, string> = {
  gaming: "Provide strategic, factual guidance grounded in known game mechanics.",
  guides: "Offer step-by-step instructions and highlight prerequisites.",
  knowledge: "Deliver concise, sourced facts; acknowledge gaps if unsure.",
  builds: "Return reproducible build or deployment steps and configuration notes.",
  "memory patterns": "Work with memory schema expectations and avoid leaking secrets.",
  "audit logs": "Summarize observations precisely and flag any anomalies you infer.",
};

// ----------------------
// Guard Logic
// ----------------------
function detectDomain(query: QueryInput): "user" | "system" {
  if (!query.domain) return "user";
  return DOMAIN_CATEGORIES.system.includes(query.domain) ? "system" : "user";
}

export function guardQuery(query: QueryInput): GuardedQuery {
  const trimmedPrompt = query.prompt?.trim();
  if (!trimmedPrompt) {
    throw new Error("Prompt cannot be empty");
  }

  const normalizedContext = query.context
    ?.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const domainType = detectDomain(query);

  if (domainType === "system" && !query.explicitSystemAccess) {
    throw new Error(
      `⚠️ Access to system domain '${query.domain}' denied. Explicit user intent required.`
    );
  }

  return {
    ...query,
    prompt: trimmedPrompt,
    context: normalizedContext,
    domain: query.domain || "knowledge", // Default to knowledge
  };
}

// ----------------------
// OpenAI Dispatch Wrapper
// ----------------------
function buildMessages(query: GuardedQuery) {
  const messages: { role: "system" | "user"; content: string }[] = [
    {
      role: "system",
      content: `Domain: ${query.domain}. ${DOMAIN_GUIDANCE[query.domain]}`,
    },
    {
      role: "system",
      content:
        "Respond concisely, cite only provided facts, and say when information is unavailable.",
    },
  ];

  if (query.context?.length) {
    const formatted = query.context.map((item) => `- ${item}`).join("\n");
    messages.push({ role: "system", content: `Context:\n${formatted}` });
  }

  messages.push({ role: "user", content: query.prompt });

  return messages;
}

export async function dispatchQuery(rawQuery: QueryInput): Promise<string> {
  const safeQuery = guardQuery(rawQuery);

  if (!openai) {
    throw new Error('OpenAI client not available');
  }

  const response = await openai.chat.completions.create({
    model: getDefaultModel(),
    messages: buildMessages(safeQuery),
    temperature: 0.1,
    top_p: 0.8,
    frequency_penalty: 0.1,
    presence_penalty: 0,
  });

  return response.choices[0].message?.content || "";
}
