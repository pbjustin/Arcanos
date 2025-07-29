import { Router, Request, Response } from 'express';
import { handleCatchError, sendSuccessResponse } from '../utils/response';
import { githubWebhookService } from '../services/github-webhook-service';
import { config } from '../config';

const router = Router();

// GitHub webhook signature verification middleware
const verifyGitHubSignature = (req: Request, res: Response, next: any) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string;
    const payload = JSON.stringify(req.body);
    
    if (!signature) {
      console.warn('[GITHUB-WEBHOOK] Missing signature header');
      return res.status(401).json({ error: 'Missing signature' });
    }

    // In production, you would verify the signature against your webhook secret
    // For now, we'll log and proceed
    console.log('[GITHUB-WEBHOOK] Signature present:', signature.substring(0, 20) + '...');
    next();
  } catch (error) {
    console.error('[GITHUB-WEBHOOK] Signature verification error:', error);
    return res.status(401).json({ error: 'Invalid signature' });
  }
};

// Main GitHub webhook handler
router.post('/github', verifyGitHubSignature, async (req, res) => {
  try {
    const event = req.headers['x-github-event'] as string;
    const payload = req.body;
    
    console.log(`[GITHUB-WEBHOOK] Received ${event} event`);
    
    // Handle different GitHub events
    switch (event) {
      case 'push':
        await githubWebhookService.handlePush(payload);
        break;
      
      case 'pull_request':
        if (payload.action === 'closed' && payload.pull_request.merged) {
          await githubWebhookService.handlePRMerged(payload);
        }
        break;
      
      case 'release':
        if (payload.action === 'published') {
          await githubWebhookService.handleTagRelease(payload);
        }
        break;
      
      case 'create':
        if (payload.ref_type === 'tag') {
          await githubWebhookService.handleTagRelease(payload);
        }
        break;
      
      default:
        console.log(`[GITHUB-WEBHOOK] Unhandled event: ${event}`);
    }

    sendSuccessResponse(res, 'GitHub webhook processed', { 
      event, 
      action: payload.action,
      repository: payload.repository?.full_name 
    });
  } catch (error: any) {
    console.error('[GITHUB-WEBHOOK] Error processing webhook:', error);
    handleCatchError(res, error, 'GitHub webhook');
  }
});

// Health check endpoint for GitHub webhook
router.get('/github/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'GitHub webhook handler',
    timestamp: new Date().toISOString(),
    capabilities: ['onPush', 'onPRMerged', 'onTagRelease']
  });
});

export default router;