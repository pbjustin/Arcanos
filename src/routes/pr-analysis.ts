/**
 * PR Analysis API Route
 * Provides webhook endpoint for GitHub PR analysis
 */

import { Router, Request, Response } from 'express';
import { PRAssistant } from "@services/prAssistant.js";
import { validateCustom } from "@transport/http/middleware/validation.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

const router = Router();

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

  } catch (error) {
    console.error('❌ PR webhook error:', error);
    res.status(500).json({ 
      error: 'Internal server error processing PR webhook',
      details: resolveErrorMessage(error)
    });
  }
});

/**
 * Direct API endpoint for PR analysis
 */
router.post('/analyze', validateCustom((data: any) => {
  const errors: string[] = [];
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;

  if (!record) {
    errors.push('Request body must be an object');
    return { valid: false, errors };
  }
  
  if (!record.prDiff || typeof record.prDiff !== 'string' || record.prDiff.trim().length === 0) {
    errors.push('prDiff must be a non-empty string');
  }
  
  if (!Array.isArray(record.prFiles)) {
    errors.push('prFiles must be an array of strings');
  } else {
    const invalidFiles = record.prFiles.filter(item => typeof item !== 'string' || item.trim().length === 0);
    if (invalidFiles.length > 0) {
      errors.push('prFiles must contain non-empty strings');
    }
  }

  if (record.metadata !== undefined) {
    if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
      errors.push('metadata must be an object when provided');
    } else {
      const metadata = record.metadata as Record<string, unknown>;
      if (metadata.prNumber !== undefined && typeof metadata.prNumber !== 'number') {
        errors.push('metadata.prNumber must be a number');
      }
      if (metadata.prTitle !== undefined && typeof metadata.prTitle !== 'string') {
        errors.push('metadata.prTitle must be a string');
      }
      if (metadata.repository !== undefined && typeof metadata.repository !== 'string') {
        errors.push('metadata.repository must be a string');
      }
    }
  }
  
  return { valid: errors.length === 0, errors };
}), async (req: Request, res: Response) => {
  try {
    
    const { prDiff, prFiles, metadata }: PRAnalysisRequest = req.body;

    if (!prDiff || !Array.isArray(prFiles)) {
      return res.status(400).json({
        error: 'Invalid request body',
        required: ['prDiff', 'prFiles'],
        received: Object.keys(req.body)
      });
    }

    const assistant = new PRAssistant();
    const analysisResult = await assistant.analyzePR(prDiff, prFiles);
    
    const markdownOutput = assistant.formatAsMarkdown(analysisResult);


    res.json({
      success: true,
      result: analysisResult,
      markdown: markdownOutput,
      metadata: {
        timestamp: new Date().toISOString(),
        ...(metadata || {})
      }
    });

  } catch (error) {
    console.error('❌ PR analysis error:', error);
    res.status(500).json({
      error: 'Internal server error during PR analysis',
      details: resolveErrorMessage(error)
    });
  }
});

/**
 * Health check endpoint for PR assistant service
 */
router.get('/health', (req: Request, res: Response) => {
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
router.get('/schema', (req: Request, res: Response) => {
  res.json({
    requestSchema: {
      type: 'object',
      required: ['prDiff', 'prFiles'],
      properties: {
        prDiff: {
          type: 'string',
          description: 'Git diff content of the PR'
        },
        prFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of files changed in the PR'
        },
        metadata: {
          type: 'object',
          properties: {
            prNumber: { type: 'number' },
            prTitle: { type: 'string' },
            repository: { type: 'string' }
          }
        }
      }
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

export default router;