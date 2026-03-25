import type { Application } from 'express';
import { createClient } from 'redis';
import { getEnv, getEnvNumber } from '@platform/runtime/env.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getGptModuleMap } from '@platform/runtime/gptRouterConfig.js';
import { loadModuleDefinitions, type LoadedModule } from './moduleLoader.js';
import { getActiveRouteTable } from './runtimeRouteTableService.js';
import { resolveConfiguredRedisConnection } from '@platform/runtime/redis.js';

type ModuleStatus =
  | 'active'
  | 'registered'
  | 'unavailable'
  | `DATA NOT EXPOSED: ${string}`;

interface MemorySnapshot {
  rss_mb: number;
  heap_total_mb: number;
  heap_used_mb: number;
  external_mb: number;
  array_buffers_mb: number;
}

export interface HealthSnapshot {
  status: 'ok';
  timestamp: string;
  uptime: number;
  memory: MemorySnapshot;
}

export interface DiagnosticsSnapshot {
  uptime: number;
  memory: MemorySnapshot;
  active_routes: string[] | `DATA NOT EXPOSED: ${string}`;
  registered_gpts: string[] | `DATA NOT EXPOSED: ${string}`;
  requests_total: number;
  errors_total: number;
  error_rate: number | `DATA NOT EXPOSED: ${string}`;
  avg_latency_ms: number | `DATA NOT EXPOSED: ${string}`;
  recent_latency_ms: number[] | `DATA NOT EXPOSED: ${string}`;
  modules: Record<string, ModuleStatus>;
}

export interface RequestSample {
  timestamp: string;
  route: string;
  statusCode: number;
  latencyMs: number;
  timedOut: boolean;
}

export interface RequestWindowRouteSnapshot {
  route: string;
  requestCount: number;
  errorCount: number;
  timeoutCount: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface RequestWindowSnapshot {
  generatedAt: string;
  windowMs: number;
  requestCount: number;
  errorCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  errorRate: number;
  timeoutCount: number;
  timeoutRate: number;
  slowRequestCount: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  routes: RequestWindowRouteSnapshot[];
}

interface RegistrySnapshot {
  registeredGpts: string[] | `DATA NOT EXPOSED: ${string}`;
  loadedModules: LoadedModule[] | null;
}

interface MetricsSnapshot {
  requestsTotal: number;
  errorsTotal: number;
  avgLatencyMs: number | `DATA NOT EXPOSED: ${string}`;
  errorRate: number | `DATA NOT EXPOSED: ${string}`;
  recentLatencyMs: number[] | `DATA NOT EXPOSED: ${string}`;
}

type RuntimeDiagnosticsRedisClient = ReturnType<typeof createClient>;

const RECENT_LATENCY_LIMIT = Math.max(10, getEnvNumber('DIAGNOSTICS_RECENT_LATENCY_LIMIT', 50));
const RECENT_REQUEST_LIMIT = Math.max(25, getEnvNumber('DIAGNOSTICS_RECENT_REQUEST_LIMIT', 250));
const TIMEOUT_LATENCY_MS = Math.max(2_500, getEnvNumber('DIAGNOSTICS_TIMEOUT_LATENCY_MS', 5_000));
const SLOW_REQUEST_LATENCY_MS = Math.max(1_000, getEnvNumber('DIAGNOSTICS_SLOW_REQUEST_LATENCY_MS', 2_500));
const REDIS_SHARED_METRICS_ENABLED = getEnv('DIAGNOSTICS_SHARED_METRICS', 'true') !== 'false';

const MODULE_PROBES: Record<string, { moduleNames?: string[]; routes?: string[] }> = {
  CORE: {
    moduleNames: ['ARCANOS:CORE'],
    routes: ['core']
  },
  WRITE: {
    moduleNames: ['ARCANOS:WRITE'],
    routes: ['write']
  },
  BUILD: {
    moduleNames: ['ARCANOS:BUILD'],
    routes: ['build']
  },
  RESEARCH: {
    moduleNames: ['ARCANOS:RESEARCH'],
    routes: ['research']
  },
  AUDIT: {
    moduleNames: ['ARCANOS:AUDIT'],
    routes: ['audit']
  },
  SIM: {
    moduleNames: ['ARCANOS:SIM'],
    routes: ['sim']
  },
  BOOKING: {
    moduleNames: ['BACKSTAGE:BOOKER'],
    routes: ['backstage-booker']
  },
  GUIDE: {
    moduleNames: ['ARCANOS:GUIDE'],
    routes: ['guide']
  },
  TRACKER: {
    moduleNames: ['ARCANOS:TRACKER'],
    routes: ['tracker']
  }
};

class RuntimeDiagnosticsService {
  private requestsTotal = 0;
  private errorsTotal = 0;
  private totalLatencyMs = 0;
  private recentLatencyMs: number[] = [];
  private recentRequests: RequestSample[] = [];
  private readonly redisStore = new RuntimeDiagnosticsRedisStore();
  private activeRouteTableCache: string[] | null = null;

