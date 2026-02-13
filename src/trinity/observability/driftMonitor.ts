let rollingLatency: number[] = [];

export function recordLatency(ms: number) {
  rollingLatency.push(ms);
  if (rollingLatency.length > 100)
    rollingLatency.shift();
}

export function detectLatencyDrift(): boolean {
  if (rollingLatency.length < 20) return false;

  const avg =
    rollingLatency.reduce((a, b) => a + b, 0) /
    rollingLatency.length;

  return avg > 20000;
}
