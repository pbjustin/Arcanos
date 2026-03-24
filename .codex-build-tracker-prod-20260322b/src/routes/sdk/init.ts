import express from 'express';

import { logExecution } from '@core/db/index.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import {
  startWorkers,
  type WorkerBootstrapSummary,
} from '@platform/runtime/workerConfig.js';
import { runSystemDiagnostics, type SystemDiagnostics } from '@platform/logging/systemDiagnostics.js';

import {
  buildSdkJobExecutionResult,
  buildSdkRouteRegistrationResults,
  buildSdkSchedulerActivationJobs,
  buildSdkSchedulerSummary,
  completeJobRecord,
  createOrMockJobRecord,
  dispatchSingleArcanosTask,
  normalizeDispatchInput,
  SDK_ROUTE_NAMES,
  SDK_TEST_JOB_DATA,
  sendSdkFailure,
  sendSdkJson,
} from './shared.js';

const router = express.Router();

type DiagnosticsSummary = Record<string, unknown> | SystemDiagnostics | null;

interface InitAllResults {
  workers: WorkerBootstrapSummary;
  routes: { registered: string[]; status: string } | null;
  scheduler: { activated: boolean; jobs: Array<{ name: string; schedule: string }> } | null;
  diagnostics: DiagnosticsSummary;
}

/**
 * Register routes via SDK call
 */
router.post('/routes/register', confirmGate, async (_, res) => {
  try {
    const registrationResults = buildSdkRouteRegistrationResults();

    await logExecution('sdk-interface', 'info', 'Routes registered via SDK', { registrationResults });

    sendSdkJson(res, {
      success: true,
      message: 'Routes registration completed',
      routes: registrationResults,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'Route registration failed via SDK', error);
  }
});

/**
 * Activate scheduler via SDK call
 */
router.post('/scheduler/activate', confirmGate, async (_, res) => {
  try {
    const scheduledJobs = buildSdkSchedulerActivationJobs();

    await logExecution('sdk-interface', 'info', 'Scheduler activated via SDK', { scheduledJobs });

    sendSdkJson(res, {
      success: true,
      message: 'Scheduler activated successfully',
      jobs: scheduledJobs,
      missedJobRecovery: true,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'Scheduler activation failed via SDK', error);
  }
});

/**
 * Dispatch job via SDK call
 */
router.post('/jobs/dispatch', confirmGate, async (req, res) => {
  try {
    const { workerId, jobType, jobData } = req.body as {
      workerId?: string;
      jobType?: string;
      jobData?: unknown;
    };

    if (!workerId || !jobType) {
      return res.status(400).json({
        success: false,
        error: 'workerId and jobType are required',
        timestamp: new Date().toISOString(),
      });
    }

    const primaryResult = await dispatchSingleArcanosTask(normalizeDispatchInput(jobData));
    const result = {
      success: !primaryResult.error,
      workerId: primaryResult.workerId || 'arcanos-core',
      jobType,
      processedAt: new Date().toISOString(),
      result: primaryResult,
    };

    await logExecution('sdk-interface', 'info', 'Job dispatched via SDK', { workerId, jobType, result });

    sendSdkJson(res, {
      success: true,
      message: 'Job dispatched successfully',
      result,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'Job dispatch failed via SDK', error, {
      workerId: (req.body as { workerId?: unknown })?.workerId,
      jobType: (req.body as { jobType?: unknown })?.jobType,
    });
  }
});

/**
 * Dispatch test verification job as specified in problem statement
 */
router.post('/test-job', confirmGate, async (_, res) => {
  try {
    const jobData = { ...SDK_TEST_JOB_DATA };
    let jobRecord = await createOrMockJobRecord('worker-1', 'test_job', jobData);

    const workerResult = await dispatchSingleArcanosTask(jobData.input);
    const result = buildSdkJobExecutionResult(workerResult, {
      includeWorkerId: false,
    });

    jobRecord = (await completeJobRecord(jobRecord, result)) ?? jobRecord;
    void jobRecord;

    await logExecution('sdk-interface', 'info', 'Test job executed via SDK', { result });

    sendSdkJson(res, {
      success: true,
      message: 'Test job executed successfully',
      result,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'Test job failed via SDK', error);
  }
});

/**
 * Run full SDK initialization sequence
 */
router.post('/init-all', confirmGate, async (_, res) => {
  try {
    const workerBootstrap = await startWorkers();
    const results: InitAllResults = {
      workers: workerBootstrap,
      routes: null,
      scheduler: null,
      diagnostics: null,
    };

    results.routes = {
      registered: [...SDK_ROUTE_NAMES],
      status: 'active',
    };
    results.scheduler = buildSdkSchedulerSummary();

    try {
      const diagnosticsResult = await runSystemDiagnostics();
      results.diagnostics = diagnosticsResult.diagnostics;
    } catch (error: unknown) {
      results.diagnostics = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await logExecution('sdk-interface', 'info', 'Full SDK initialization completed', { results });

    sendSdkJson(res, {
      success: true,
      message: 'Full ARCANOS initialization completed via SDK',
      results,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'Full SDK initialization failed via SDK', error);
  }
});

export default router;
