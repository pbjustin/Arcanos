import express from 'express';

import { runSystemDiagnostics } from '@platform/logging/systemDiagnostics.js';
import { logExecution } from '@core/db/index.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import { startWorkers } from '@platform/runtime/workerConfig.js';

import {
  buildSdkJobExecutionResult,
  buildSdkRouteStatuses,
  buildSdkSchedulerJobs,
  completeJobRecord,
  createOrMockJobRecord,
  dispatchSingleArcanosTask,
  SDK_TEST_JOB_DATA,
  sendSdkFailure,
  sendSdkJson,
} from './shared.js';

const router = express.Router();

/**
 * System test results structure
 * @confidence 1.0 - Well-defined test structure
 */
interface SystemTestResults {
  workers: unknown;
  routes: Array<{
    name: string;
    active: boolean;
    handler: string;
    metadata: Record<string, unknown>;
  }>;
  scheduler: {
    jobs: Array<{
      name: string;
      schedule: string;
      route: string;
    }>;
  };
  job?: {
    id: string;
    worker_id: string;
    job_type: string;
    job_data: Record<string, unknown>;
  };
  [key: string]: unknown;
}

/**
 * Get system diagnostics via SDK call
 */
router.get('/diagnostics', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const diagnosticsResult = await runSystemDiagnostics();

    if (format === 'yaml') {
      res.type('text/yaml');
      res.send(diagnosticsResult.yaml);
      return;
    }

    sendSdkJson(res, {
      success: true,
      diagnostics: diagnosticsResult.diagnostics,
      yaml: diagnosticsResult.yaml,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'Diagnostics failed via SDK', error);
  }
});

/**
 * Full ARCANOS SDK system test according to problem statement
 */
router.post('/system-test', confirmGate, async (_, res) => {
  try {
    const results: SystemTestResults = {
      workers: null,
      routes: [],
      scheduler: { jobs: [] },
    };

    const workerBootstrap = await startWorkers();
    results.workers = workerBootstrap;
    results.routes = buildSdkRouteStatuses('./workers/');
    results.scheduler = { jobs: buildSdkSchedulerJobs() };

    const testJobData = { ...SDK_TEST_JOB_DATA };
    let jobRecord = await createOrMockJobRecord('worker-1', 'test_job', testJobData);

    const workerResult = await dispatchSingleArcanosTask(testJobData.input);
    const taskResult = buildSdkJobExecutionResult(workerResult, {
      fallbackModel: workerBootstrap.model,
      includeWorkerId: true,
    });

    jobRecord = (await completeJobRecord(jobRecord, taskResult)) ?? jobRecord;

    results.job = {
      id: jobRecord?.id || `test-job-${Date.now()}`,
      worker_id: jobRecord?.worker_id || 'worker-1',
      job_type: jobRecord?.job_type || 'test_job',
      job_data: testJobData,
    };

    await logExecution('sdk-interface', 'info', 'System test completed via SDK', {
      results: {
        workers: results.workers,
        routes: results.routes,
        scheduler: results.scheduler,
        job: results.job,
      },
    });

    sendSdkJson(res, {
      success: true,
      message: 'System test completed',
      results,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'System test failed via SDK', error);
  }
});

export default router;
