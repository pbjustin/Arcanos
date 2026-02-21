export function recordMetric(
  name: string,
  value: number,
  tags?: Record<string, string>
) {
  console.log("[METRIC]", {
    name,
    value,
    tags,
    timestamp: Date.now(),
  });
}
