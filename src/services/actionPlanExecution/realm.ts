const REALM_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXECUTION_REALM_MAX_CHARACTERS = 256;

function boundedRealmPart(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return null;
  }
  return value.length <= 128 && REALM_PART_PATTERN.test(value) ? value : null;
}

/** Derive a realm only from trusted deployment configuration. Request data is never accepted. */
export function deriveActionPlanExecutionRealm(env: NodeJS.ProcessEnv = process.env): string | null {
  const projectId = boundedRealmPart(env.RAILWAY_PROJECT_ID);
  const environmentId = boundedRealmPart(env.RAILWAY_ENVIRONMENT_ID);
  if (projectId && environmentId) {
    const realm = `railway:${projectId}:${environmentId}`;
    return realm.length <= EXECUTION_REALM_MAX_CHARACTERS ? realm : null;
  }

  const hasRailwayMarker = Object.keys(env).some(key => key.startsWith('RAILWAY_') && Boolean(env[key]));
  if (hasRailwayMarker || projectId || environmentId) {
    return null;
  }

  const configuredLocalRealm = env.ACTION_PLAN_EXECUTION_LOCAL_REALM;
  if (configuredLocalRealm !== 'local-test' && configuredLocalRealm !== 'local-development') {
    return null;
  }
  if (configuredLocalRealm === 'local-test' && env.NODE_ENV !== 'test') {
    return null;
  }
  if (configuredLocalRealm === 'local-development' && env.NODE_ENV === 'production') {
    return null;
  }
  return configuredLocalRealm;
}
