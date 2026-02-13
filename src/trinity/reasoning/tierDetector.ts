export type Tier = "simple" | "complex" | "critical";

const COMPLEX_LEN = 300;
const CRITICAL_LEN = 500;

export function detectTier(prompt: string): Tier {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ");

  const forbidden = [
    "set tier to",
    "override reasoning",
    "treat as critical"
  ];

  if (forbidden.some(f => normalized.includes(f))) {
    return "simple";
  }

  const keywords = ["audit", "architecture", "failure mode", "threat"];
  const hitCount = keywords.filter(k =>
    normalized.includes(k)
  ).length;

  if (normalized.length >= CRITICAL_LEN && hitCount >= 2)
    return "critical";

  if (normalized.length >= COMPLEX_LEN || hitCount >= 1)
    return "complex";

  return "simple";
}
