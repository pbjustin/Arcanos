// Patch: Resilient Reflection Memory Handling
// Ensures safe memory serialization, fallback recovery, and OpenAI-compatible logic

import { storeMemory, getMemory } from "./memory";

// 🔐 Safe serializer to prevent malformed writes
function safeSerialize(obj: any): string {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return JSON.stringify({ error: "circular_reference_or_invalid_data", fallback: String(obj) });
  }
}

// 🧠 Write with fallback shadow path
export async function storeReflection(path: string, payload: any): Promise<void> {
  const serialized = safeSerialize(payload);
  await storeMemory(path, serialized);
  await storeMemory(path.replace("/recent/", "/fallback/"), serialized); // shadow entry
}

// 🔄 Read with fallback logic
export async function getReflection(path: string): Promise<any> {
  let result = await getMemory(path);
  try {
    return JSON.parse(result);
  } catch (e) {
    // fallback to shadow if main is broken
    const fallback = await getMemory(path.replace("/recent/", "/fallback/"));
    try {
      return JSON.parse(fallback);
    } catch (e2) {
      return { error: "Failed to recover reflection from both primary and fallback paths." };
    }
  }
}