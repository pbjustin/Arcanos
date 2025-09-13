/**
 * ARCANOS System Diagnostics
 * 
 * Provides comprehensive system status in YAML format
 */

import { getStatus, query } from '../db.js';

interface WorkerDiagnostics {
  count: number;
  healthy: boolean;
  reason?: string;
  details?: any[];
  expected?: number;
  error?: string;
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

interface SystemDiagnostics {
  workers: WorkerDiagnostics;
  scheduler: SchedulerDiagnostics;
  routes: RouteStatus[];
  error_rate: number;
  timestamp: string;
  database: {
    connected: boolean;
    error?: string | null;
  };
  job_data_entry?: any;
  system_error?: string;
}

/**
 * Get worker count and health status
 */
async function getWorkerDiagnostics(): Promise<WorkerDiagnostics> {
  const dbStatus = getStatus();
  
  if (!dbStatus.connected) {
    return {
      count: 0,
      healthy: false,
      reason: 'Database not connected - cannot check worker status'
    };
  }

  try {
    // Get recent worker activity (last hour)
    const workerActivity = await query(
      `SELECT worker_id, COUNT(*) as activity_count, 
              MAX(created_at) as last_activity
       FROM execution_log 
       WHERE created_at > NOW() - INTERVAL '1 hour'
       GROUP BY worker_id`,
      []
    );

    const activeWorkers = workerActivity.rows.length;
    const expectedWorkers = 4; // init-workers spawns 4 workers
    
    return {
      count: activeWorkers,
      healthy: activeWorkers >= expectedWorkers,
      details: workerActivity.rows,
      expected: expectedWorkers
    };
  } catch (error) {
    return {
      count: 0,
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get scheduled jobs status
 */
async function getSchedulerDiagnostics(): Promise<SchedulerDiagnostics> {
  const dbStatus = getStatus();
  
  const jobs: Omit<ScheduledJob, 'status' | 'lastRun' | 'executions24h'>[] = [
    { name: 'nightly-audit', schedule: '0 2 * * *', route: 'audit.cron' },
    { name: 'hourly-cleanup', schedule: '0 * * * *', route: 'job.cleanup' },
    { name: 'async-processing', schedule: '*/5 * * * *', route: 'worker.queue' }
  ];

  if (!dbStatus.connected) {
    return {
      jobs: jobs.map(job => ({ ...job, status: 'unknown', reason: 'Database not connected' })) as ScheduledJob[]
    };
  }

  try {
    // Check for recent executions of scheduled jobs
    const jobExecutions = await query(
      `SELECT worker_id, COUNT(*) as executions, MAX(created_at) as last_run
       FROM execution_log 
       WHERE created_at > NOW() - INTERVAL '24 hours'
         AND worker_id IN ('audit-runner', 'cleanup-worker', 'task-processor')
       GROUP BY worker_id`,
      []
    );

    const executionMap: Record<string, { executions: number; lastRun: string }> = {};
    jobExecutions.rows.forEach((row: any) => {
      executionMap[row.worker_id] = {
        executions: row.executions,
        lastRun: row.last_run
      };
    });

    return {
      jobs: jobs.map(job => {
        const workerId = {
          'audit.cron': 'audit-runner',
          'job.cleanup': 'cleanup-worker',
          'worker.queue': 'task-processor'
        }[job.route];

        const execution = workerId ? executionMap[workerId] : undefined;
        
        return {
          ...job,
          status: execution ? 'active' : 'inactive',
          lastRun: execution?.lastRun || null,
          executions24h: execution?.executions || 0
        };
      })
    };
  } catch (error) {
    return {
      jobs: jobs.map(job => ({ 
        ...job, 
        status: 'error', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      })) as ScheduledJob[]
    };
  }
}

/**
 * Get route health status
 */
async function getRouteDiagnostics(): Promise<RouteStatus[]> {
  const routes: Omit<RouteStatus, 'active' | 'requests1h'>[] = [
    { name: 'worker.queue' },
    { name: 'audit.cron' },
    { name: 'job.cleanup' }
  ];

  const dbStatus = getStatus();
  
  if (!dbStatus.connected) {
    return routes.map(route => ({ ...route, active: false, reason: 'Database not connected' }));
  }

  try {
    // Check recent activity for each route
    const routeActivity = await query(
      `SELECT worker_id, COUNT(*) as requests
       FROM execution_log 
       WHERE created_at > NOW() - INTERVAL '1 hour'
         AND worker_id IN ('audit-runner', 'cleanup-worker', 'task-processor')
       GROUP BY worker_id`,
      []
    );

    const activityMap: Record<string, number> = {};
    routeActivity.rows.forEach((row: any) => {
      activityMap[row.worker_id] = row.requests;
    });

    return routes.map(route => {
      const workerId = {
        'worker.queue': 'task-processor',
        'audit.cron': 'audit-runner',
        'job.cleanup': 'cleanup-worker'
      }[route.name];

      return {
        name: route.name,
        active: workerId ? !!activityMap[workerId] : false,
        requests1h: workerId ? (activityMap[workerId] || 0) : 0
      };
    });
  } catch (error) {
    return routes.map(route => ({ 
      ...route, 
      active: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }));
  }
}

/**
 * Calculate error rate over last 60 minutes
 */
async function getErrorRate(): Promise<number> {
  const dbStatus = getStatus();
  
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

    const row = errorStats.rows[0];
    const errorCount = parseInt(row.error_count) || 0;
    const totalCount = parseInt(row.total_count) || 0;

    if (totalCount === 0) {
      return 0.0;
    }

    return parseFloat((errorCount / totalCount).toFixed(4));
  } catch (error) {
    console.error('Error calculating error rate:', error);
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
    let latestJob = null;
    try {
      const { getLatestJob } = await import('../db.js');
      latestJob = await getLatestJob();
    } catch {
      // Database not connected or function not available
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
    if (latestJob) {
      diagnostics.job_data_entry = latestJob;
    }

    return diagnostics;
  } catch (error) {
    return {
      workers: { count: 0, healthy: false, error: error instanceof Error ? error.message : 'Unknown error' },
      scheduler: { jobs: [] },
      routes: [],
      error_rate: 1.0,
      timestamp: new Date().toISOString(),
      database: {
        connected: getStatus().connected,
        error: getStatus().error
      },
      system_error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
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
    if (job.lastRun) {
      yamlLines.push(`      last_run: "${job.lastRun}"`);
    }
  });
  
  // Routes section
  yamlLines.push('routes:');
  diagnostics.routes.forEach((route: RouteStatus) => {
    yamlLines.push(`  - name: "${route.name}"`);
    yamlLines.push(`    active: ${route.active}`);
    if (route.requests1h !== undefined) {
      yamlLines.push(`    requests_1h: ${route.requests1h}`);
    }
  });
  
  // Job data entry
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