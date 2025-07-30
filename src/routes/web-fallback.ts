/**
 * Web Fallback Routes for ARCANOS
 * Provides API endpoints for external content fetching and summarization
 */

import { Router } from 'express';
import { webFallbackToGPT, getWebFallbackService } from '../services/web-fallback';
import { sendErrorResponse, sendSuccessResponse } from '../utils/response';
import { requireApiToken } from '../middleware/api-token';

const router = Router();

// Apply API token middleware to all web fallback routes
router.use(requireApiToken);

/**
 * POST /web-fallback/summarize
 * Main endpoint implementing the problem statement functionality
 */
router.post('/summarize', async (req, res) => {
  try {
    const { url, topic } = req.body;

    if (!url) {
      return sendErrorResponse(res, 400, 'URL is required', 'Missing url parameter');
    }

    if (typeof url !== 'string') {
      return sendErrorResponse(res, 400, 'Invalid URL format', 'URL must be a string');
    }

    console.log('🌐 Web fallback request:', { url, topic });

    // Use the main function from problem statement
    const summary = await webFallbackToGPT({ url, topic });

    sendSuccessResponse(res, 'Web content summarized successfully', {
      url,
      topic,
      summary,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('❌ Web fallback summarization failed:', error);
    sendErrorResponse(res, 500, 'Web fallback failed', error.message);
  }
});

/**
 * POST /web-fallback/enhanced
 * Enhanced endpoint with additional configuration options
 */
router.post('/enhanced', async (req, res) => {
  try {
    const { url, topic, timeout, maxContentLength } = req.body;

    if (!url) {
      return sendErrorResponse(res, 400, 'URL is required', 'Missing url parameter');
    }

    const service = getWebFallbackService();
    
    const result = await service.fetchAndSummarize({
      url,
      topic,
      timeout: timeout || 30000,
      maxContentLength: maxContentLength || 1000000
    });

    if (result.success) {
      sendSuccessResponse(res, 'Enhanced web fallback completed', {
        content: result.content,
        metadata: result.metadata
      });
    } else {
      sendErrorResponse(res, 500, 'Enhanced web fallback failed', result.error);
    }

  } catch (error: any) {
    console.error('❌ Enhanced web fallback failed:', error);
    sendErrorResponse(res, 500, 'Enhanced web fallback failed', error.message);
  }
});

/**
 * POST /web-fallback/batch
 * Batch processing endpoint for multiple URLs
 */
router.post('/batch', async (req, res) => {
  try {
    const { requests } = req.body;

    if (!Array.isArray(requests)) {
      return sendErrorResponse(res, 400, 'Invalid batch format', 'requests must be an array');
    }

    if (requests.length === 0) {
      return sendErrorResponse(res, 400, 'Empty batch', 'requests array cannot be empty');
    }

    if (requests.length > 10) {
      return sendErrorResponse(res, 400, 'Batch too large', 'Maximum 10 requests per batch');
    }

    // Validate each request
    for (const request of requests) {
      if (!request.url || typeof request.url !== 'string') {
        return sendErrorResponse(res, 400, 'Invalid request format', 'Each request must have a valid url');
      }
    }

    console.log('🌐 Batch web fallback request:', { count: requests.length });

    const service = getWebFallbackService();
    const results = await service.processBatch(requests);

    sendSuccessResponse(res, 'Batch web fallback completed', {
      results,
      summary: {
        total: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
      },
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('❌ Batch web fallback failed:', error);
    sendErrorResponse(res, 500, 'Batch web fallback failed', error.message);
  }
});

/**
 * POST /web-fallback/validate
 * URL validation endpoint
 */
router.post('/validate', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return sendErrorResponse(res, 400, 'URL is required', 'Missing url parameter');
    }

    if (typeof url !== 'string') {
      return sendErrorResponse(res, 400, 'Invalid URL format', 'URL must be a string');
    }

    const service = getWebFallbackService();
    const validation = await service.validateUrl(url);

    sendSuccessResponse(res, 'URL validation completed', {
      url,
      valid: validation.valid,
      error: validation.error,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('❌ URL validation failed:', error);
    sendErrorResponse(res, 500, 'URL validation failed', error.message);
  }
});

/**
 * GET /web-fallback/status
 * Service status endpoint
 */
router.get('/status', async (req, res) => {
  try {
    sendSuccessResponse(res, 'Web fallback service is operational', {
      service: 'Web Fallback Service',
      version: '1.0.0',
      features: [
        'Basic URL summarization',
        'Enhanced configuration options',
        'Batch processing',
        'URL validation'
      ],
      endpoints: [
        'POST /web-fallback/summarize',
        'POST /web-fallback/enhanced',
        'POST /web-fallback/batch',
        'POST /web-fallback/validate',
        'GET /web-fallback/status'
      ],
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    sendErrorResponse(res, 500, 'Status check failed', error.message);
  }
});

export default router;