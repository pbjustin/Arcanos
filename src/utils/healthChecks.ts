/**
 * Shared health and readiness evaluation helpers.
 * Provides reusable, side-effect-free checks for core service readiness.
 */

export type DatabaseStatusLike = {
  connected: boolean;
  error?: string | null;
};

export type OpenAIHealthLike = {
  circuitBreaker: {
    healthy: boolean;
  };
};

export type CoreServiceReadiness = {
  isDatabaseReady: boolean;
  isOpenAIReady: boolean;
  isReady: boolean;
};

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Determine database readiness based on connectivity and configuration.
 * Inputs: database status and optional database URL override.
 * Outputs: boolean indicating if the database is ready.
 * Edge cases: Treats missing DATABASE_URL as "ready" to allow stateless deployments.
 */
export function resolveDatabaseReadiness(
  dbStatus: DatabaseStatusLike,
  databaseUrl: string | undefined
): boolean {
  const hasDatabaseUrl = Boolean(databaseUrl);
  //audit Assumption: missing database URL implies DB is optional; risk: false positive readiness; invariant: readiness remains true when DB not configured; handling: mark ready when DB is not required.
  return dbStatus.connected || !hasDatabaseUrl;
}

/**
 * Evaluate core service readiness for database and OpenAI dependencies.
 * Inputs: database status, OpenAI health, and optional database URL override.
 * Outputs: readiness flags for database, OpenAI, and overall readiness.
 * Edge cases: Missing database URL still returns ready if OpenAI is healthy.
 */
export function assessCoreServiceReadiness(
  dbStatus: DatabaseStatusLike,
  openaiHealth: OpenAIHealthLike,
  databaseUrl: string | undefined
): CoreServiceReadiness {
  const isDatabaseReady = resolveDatabaseReadiness(dbStatus, databaseUrl);
  const isOpenAIReady = openaiHealth.circuitBreaker.healthy;
  //audit Assumption: OpenAI circuit breaker health reflects current availability; risk: stale health; invariant: readiness requires healthy circuit; handling: use circuit breaker state.
  const isReady = isDatabaseReady && isOpenAIReady;

  //audit Assumption: readiness is a pure derivation of the inputs; risk: incorrect mapping; invariant: output mirrors input states; handling: return explicit readiness flags.
  return {
    isDatabaseReady,
    isOpenAIReady,
    isReady
  };
}

/**
 * Map readiness flags to a health status label.
 * Inputs: readiness flags for core services.
 * Outputs: a HealthStatus string for service health responses.
 * Edge cases: Non-ready states are labeled "degraded" unless an explicit error path sets "unhealthy".
 */
export function mapReadinessToHealthStatus(readiness: CoreServiceReadiness): HealthStatus {
  //audit Assumption: readiness false should downgrade to degraded; risk: overstating severity; invariant: only error paths mark unhealthy; handling: map readiness to healthy/degraded.
  return readiness.isReady ? 'healthy' : 'degraded';
}
