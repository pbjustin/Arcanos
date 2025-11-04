import { HealthSnapshot, PolicyEvaluation } from './types.js';

function isServiceHealthy(service?: { ok?: boolean }): boolean {
  return service?.ok === true;
}

export function evaluate(health: HealthSnapshot, intent: string = 'default'): PolicyEvaluation {
  const redisOk = isServiceHealthy(health.redis);
  const apiOk = isServiceHealthy(health.api);
  const primaryAvailable = redisOk && apiOk;
  const backupAvailable = isServiceHealthy(health.postgres);

  const rationale = primaryAvailable
    ? 'Primary path stable'
    : backupAvailable
      ? 'Switching to fallback route'
      : 'No healthy routes available';

  return {
    allow: true,
    primaryAvailable,
    backupAvailable,
    rationale
  };
}