  recordRequestCompletion(statusCode: number, latencyMs: number, route = 'unmatched'): void {
    this.requestsTotal += 1;
    this.totalLatencyMs += latencyMs;

    if (statusCode >= 400) {
      this.errorsTotal += 1;
    }

    this.recentLatencyMs.push(latencyMs);
    if (this.recentLatencyMs.length > RECENT_LATENCY_LIMIT) {
      this.recentLatencyMs.splice(0, this.recentLatencyMs.length - RECENT_LATENCY_LIMIT);
    }

    this.recentRequests.push(buildRequestSample(route, statusCode, latencyMs));
    if (this.recentRequests.length > RECENT_REQUEST_LIMIT) {
      this.recentRequests.splice(0, this.recentRequests.length - RECENT_REQUEST_LIMIT);
    }

    void this.redisStore.recordRequestCompletion(statusCode, latencyMs);
  }

  getRollingRequestWindow(windowMs: number): RequestWindowSnapshot {
    const nowMs = Date.now();
    const normalizedWindowMs = Math.max(5_000, Math.trunc(windowMs));
    const cutoffMs = nowMs - normalizedWindowMs;
    const samples = this.recentRequests.filter((sample) => Date.parse(sample.timestamp) >= cutoffMs);

    return aggregateRequestSamples(samples, normalizedWindowMs);
  }

  getRequestWindowSince(
    since: string | number | Date,
    windowMs: number,
    route?: string
  ): RequestWindowSnapshot {
    const nowMs = Date.now();
    const normalizedWindowMs = Math.max(5_000, Math.trunc(windowMs));
    const sinceMs = normalizeTimestampInput(since);
    const cutoffMs = Math.max(nowMs - normalizedWindowMs, sinceMs);
    const normalizedRoute = typeof route === 'string' && route.trim().length > 0 ? route.trim() : null;
    const samples = this.recentRequests.filter((sample) => {
      if (Date.parse(sample.timestamp) < cutoffMs) {
        return false;
      }

      return normalizedRoute === null || sample.route === normalizedRoute;
    });

    return aggregateRequestSamples(samples, normalizedWindowMs);
  }

  reset(): void {
    this.requestsTotal = 0;
    this.errorsTotal = 0;
    this.totalLatencyMs = 0;
    this.recentLatencyMs = [];
    this.recentRequests = [];
    this.activeRouteTableCache = null;
    void this.redisStore.reset();
  }

  getHealthSnapshot(): HealthSnapshot {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: roundMetric(process.uptime()),
      memory: getMemorySnapshot()
    };
  }

  async getDiagnosticsSnapshot(app: Application): Promise<DiagnosticsSnapshot> {
    const metricsSnapshot = await this.getMetricsSnapshot();
    const activeRoutes = this.getActiveRoutes(app);
    const registry = await this.getRegistrySnapshot();

    return {
      uptime: roundMetric(process.uptime()),
      memory: getMemorySnapshot(),
      active_routes: activeRoutes,
      registered_gpts: registry.registeredGpts,
      requests_total: metricsSnapshot.requestsTotal,
      errors_total: metricsSnapshot.errorsTotal,
      error_rate: metricsSnapshot.errorRate,
      avg_latency_ms: metricsSnapshot.avgLatencyMs,
      recent_latency_ms: metricsSnapshot.recentLatencyMs,
      modules: this.resolveModuleStatuses(registry.loadedModules)
    };
  }

