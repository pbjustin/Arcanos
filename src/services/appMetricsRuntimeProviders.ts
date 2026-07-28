import {
  configureAppMetricsRuntimeProviders,
  type AppMetricsAiProviderSnapshot,
  type AppMetricsWorkerHealthSnapshot
} from '@platform/observability/appMetrics.js';

async function getWorkerHealth(): Promise<AppMetricsWorkerHealthSnapshot> {
  const { getWorkerControlHealth } = await import('./workerControlService.js');
  return getWorkerControlHealth();
}

async function getAiProviderSnapshot(): Promise<AppMetricsAiProviderSnapshot> {
  const { getOpenAIServiceHealth } = await import('./openai/serviceHealth.js');
  const health = getOpenAIServiceHealth();
  return {
    state: health.circuitBreaker?.state ?? null,
    failureCount: health.circuitBreaker?.failureCount ?? 0
  };
}

/**
 * Binds operational data providers at the application composition root so the
 * metrics registry remains a dependency leaf.
 */
export function configureDefaultAppMetricsRuntimeProviders(): void {
  configureAppMetricsRuntimeProviders({
    getWorkerHealth,
    getAiProviderSnapshot
  });
}
