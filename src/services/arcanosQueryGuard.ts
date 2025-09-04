// arcanosQueryGuard.ts
// Unified domain guard + OpenAI SDK dispatcher with TypeScript support

import { getOpenAIClient } from "./openai.js";

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
}

export interface GuardedQuery extends QueryInput {
  domain: Domain;
}

export const DOMAIN_CATEGORIES = {
  user: ["gaming", "guides", "knowledge"] as Domain[],
  system: ["builds", "memory patterns", "audit logs"] as Domain[],
};

// ----------------------
// Guard Logic
// ----------------------
function detectDomain(query: QueryInput): "user" | "system" {
  if (!query.domain) return "user";
  return DOMAIN_CATEGORIES.system.includes(query.domain) ? "system" : "user";
}

export function guardQuery(query: QueryInput): GuardedQuery {
  const domainType = detectDomain(query);

  if (domainType === "system" && !query.explicitSystemAccess) {
    throw new Error(
      `⚠️ Access to system domain '${query.domain}' denied. Explicit user intent required.`
    );
  }

  return {
    ...query,
    domain: query.domain || "knowledge", // Default to knowledge
  };
}

// ----------------------
// OpenAI Dispatch Wrapper
// ----------------------
export async function dispatchQuery(rawQuery: QueryInput): Promise<string> {
  const safeQuery = guardQuery(rawQuery);

  if (!openai) {
    throw new Error('OpenAI client not available');
  }

  const response = await openai.chat.completions.create({
    model: "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote", // ✅ Your fine-tuned ARCANOS model
    messages: [
      { role: "system", content: `Domain: ${safeQuery.domain}` },
      { role: "user", content: safeQuery.prompt },
    ],
    temperature: 0.2,
  });

  return response.choices[0].message?.content || "";
}
