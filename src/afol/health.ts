import { HealthSnapshot, ServiceHealth } from './types.js';

const baseState: HealthSnapshot = {
  redis: { ok: true, latency: 14 },
  postgres: { ok: true, latency: 28 },
  api: { ok: true, latency: 53 }
};

let healthState: HealthSnapshot = cloneState(baseState);

function cloneState(state: HealthSnapshot): HealthSnapshot {
  return JSON.parse(JSON.stringify(state));
}

export function getStatus(): HealthSnapshot {
  return cloneState(healthState);
}

export function simulateFailure(service: keyof HealthSnapshot): void {
  const current = healthState[service];
  if (current) {
    healthState = {
      ...healthState,
      [service]: { ...current, ok: false }
    };
  }
}

export function simulateRecovery(service: keyof HealthSnapshot): void {
  const current = healthState[service];
  if (current) {
    healthState = {
      ...healthState,
      [service]: { ...current, ok: true }
    };
  }
}

export function setServiceHealth(service: string, status: ServiceHealth): void {
  healthState = {
    ...healthState,
    [service]: { ...status }
  };
}

export function resetHealth(): void {
  healthState = cloneState(baseState);
}

export function setHealthSnapshot(snapshot: HealthSnapshot): void {
  healthState = cloneState(snapshot);
}

export const defaultHealthSnapshot: HealthSnapshot = cloneState(baseState);
