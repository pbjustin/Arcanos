import {
  sendBadRequestPayload,
  sendInternalErrorPayload,
} from '@shared/http/index.js';
/**
 * PR Analysis API Route
 * Provides webhook endpoint for GitHub PR analysis
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import { PRAssistant } from "@services/prAssistant.js";
import { validateCustom } from "@transport/http/middleware/validation.js";
import {
  diagnosticExecutionHttpBoundary,
} from '@services/controlPlane/diagnosticExecutionHttpBoundary.js';
import {
  diagnosticExecutionBodyParser,
} from '@services/controlPlane/diagnosticExecutionBodyParser.js';
import {
  classifyRepositoryFileAccess,
} from '@services/prAssistant/utils.js';

const router = Router();
const MAX_PR_DIFF_BYTES = 1_500_000;
const MAX_PR_FILES = 500;
const MAX_PR_FILE_PATH_CHARACTERS = 1_024;
const MAX_PR_METADATA_TEXT_CHARACTERS = 512;
const PR_ANALYSIS_REQUEST_KEYS = new Set(['metadata', 'prDiff', 'prFiles']);
const PR_ANALYSIS_METADATA_KEYS = new Set([
  'prNumber',
  'prTitle',
  'repository',
]);

interface PRWebhookPayload {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string;
    diff_url: string;
    head: {
      sha: string;
    };
    base: {
      sha: string;
    };
  };
  repository: {
    full_name: string;
    clone_url: string;
  };
}

interface PRAnalysisRequest {
  prDiff: string;
  prFiles: string[];
  metadata?: {
    prNumber?: number;
    prTitle?: string;
    repository?: string;
  };
}

function normalizeRepositoryRelativePath(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PR_FILE_PATH_CHARACTERS
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.includes(':')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    return null;
  }

  const normalizedSeparators = value.replace(/\\/gu, '/');
  const segments = normalizedSeparators.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..'
    )
  ) {
    return null;
  }

  const normalizedPath = path.posix.normalize(normalizedSeparators);
  if (
    normalizedPath !== normalizedSeparators
    || normalizedPath === '..'
    || normalizedPath.startsWith('../')
  ) {
    return null;
  }
  return normalizedPath;
}

function validatePrAnalysisRequest(
  data: unknown
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;

  if (!record) {
    return {
      valid: false,
      errors: ['Request body must be an object'],
    };
  }
  if (Object.keys(record).some((key) => !PR_ANALYSIS_REQUEST_KEYS.has(key))) {
    errors.push('Request body contains unsupported properties');
  }

  if (
    typeof record.prDiff !== 'string'
    || record.prDiff.trim().length === 0
  ) {
    errors.push('prDiff must be a non-empty string');
  } else if (Buffer.byteLength(record.prDiff, 'utf8') > MAX_PR_DIFF_BYTES) {
    errors.push('prDiff exceeds the allowed size');
  }

  if (!Array.isArray(record.prFiles)) {
    errors.push('prFiles must be an array of repository-relative paths');
  } else if (record.prFiles.length > MAX_PR_FILES) {
    errors.push('prFiles exceeds the allowed item count');
  } else {
    const normalizedFiles = record.prFiles.map(normalizeRepositoryRelativePath);
    if (normalizedFiles.some((file) => file === null)) {
      errors.push('prFiles contains an unsafe repository path');
    } else if (
      new Set(normalizedFiles as string[]).size !== normalizedFiles.length
    ) {
      errors.push('prFiles must not contain duplicate paths');
    }
  }

  if (record.metadata !== undefined) {
    const metadata =
      record.metadata
      && typeof record.metadata === 'object'
      && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : null;
    if (!metadata) {
      errors.push('metadata must be an object when provided');
    } else {
      if (Object.keys(metadata).some((key) => !PR_ANALYSIS_METADATA_KEYS.has(key))) {
        errors.push('metadata contains unsupported properties');
      }
      if (
        metadata.prNumber !== undefined
        && (
          typeof metadata.prNumber !== 'number'
          || !Number.isSafeInteger(metadata.prNumber)
          || metadata.prNumber <= 0
        )
      ) {
        errors.push('metadata.prNumber must be a positive safe integer');
      }
      for (const field of ['prTitle', 'repository'] as const) {
        const value = metadata[field];
        if (
          value !== undefined
          && (
            typeof value !== 'string'
            || value.length > MAX_PR_METADATA_TEXT_CHARACTERS
            || /[\u0000-\u001f\u007f]/u.test(value)
          )
        ) {
          errors.push(`metadata.${field} is invalid`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Webhook endpoint for GitHub PR events
 */
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const payload: PRWebhookPayload = req.body;
    
    // Only process opened, synchronize, and reopened PRs
    if (!['opened', 'synchronize', 'reopened'].includes(payload.action)) {
      return res.status(200).json({ 
        message: 'PR action not requiring analysis',
        action: payload.action 
      });
    }

    // For webhook integration, we'd need to fetch the diff and files
    // This is a simplified version that would need GitHub API integration
    res.status(200).json({ 
      message: 'PR analysis queued',
      prNumber: payload.pull_request.number,
      status: 'processing'
    });

  } catch {
    req.logger?.error?.('pr_analysis.webhook.failed', {
      requestId: req.requestId,
    });
    sendInternalErrorPayload(res, {
      error: 'Internal server error processing PR webhook',
      message: 'PR webhook processing failed.',
    });
  }
});