  async logStartupSummary(app: Application): Promise<void> {
    try {
      this.primeRouteTableCache(app);
      const diagnostics = await this.getDiagnosticsSnapshot(app);
      logger.info('runtime.registration.summary', {
        module: 'runtime-diagnostics',
        routeCount: Array.isArray(diagnostics.active_routes) ? diagnostics.active_routes.length : diagnostics.active_routes,
        registeredGptCount: Array.isArray(diagnostics.registered_gpts) ? diagnostics.registered_gpts.length : diagnostics.registered_gpts,
        modules: diagnostics.modules
      });
    } catch (error) {
      logger.warn('runtime.registration.summary.unavailable', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
    }
  }

  private getActiveRoutes(app: Application): string[] | `DATA NOT EXPOSED: ${string}` {
    if (Array.isArray(this.activeRouteTableCache) && this.activeRouteTableCache.length > 0) {
      return [...this.activeRouteTableCache];
    }

    try {
      const routes = getActiveRouteTable(app);
      if (routes.length > 0) {
        this.activeRouteTableCache = [...routes];
        return routes;
      }
      return 'DATA NOT EXPOSED: active_routes';
    } catch (error) {
      logger.warn('diagnostics.routes.unavailable', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
      return this.activeRouteTableCache && this.activeRouteTableCache.length > 0
        ? [...this.activeRouteTableCache]
        : 'DATA NOT EXPOSED: active_routes';
    }
  }

  private async getRegistrySnapshot(): Promise<RegistrySnapshot> {
    try {
      const [gptMap, loadedModules] = await Promise.all([
        getGptModuleMap(),
        loadModuleDefinitions()
      ]);

      return {
        registeredGpts: Object.keys(gptMap).sort((left, right) => left.localeCompare(right)),
        loadedModules
      };
    } catch (error) {
      logger.warn('diagnostics.gpt_registry.unavailable', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });

      return {
        registeredGpts: 'DATA NOT EXPOSED: registered_gpts',
        loadedModules: null
      };
    }
  }

  private resolveModuleStatuses(loadedModules: LoadedModule[] | null): Record<string, ModuleStatus> {
    const moduleStatuses: Record<string, ModuleStatus> = {};

    for (const [moduleKey, probe] of Object.entries(MODULE_PROBES)) {
      if (!loadedModules) {
        moduleStatuses[moduleKey] = `DATA NOT EXPOSED: ${moduleKey}`;
        continue;
      }

      const activeMatch = loadedModules.find((loadedModule) => {
        const moduleName = loadedModule.definition.name;
        const route = loadedModule.route;
        return Boolean(
          probe.moduleNames?.includes(moduleName) ||
          probe.routes?.includes(route)
        );
      });

      if (activeMatch) {
        moduleStatuses[moduleKey] = 'active';
        continue;
      }

      const probeHasDirectRuntimeMapping = Boolean(probe.moduleNames?.length || probe.routes?.length);
      moduleStatuses[moduleKey] = probeHasDirectRuntimeMapping
        ? 'unavailable'
        : `DATA NOT EXPOSED: ${moduleKey}`;
    }

    return moduleStatuses;
  }

  private async getMetricsSnapshot(): Promise<MetricsSnapshot> {
    const sharedSnapshot = await this.redisStore.getSnapshot();
    if (sharedSnapshot) {
      return sharedSnapshot;
    }

    return {
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      avgLatencyMs: this.requestsTotal > 0
        ? roundMetric(this.totalLatencyMs / this.requestsTotal)
        : 'DATA NOT EXPOSED: avg_latency_ms',
      errorRate: this.requestsTotal > 0
        ? roundMetric(this.errorsTotal / this.requestsTotal)
        : 'DATA NOT EXPOSED: error_rate',
      recentLatencyMs: this.recentLatencyMs.length > 0
        ? [...this.recentLatencyMs]
        : 'DATA NOT EXPOSED: recent_latency_ms'
    };
  }

  private primeRouteTableCache(app: Application): void {
    if (this.activeRouteTableCache && this.activeRouteTableCache.length > 0) {
      return;
    }

    try {
      const routes = getActiveRouteTable(app);
      if (routes.length > 0) {
        this.activeRouteTableCache = [...routes];
      }
    } catch (error) {
      logger.warn('runtime.registration.routes.unavailable', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
    }
  }
}

class RuntimeDiagnosticsRedisStore {
  private clientPromise: Promise<RuntimeDiagnosticsRedisClient | null> | null = null;

  async recordRequestCompletion(statusCode: number, latencyMs: number): Promise<void> {
    const redisClient = await this.getClient();
    if (!redisClient) {
      return;
    }

    try {
      const redisCommandBatch = redisClient.multi();
      redisCommandBatch.incr(this.key('requests_total'));
      redisCommandBatch.incrByFloat(this.key('latency_total_ms'), latencyMs);
      if (statusCode >= 400) {
        redisCommandBatch.incr(this.key('errors_total'));
      }
      redisCommandBatch.lPush(this.key('recent_latency_ms'), String(latencyMs));
      redisCommandBatch.lTrim(this.key('recent_latency_ms'), 0, RECENT_LATENCY_LIMIT - 1);
      await redisCommandBatch.exec();
    } catch (error) {
      logger.warn('diagnostics.shared_metrics.write_failed', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
    }
  }

  async getSnapshot(): Promise<MetricsSnapshot | null> {
    const redisClient = await this.getClient();
    if (!redisClient) {
      return null;
    }

    try {
      const redisResults = await redisClient.multi()
        .get(this.key('requests_total'))
        .get(this.key('errors_total'))
        .get(this.key('latency_total_ms'))
        .lRange(this.key('recent_latency_ms'), 0, RECENT_LATENCY_LIMIT - 1)
        .exec();

      if (!Array.isArray(redisResults) || redisResults.length < 4) {
        return null;
      }

      const [requestsRaw, errorsRaw, latencyRaw, recentLatencyRaw] = redisResults as unknown as [
        string | null,
        string | null,
        string | null,
        string[] | null
      ];

      const requestsTotal = Number.parseInt(requestsRaw ?? '0', 10) || 0;
      const errorsTotal = Number.parseInt(errorsRaw ?? '0', 10) || 0;
      const totalLatencyMs = Number.parseFloat(latencyRaw ?? '0') || 0;
      const recentLatencyMs = Array.isArray(recentLatencyRaw)
        ? recentLatencyRaw.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value)).reverse()
        : [];

      return {
        requestsTotal,
        errorsTotal,
        avgLatencyMs: requestsTotal > 0
          ? roundMetric(totalLatencyMs / requestsTotal)
          : 'DATA NOT EXPOSED: avg_latency_ms',
        errorRate: requestsTotal > 0
          ? roundMetric(errorsTotal / requestsTotal)
          : 'DATA NOT EXPOSED: error_rate',
        recentLatencyMs: recentLatencyMs.length > 0
          ? recentLatencyMs
          : 'DATA NOT EXPOSED: recent_latency_ms'
      };
    } catch (error) {
      logger.warn('diagnostics.shared_metrics.read_failed', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
      return null;
    }
  }

  async reset(): Promise<void> {
    const redisClient = await this.getClient();
    if (!redisClient) {
      return;
    }

    try {
      await redisClient.del([
        this.key('requests_total'),
        this.key('errors_total'),
        this.key('latency_total_ms'),
        this.key('recent_latency_ms')
      ]);
    } catch (error) {
      logger.warn('diagnostics.shared_metrics.reset_failed', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
    }
  }

  private async getClient(): Promise<RuntimeDiagnosticsRedisClient | null> {
    if (!REDIS_SHARED_METRICS_ENABLED) {
      return null;
    }

    if (!this.clientPromise) {
      this.clientPromise = this.createClient();
    }

    return this.clientPromise;
  }

  private async createClient(): Promise<RuntimeDiagnosticsRedisClient | null> {
    const redisConnection = resolveConfiguredRedisConnection();
    if (!redisConnection.configured || !redisConnection.url) {
      return null;
    }

    try {
      const redisClient = createClient({ url: redisConnection.url });
      redisClient.on('error', (error) => {
        logger.warn('diagnostics.shared_metrics.redis_error', {
          module: 'runtime-diagnostics',
          error: resolveErrorMessage(error)
        });
      });
      await redisClient.connect();
      return redisClient;
    } catch (error) {
      logger.warn('diagnostics.shared_metrics.unavailable', {
        module: 'runtime-diagnostics',
        error: resolveErrorMessage(error)
      });
      return null;
    }
  }

  private key(suffix: string): string {
    const serviceName = sanitizeKeySegment(getEnv('RAILWAY_SERVICE_NAME') || 'local');
    const environmentName = sanitizeKeySegment(
      getEnv('RAILWAY_ENVIRONMENT') ||
      getEnv('NODE_ENV') ||
      'unknown'
    );
    return `arcanos:diagnostics:${serviceName}:${environmentName}:${suffix}`;
  }
}

function getMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();

  return {
    rss_mb: bytesToMegabytes(usage.rss),
    heap_total_mb: bytesToMegabytes(usage.heapTotal),
    heap_used_mb: bytesToMegabytes(usage.heapUsed),
    external_mb: bytesToMegabytes(usage.external),
    array_buffers_mb: bytesToMegabytes(usage.arrayBuffers)
  };
}

function bytesToMegabytes(value: number): number {
  return roundMetric(value / (1024 * 1024));
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

function sanitizeKeySegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-');
}

function buildRequestSample(route: string, statusCode: number, latencyMs: number): RequestSample {
  return {
    timestamp: new Date().toISOString(),
    route: route.trim().length > 0 ? route : 'unmatched',
    statusCode,
    latencyMs: roundMetric(latencyMs),
    timedOut: statusCode === 408 || statusCode === 504 || latencyMs >= TIMEOUT_LATENCY_MS
  };
}

function normalizeTimestampInput(value: string | number | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateRequestSamples(samples: RequestSample[], windowMs: number): RequestWindowSnapshot {
  const routeBuckets = new Map<string, RequestSample[]>();
  let errorCount = 0;
  let clientErrorCount = 0;
  let serverErrorCount = 0;
  let timeoutCount = 0;
  let slowRequestCount = 0;
  let totalLatencyMs = 0;
  let maxLatencyMs = 0;

  for (const sample of samples) {
    totalLatencyMs += sample.latencyMs;
    maxLatencyMs = Math.max(maxLatencyMs, sample.latencyMs);
    if (sample.statusCode >= 400) {
      errorCount += 1;
    }
    if (sample.statusCode >= 400 && sample.statusCode < 500) {
      clientErrorCount += 1;
    }
    if (sample.statusCode >= 500) {
      serverErrorCount += 1;
    }
    if (sample.timedOut) {
      timeoutCount += 1;
    }
    if (sample.latencyMs >= SLOW_REQUEST_LATENCY_MS) {
      slowRequestCount += 1;
    }

    const existing = routeBuckets.get(sample.route) ?? [];
    existing.push(sample);
    routeBuckets.set(sample.route, existing);
  }

  const requestCount = samples.length;
  const routes = [...routeBuckets.entries()]
    .map(([route, routeSamples]) => ({
      route,
      requestCount: routeSamples.length,
      errorCount: routeSamples.filter((sample) => sample.statusCode >= 400).length,
      timeoutCount: routeSamples.filter((sample) => sample.timedOut).length,
      avgLatencyMs: routeSamples.length > 0 ? roundMetric(average(routeSamples.map((sample) => sample.latencyMs))) : 0,
      p95LatencyMs: routeSamples.length > 0 ? roundMetric(percentile(routeSamples.map((sample) => sample.latencyMs), 95)) : 0
    }))
    .sort((left, right) => {
      if (right.errorCount !== left.errorCount) {
        return right.errorCount - left.errorCount;
      }
      if (right.timeoutCount !== left.timeoutCount) {
        return right.timeoutCount - left.timeoutCount;
      }
      return right.avgLatencyMs - left.avgLatencyMs;
    })
    .slice(0, 5);

  return {
    generatedAt: new Date().toISOString(),
    windowMs,
    requestCount,
    errorCount,
    clientErrorCount,
    serverErrorCount,
    errorRate: requestCount > 0 ? roundMetric(errorCount / requestCount) : 0,
    timeoutCount,
    timeoutRate: requestCount > 0 ? roundMetric(timeoutCount / requestCount) : 0,
    slowRequestCount,
    avgLatencyMs: requestCount > 0 ? roundMetric(totalLatencyMs / requestCount) : 0,
    p95LatencyMs: requestCount > 0 ? roundMetric(percentile(samples.map((sample) => sample.latencyMs), 95)) : 0,
    maxLatencyMs: roundMetric(maxLatencyMs),
    routes
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
}

export const runtimeDiagnosticsService = new RuntimeDiagnosticsService();

export function resetRuntimeDiagnosticsState(): void {
  runtimeDiagnosticsService.reset();
}
