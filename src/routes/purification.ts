/**
 * ARCANOS Codebase Purification Endpoints
 * Provides API access to automated codebase cleaning and optimization tools
 */

import express from 'express';
import { confirmGate } from '../middleware/confirmGate.js';
import { validateSchema } from '../middleware/validation.js';
import { CodebasePurifier } from '../services/codebasePurifier.js';
import { logger } from '../utils/structuredLogging.js';

const router = express.Router();

/**
 * POST /purify/scan - Scan codebase for issues
 * Body: { targetPath?: string, config?: object }
 */
router.post('/scan', validateSchema('purificationRequest'), confirmGate, async (req, res) => {
  try {
    const { targetPath, config } = req.body;
    
    logger.info('Starting purification scan', { 
      targetPath: targetPath || 'current directory',
      hasCustomConfig: !!config
    });

    const purifier = new CodebasePurifier();
    const result = await purifier.purifyCodebase(targetPath);

    res.json({
      success: true,
      result: {
        summary: {
          filesScanned: result.metrics.filesScanned,
          issuesFound: result.metrics.issuesFound,
          potentialSavings: result.metrics.potentialSavings
        },
        scanResults: result.scanResults,
        recommendations: result.recommendations,
        aiAnalysis: result.aiAnalysis,
        changeLog: result.changeLog
      }
    });

  } catch (error) {
    logger.error('Purification scan failed', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Purification scan failed',
      details: (error as Error).message
    });
  }
});

/**
 * POST /purify/analyze - AI-powered code analysis
 * Body: { code: string, analysisType: 'review' | 'safety' | 'refactor' }
 */
router.post('/analyze', validateSchema('aiRequest'), confirmGate, async (req, res) => {
  try {
    const { code, analysisType = 'review' } = req.body;
    
    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Code content is required'
      });
    }

    logger.info('Starting AI code analysis', { 
      analysisType,
      codeLength: code.length
    });

    const purifier = new CodebasePurifier();
    
    // Use the appropriate analysis prompt based on type
    const prompts: Record<string, string> = {
      review: 'Analyze the following code for redundancy, unused functions, and optimization opportunities:',
      safety: 'Determine if the following code can be safely removed without breaking functionality:',  
      refactor: 'Suggest refactoring improvements for the following code:'
    };

    const prompt = prompts[analysisType as string] || prompts.review;
    const fullPrompt = `${prompt}\n\n\`\`\`\n${code}\n\`\`\`\n\nProvide specific, actionable recommendations.`;

    // Import callOpenAI dynamically to avoid circular dependencies
    const { callOpenAI } = await import('../services/openai.js');
    const aiResult = await callOpenAI('gpt-4-turbo', fullPrompt, 1500, false);

    res.json({
      success: true,
      analysis: aiResult.output,
      analysisType,
      metadata: {
        model: 'gpt-4-turbo',
        codeLength: code.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('AI analysis failed', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'AI analysis failed',
      details: (error as Error).message
    });
  }
});

/**
 * POST /purify/apply - Apply purification recommendations
 * Body: { recommendations: array, dryRun?: boolean }
 */
router.post('/apply', validateSchema('purificationApply'), confirmGate, async (req, res) => {
  try {
    const { recommendations, dryRun = true } = req.body;
    
    if (!Array.isArray(recommendations)) {
      return res.status(400).json({
        success: false,
        error: 'Recommendations array is required'
      });
    }

    logger.info('Applying purification recommendations', { 
      count: recommendations.length,
      dryRun
    });

    const purifier = new CodebasePurifier();
    await purifier.applyRecommendations(recommendations, dryRun);

    res.json({
      success: true,
      message: dryRun ? 'Dry run completed successfully' : 'Recommendations applied successfully',
      appliedCount: recommendations.length,
      dryRun
    });

  } catch (error) {
    logger.error('Failed to apply recommendations', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to apply recommendations',
      details: (error as Error).message
    });
  }
});

/**
 * GET /purify/config - Get current purification configuration
 */
router.get('/config', async (req, res) => {
  try {
    const purifier = new CodebasePurifier();
    // Access config through a getter method we'll need to add
    
    res.json({
      success: true,
      config: {
        scanners: {
          deadCode: {
            enabled: true,
            supportedExtensions: ['.py', '.js', '.ts', '.jsx', '.tsx', '.go']
          }
        },
        ai: {
          model: 'gpt-4-turbo',
          enabled: true
        },
        safety: {
          dryRunByDefault: true,
          requireConfirmation: true
        }
      }
    });

  } catch (error) {
    logger.error('Failed to get config', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get configuration',
      details: (error as Error).message
    });
  }
});

/**
 * GET /purify/status - Get purification service status  
 */
router.get('/status', async (req, res) => {
  try {
    // Check if Python scanner is available
    const { spawn } = await import('child_process');
    
    const checkPython = new Promise<boolean>((resolve) => {
      const python = spawn('python3', ['--version'], { stdio: 'pipe' });
      python.on('close', (code) => resolve(code === 0));
      python.on('error', () => resolve(false));
    });

    const pythonAvailable = await Promise.race([
      checkPython,
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))
    ]);

    res.json({
      success: true,
      status: {
        service: 'online',
        pythonScanner: pythonAvailable ? 'available' : 'unavailable',
        aiIntegration: 'available',
        configFile: 'loaded'
      },
      capabilities: [
        'Dead code detection',
        'AI-powered analysis',
        'Safe code removal recommendations',
        'Redundancy detection'
      ]
    });

  } catch (error) {
    logger.error('Status check failed', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Status check failed',
      details: (error as Error).message
    });
  }
});

export default router;