import {
  getJobById,
  JobRepositoryUnavailableError,
  requestJobCancellation,
} from '@core/db/repositories/jobRepository.js';
import { recordGptJobLookup } from '@platform/observability/appMetrics.js';
import {
  getRequestActorKey,
  getRequestEstablishedActorKey,
} from '@platform/runtime/security.js';
import {
  verifyConfiguredJobReadCapability,
} from '@shared/jobs/jobReadCapability.js';
import { sleep } from '@shared/sleep.js';
import {
  validateCustomGptBridgeCredential,
} from '@shared/security/customGptBridgeCredential.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';

import { createGenericJobsRouter } from './genericJobsRouter.js';

const router = createGenericJobsRouter({
  confirmCancellation: confirmGate,
  getJobById,
  getRequestActorKey,
  getRequestEstablishedActorKey,
  isJobRepositoryUnavailable: (error) =>
    error instanceof JobRepositoryUnavailableError,
  recordJobLookup: recordGptJobLookup,
  requestJobCancellation,
  sleep,
  validateBridgeCredential: validateCustomGptBridgeCredential,
  verifyJobReadCapability: verifyConfiguredJobReadCapability,
});

export default router;