/**
 * Direct API endpoint for PR analysis
 */
router.post(
  '/analyze',
  diagnosticExecutionHttpBoundary,
  diagnosticExecutionBodyParser,
  validateCustom(validatePrAnalysisRequest),
  async (req: Request, res: Response) => {
    try {
      const { prDiff, prFiles, metadata }: PRAnalysisRequest = req.body;
      const normalizedPrFiles = prFiles.map((file) => (
        normalizeRepositoryRelativePath(file) as string
      ));
      const fileAccessResults = await Promise.all(
        normalizedPrFiles.map((file) => (
          classifyRepositoryFileAccess(process.cwd(), file)
        ))
      );
      if (fileAccessResults.some((result) => result.status === 'unsafe')) {
        return sendBadRequestPayload(res, {
          error: 'Invalid PR file path',
          message: 'PR file paths must remain within the repository.',
        });
      }
      const assistant = new PRAssistant();
      const analysisResult = await assistant.analyzePR(
        prDiff,
        normalizedPrFiles
      );
      const markdownOutput = assistant.formatAsMarkdown(analysisResult);

      res.json({
        success: true,
        result: analysisResult,
        markdown: markdownOutput,
        metadata: {
          timestamp: new Date().toISOString(),
          ...(typeof metadata?.prNumber === 'number'
            ? { prNumber: metadata.prNumber }
            : {}),
          ...(typeof metadata?.prTitle === 'string'
            ? { prTitle: metadata.prTitle }
            : {}),
          ...(typeof metadata?.repository === 'string'
            ? { repository: metadata.repository }
            : {}),
        }
      });
    } catch {
      req.logger?.error?.('pr_analysis.execution.failed', {
        requestId: req.requestId,
      });
      sendInternalErrorPayload(res, {
        error: 'Internal server error during PR analysis',
        message: 'PR analysis execution failed.',
      });
    }
  }
);

/**
 * Health check endpoint for PR assistant service
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    service: 'ARCANOS PR Assistant',
    status: 'healthy',
    version: '1.0.0',
    checks: [
      'Dead/Bloated Code Removal',
      'Simplification & Streamlining', 
      'OpenAI SDK Compatibility',
      'Railway Deployment Readiness',
      'Automated Validation',
      'Final Double-Check'
    ],
    timestamp: new Date().toISOString()
  });
});

/**
 * Get analysis template/schema
 */
router.get('/schema', (_req: Request, res: Response) => {
  res.json({
    requestSchema: {
      type: 'object',
      required: ['prDiff', 'prFiles'],
      properties: {
        prDiff: {
          type: 'string',
          maxBytes: MAX_PR_DIFF_BYTES,
          description: 'Git diff content of the PR'
        },
        prFiles: {
          type: 'array',
          maxItems: MAX_PR_FILES,
          items: { type: 'string' },
          description: 'List of normalized repository-relative files changed in the PR'
        },
        metadata: {
          type: 'object',
          properties: {
            prNumber: { type: 'number' },
            prTitle: { type: 'string' },
            repository: { type: 'string' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    responseSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        result: {
          type: 'object',
          properties: {
            status: { enum: ['✅', '⚠️', '❌'] },
            summary: { type: 'string' },
            checks: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  status: { enum: ['✅', '⚠️', '❌'] },
                  message: { type: 'string' },
                  details: { type: 'array', items: { type: 'string' } }
                }
              }
            },
            reasoning: { type: 'string' },
            recommendations: { type: 'array', items: { type: 'string' } }
          }
        },
        markdown: { type: 'string' },
        metadata: {
          type: 'object',
          properties: {
            timestamp: { type: 'string' },
            prNumber: { type: 'number' },
            prTitle: { type: 'string' },
            repository: { type: 'string' }
          },
          additionalProperties: true
        }
      }
    }
  });
});

router.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404,
  });
});

export default router;
