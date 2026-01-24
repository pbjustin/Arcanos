/**
 * ARCANOS System Diagnostics
 * 
 * Provides comprehensive system status in YAML format
 */

import { getStatus, query } from '../db.js';
import { getWorkerRuntimeStatus, type WorkerRuntimeStatus } from '../config/workerConfig.js';
import {
  DIAGNOSTIC_JOBS,
  DIAGNOSTIC_QUERIES,
  DIAGNOSTIC_WORKER_MAPPING
} from '../config/systemDiagnosticsConfig.js';

interface WorkerDiagnostics {
  count: number;
  healthy: boolean;
  reason?: string;
  details?: Array<Record<string, unknown>>;
  expected?: number;
  error?: string;
  runtime?: WorkerRuntimeStatus;
}

interface ScheduledJob {
  name: string;
  schedule: string;
  route: string;
  status: string;
  lastRun?: string | null;
  executions24h?: number;
  error?: string;
}

interface SchedulerDiagnostics {
  jobs: ScheduledJob[];
}

interface RouteStatus {
  name: string;
  active: boolean;
  requests1h?: number;
  error?: string;
  reason?: string;
}

export interface SystemDiagnostics {
  workers: WorkerDiagnostics;
  scheduler: SchedulerDiagnostics;
  routes: RouteStatus[];
  error_rate: number;
  timestamp: string;
  database: {
    connected: boolean;
    error?: string | null;
  };
  job_data_entry?: JobDataEntry;
  system_error?: string;
}

interface JobDataEntry {
  id?: string;
  worker_id?: string;
  job_type?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  created_at?: string;
  completed_at?: string;
}

interface JobExecutionRow {
  worker_id: string;
  executions: number;
  last_run: string;
}

interface RouteActivityRow {
  worker_id: string;
  requests: number;
}

interface ErrorStatsRow {
  error_count: string | number;
  total_count: string | number;
}

type DiagnosticJob = (typeof DIAGNOSTIC_JOBS)[number];
type DiagnosticRoute = keyof typeof DIAGNOSTIC_WORKER_MAPPING;

function getWorkerIdForRoute(route: DiagnosticRoute): string | undefined {
  return DIAGNOSTIC_WORKER_MAPPING[route];
}

/**
 * Get worker count and health status
 */
async function getWorkerDiagnostics(): Promise<WorkerDiagnostics> {
  const dbStatus = getStatus();
  
  //audit Assumption: without DB, worker diagnostics are unavailable
  if (!dbStatus.connected) {
    return {
      count: 0,
      healthy: false,
      reason: 'Database not connected - cannot check worker status',
      runtime: getWorkerRuntimeStatus()
    };
  }

  try {
    // Get recent worker activity (last hour)
    const workerActivity = await query(DIAGNOSTIC_QUERIES.WORKER_ACTIVITY_LAST_HOUR, []);

    const activeWorkers = workerActivity.rows.length;
    const expectedWorkers = 4; // init-workers spawns 4 workers
    
    //audit Assumption: activeWorkers >= expected implies healthy
    return {
      count: activeWorkers,
      healthy: activeWorkers >= expectedWorkers,
      details: workerActivity.rows,
      expected: expectedWorkers,
      runtime: getWorkerRuntimeStatus()
    };
  } catch (error: unknown) {
    //audit Assumption: query failures should be surfaced in diagnostics
    return {
      count: 0,
      healthy: false,
      error: getErrorMessage(error),
      runtime: getWorkerRuntimeStatus()
    };
  }
}

/**
 * Get scheduled jobs status
 */
async function getSchedulerDiagnostics(): Promise<SchedulerDiagnostics> {
  const dbStatus = getStatus();
  const jobs: DiagnosticJob[] = [...DIAGNOSTIC_JOBS];

  //audit Assumption: DB disconnect makes scheduler status unknown
  if (!dbStatus.connected) {
    return {
      jobs: jobs.map(job => ({ ...job, status: 'unknown', reason: 'Database not connected' })) as ScheduledJob[]
    };
  }

  try {
    // Check for recent executions of scheduled jobs
    const jobExecutions = await query(DIAGNOSTIC_QUERIES.JOB_EXECUTIONS_LAST_DAY, []);

    const executionMap: Record<string, { executions: number; lastRun: string }> = {};
    (jobExecutions.rows as JobExecutionRow[]).forEach(row => {
      //audit Assumption: worker_id maps to route; Handling: aggregate counts
      executionMap[row.worker_id] = {
        executions: row.executions,
        lastRun: row.last_run
      };
    });

    return {
      jobs: jobs.map(job => {
        const workerId = getWorkerIdForRoute(job.route as DiagnosticRoute);
        const execution = workerId ? executionMap[workerId] : undefined;
        
        return {
          ...job,
          status: execution ? 'active' : 'inactive',
          lastRun: execution?.lastRun || null,
          executions24h: execution?.executions || 0
        };
      })
    };
  } catch (error: unknown) {
    //audit Assumption: query failures should set error status on jobs
    return {
      jobs: jobs.map(job => ({ 
        ...job, 
        status: 'error', 
        error: getErrorMessage(error)
      })) as ScheduledJob[]
    };
  }
}

