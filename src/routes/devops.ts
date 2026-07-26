import { Router, Request, Response } from 'express';
import path from 'path';
import { runSelfTestPipeline } from "@services/selfTestPipeline.js";
import { generateDailySummary } from "@services/dailySummaryService.js";
import { buildTimestampedPayload } from "@transport/http/responseHelpers.js";
import { sendInternalErrorPayload } from '@shared/http/index.js';
import { validateCustom } from '@transport/http/middleware/validation.js';
import {
  diagnosticExecutionHttpBoundary,
} from '@services/controlPlane/diagnosticExecutionHttpBoundary.js';
import {
  diagnosticExecutionBodyParser,
} from '@services/controlPlane/diagnosticExecutionBodyParser.js';

const router = Router();

const requireEmptyDiagnosticBody = validateCustom((data: unknown) => {
  const valid = data === undefined
    || (
      data !== null
      && typeof data === 'object'
      && !Array.isArray(data)
      && Object.keys(data as Record<string, unknown>).length === 0
    );
  return {
    valid,
    errors: valid ? [] : ['Request body must be absent or an empty object'],
  };
});

function resolveDiagnosticActor(req: Request): string {
  return req.controlPlanePrincipal?.principalId ?? 'control-plane-operator';
}

function toRepositoryRelativeArtifact(file: string): string {
  const relativePath = path.relative(process.cwd(), file);
  if (
    relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    return path.basename(file);
  }
  return relativePath.replace(/\\/gu, '/');
}

router.post(
  '/devops/self-test',
  diagnosticExecutionHttpBoundary,
  diagnosticExecutionBodyParser,
  requireEmptyDiagnosticBody,
  async (req: Request, res: Response) => {
    try {
      const summary = await runSelfTestPipeline({
        triggeredBy: resolveDiagnosticActor(req),
      });
      res.json(summary);
    } catch {
      req.logger?.error?.('devops.self_test.failed', {
        requestId: req.requestId,
      });
      sendInternalErrorPayload(res, buildTimestampedPayload({
        error: 'Self-test failed',
        message: 'Self-test execution failed.',
      }));
    }
  }
);

router.post(
  '/devops/daily-summary',
  diagnosticExecutionHttpBoundary,
  diagnosticExecutionBodyParser,
  requireEmptyDiagnosticBody,
  async (req: Request, res: Response) => {
    try {
      const summary = await generateDailySummary(resolveDiagnosticActor(req));
      res.json({
        ...summary,
        file: toRepositoryRelativeArtifact(summary.file),
      });
    } catch {
      req.logger?.error?.('devops.daily_summary.failed', {
        requestId: req.requestId,
      });
      sendInternalErrorPayload(res, buildTimestampedPayload({
        error: 'Daily summary failed',
        message: 'Daily summary generation failed.',
      }));
    }
  }
);

export default router;
