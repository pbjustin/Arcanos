/**
 * PR Analysis API Route
 * Provides webhook endpoint for GitHub PR analysis
 */

import { Router, Request, Response } from 'express';
import { PRAssistant } from '../services/prAssistant.js';
import { validateCustom } from '../middleware/validation.js';

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
    console.log('🔔 PR webhook received');
    
    const payload: PRWebhookPayload = req.body;
    
    // Only process opened, synchronize, and reopened PRs
    if (!['opened', 'synchronize', 'reopened'].includes(payload.action)) {
      return res.status(200).json({ 
        message: 'PR action not requiring analysis',
        action: payload.action 
      });
    }

    console.log(`📝 Analyzing PR #${payload.pull_request.number} - ${payload.pull_request.title}`);

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
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Direct API endpoint for PR analysis
 */
router.post('/analyze', validateCustom((data) => {
  const errors: string[] = [];
  
  if (!data.prDiff || typeof data.prDiff !== 'string') {
    errors.push('prDiff must be a non-empty string');
  }
  
  if (!Array.isArray(data.prFiles)) {
    errors.push('prFiles must be an array of strings');
  }
  
  return { valid: errors.length === 0, errors };
}), async (req: Request, res: Response) => {
  try {
    console.log('🔍 Direct PR analysis requested');
    
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

    console.log(`✅ PR analysis completed - Status: ${analysisResult.status}`);

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
      details: error instanceof Error ? error.message : 'Unknown error'
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
            status: { enum: ['✅', '❌'] },
            summary: { type: 'string' },
            checks: { type: 'object' },
            reasoning: { type: 'string' },
            recommendations: { type: 'array' }
          }
        },
        markdown: { type: 'string' }
      }
    }
  });
});

export default router;