/**
 * Get route health status
 */
async function getRouteDiagnostics(): Promise<RouteStatus[]> {
  const routes: Omit<RouteStatus, 'active' | 'requests1h'>[] = Object.keys(DIAGNOSTIC_WORKER_MAPPING).map(
    route => ({ name: route })
  );

  const dbStatus = getStatus();
  
  //audit Assumption: DB disconnect means routes considered inactive
  if (!dbStatus.connected) {
    return routes.map(route => ({ ...route, active: false, reason: 'Database not connected' }));
  }

  try {
    // Check recent activity for each route
    const routeActivity = await query(DIAGNOSTIC_QUERIES.ROUTE_ACTIVITY_LAST_HOUR, []);

    const activityMap: Record<string, number> = {};
    (routeActivity.rows as RouteActivityRow[]).forEach(row => {
      //audit Assumption: requests count maps to worker_id; Handling: aggregate
      activityMap[row.worker_id] = row.requests;
    });

    return routes.map(route => {
      const workerId = getWorkerIdForRoute(route.name as DiagnosticRoute);

      return {
        name: route.name,
        active: workerId ? !!activityMap[workerId] : false,
        requests1h: workerId ? activityMap[workerId] || 0 : 0
      };
    });
  } catch (error: unknown) {
    //audit Assumption: query failures mark routes inactive with error reason
    return routes.map(route => ({ 
      ...route, 
      active: false, 
      error: getErrorMessage(error)
    }));
  }
}

/**
 * Calculate error rate over last 60 minutes
 */
async function getErrorRate(): Promise<number> {
  const dbStatus = getStatus();
  
  //audit Assumption: error rate is 0 when DB disconnected
  if (!dbStatus.connected) {
    return 0.0;
  }

  try {
    const errorStats = await query(
      `SELECT 
         COUNT(*) FILTER (WHERE level = 'error') as error_count,
         COUNT(*) as total_count
       FROM execution_log 
       WHERE created_at > NOW() - INTERVAL '1 hour'`,
      []
    );

    const row = errorStats.rows[0] as ErrorStatsRow | undefined;
    const errorCount = toNumber(row?.error_count);
    const totalCount = toNumber(row?.total_count);

    //audit Assumption: zero total implies zero error rate; Handling: return 0
    if (totalCount === 0) {
      return 0.0;
    }

    return parseFloat((errorCount / totalCount).toFixed(4));
  } catch (error: unknown) {
    //audit Assumption: calculation failure implies degraded state; Handling: 1.0
    console.error('Error calculating error rate:', getErrorMessage(error));
    return 1.0; // Assume high error rate if we can't calculate
  }
}

/**
 * Generate comprehensive system diagnostics in YAML format
 */
export async function generateSystemDiagnostics(): Promise<SystemDiagnostics> {
  try {
    const [workers, scheduler, routes, errorRate] = await Promise.all([
      getWorkerDiagnostics(),
      getSchedulerDiagnostics(),
      getRouteDiagnostics(),
      getErrorRate()
    ]);

    // Get latest job record if database is connected
    let latestJob: JobDataEntry | null = null;
    try {
      const { getLatestJob } = await import('../db.js');
      const rawJob = await getLatestJob();
      if (rawJob) {
        latestJob = {
          ...rawJob,
          created_at: rawJob.created_at instanceof Date ? rawJob.created_at.toISOString() : rawJob.created_at,
          completed_at: rawJob.completed_at instanceof Date ? rawJob.completed_at.toISOString() : rawJob.completed_at
        };
      }
    } catch (error: unknown) {
      //audit Assumption: missing job data is non-fatal; Handling: ignore
      void error;
    }

    const diagnostics: SystemDiagnostics = {
      workers,
      scheduler,
      routes,
      error_rate: errorRate,
      timestamp: new Date().toISOString(),
      database: {
        connected: getStatus().connected,
        error: getStatus().error
      }
    };

    // Include latest job if available
    //audit Assumption: include job data only if available
    if (latestJob) {
      diagnostics.job_data_entry = latestJob;
    }

    return diagnostics;
  } catch (error: unknown) {
    //audit Assumption: diagnostics failure should return minimal snapshot
    return {
      workers: { count: 0, healthy: false, error: getErrorMessage(error) },
      scheduler: { jobs: [] },
      routes: [],
      error_rate: 1.0,
      timestamp: new Date().toISOString(),
      database: {
        connected: getStatus().connected,
        error: getStatus().error
      },
      system_error: getErrorMessage(error)
    };
  }
}

