// Patch: Memory Write + Index Normalizer
// Purpose: Every time storeMemory() is called, auto-index the entry using normalized aliases
// Example: 'baldurs gate 3' → also stores alias keys like 'bg3', 'baldur', 'baldurs_gate_3'

import { writeMemory, indexMemory } from "./memory.js"; // adjust as needed

function normalizeAliases(topic: string): string[] {
  const base = topic.toLowerCase();
  const aliases = new Set<string>();

  aliases.add(base);
  aliases.add(base.replace(/ /g, "_"));
  aliases.add(base.replace(/ /g, "-"));
  if (base.includes("baldur")) {
    aliases.add("bg3");
    aliases.add("baldurs_gate");
  }

  return Array.from(aliases);
}

export async function storeMemoryWithIndex(key: string, payload: any): Promise<void> {
  await writeMemory(key, payload);

  const topicAliases = normalizeAliases(payload.topic || key);
  for (const alias of topicAliases) {
    const indexKey = `alias_index/${alias}`;
    await indexMemory(indexKey, key); // links alias → true path
  }
}

export { normalizeAliases };