function toNumber(value: string | number | undefined): number {
  //audit Assumption: numeric strings parse with base 10; Handling: parse + fallback
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

/**
 * Convert diagnostics to YAML string format
 */
export function formatDiagnosticsAsYAML(diagnostics: SystemDiagnostics): string {
  const yamlLines: string[] = [];
  
  // Workers section
  yamlLines.push('workers:');
  yamlLines.push(`  count: ${diagnostics.workers.count}`);
  yamlLines.push(`  healthy: ${diagnostics.workers.healthy}`);
  //audit Assumption: include worker error when present
  if (diagnostics.workers.error) {
    yamlLines.push(`  error: "${diagnostics.workers.error}"`);
  }
  
  // Scheduler section
  yamlLines.push('scheduler:');
  yamlLines.push('  jobs:');
  diagnostics.scheduler.jobs.forEach((job: ScheduledJob) => {
    yamlLines.push(`    - name: "${job.name}"`);
    yamlLines.push(`      schedule: "${job.schedule}"`);
    yamlLines.push(`      route: "${job.route}"`);
    yamlLines.push(`      status: "${job.status}"`);
    //audit Assumption: lastRun is optional; Handling: include when present
    if (job.lastRun) {
      yamlLines.push(`      last_run: "${job.lastRun}"`);
    }
  });
  
  // Routes section
  yamlLines.push('routes:');
  diagnostics.routes.forEach((route: RouteStatus) => {
    yamlLines.push(`  - name: "${route.name}"`);
    yamlLines.push(`    active: ${route.active}`);
    //audit Assumption: requests1h may be absent; Handling: include when present
    if (route.requests1h !== undefined) {
      yamlLines.push(`    requests_1h: ${route.requests1h}`);
    }
  });
  
  // Job data entry
  //audit Assumption: job data entry is optional; Handling: include when present
  if (diagnostics.job_data_entry) {
    yamlLines.push('job_data_entry:');
    yamlLines.push(`  id: "${diagnostics.job_data_entry.id || 'unknown'}"`);
    yamlLines.push(`  worker_id: "${diagnostics.job_data_entry.worker_id || 'unknown'}"`);
    yamlLines.push(`  job_type: "${diagnostics.job_data_entry.job_type || 'unknown'}"`);
    yamlLines.push(`  status: "${diagnostics.job_data_entry.status || 'unknown'}"`);
    if (diagnostics.job_data_entry.input) {
      const input = typeof diagnostics.job_data_entry.input === 'string' 
        ? diagnostics.job_data_entry.input 
        : JSON.stringify(diagnostics.job_data_entry.input);
      yamlLines.push(`  input: "${input}"`);
    }
    if (diagnostics.job_data_entry.output) {
      const output = typeof diagnostics.job_data_entry.output === 'string' 
        ? diagnostics.job_data_entry.output 
        : JSON.stringify(diagnostics.job_data_entry.output);
      yamlLines.push(`  output: "${output}"`);
    }
    if (diagnostics.job_data_entry.created_at) {
      yamlLines.push(`  created_at: "${diagnostics.job_data_entry.created_at}"`);
    }
    if (diagnostics.job_data_entry.completed_at) {
      yamlLines.push(`  completed_at: "${diagnostics.job_data_entry.completed_at}"`);
    }
  }
  
  // Error rate
  yamlLines.push(`error_rate: ${diagnostics.error_rate}`);
  
  // Metadata
  yamlLines.push(`timestamp: "${diagnostics.timestamp}"`);
  yamlLines.push('database:');
  yamlLines.push(`  connected: ${diagnostics.database.connected}`);
  //audit Assumption: include database error when present
  if (diagnostics.database.error) {
    yamlLines.push(`  error: "${diagnostics.database.error}"`);
  }
  
  return yamlLines.join('\n');
}

/**
 * Main diagnostic function that returns YAML formatted results
 */
export async function runSystemDiagnostics() {
  const diagnostics = await generateSystemDiagnostics();
  const yaml = formatDiagnosticsAsYAML(diagnostics);
  
  //audit Assumption: always return success true; Handling: errors folded in diagnostics
  return {
    diagnostics,
    yaml,
    success: true
  };
}

export default {
  generateSystemDiagnostics,
  formatDiagnosticsAsYAML,
  runSystemDiagnostics
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return 'Unknown error';
}