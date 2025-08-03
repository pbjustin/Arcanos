/**
 * Guide Routes - Endpoints for guide management
 */

import { Router, Request, Response } from 'express';
import { fetchGuideHandler } from '../handlers/guide-handler.js';
import { saveGameGuide, fetchGuideSegment } from '../services/game-guides.js';
import { sendSuccessResponse, sendErrorResponse, handleCatchError } from '../utils/response.js';

const router = Router();

// POST /guides/fetch - Fetch guide content by ID
router.post('/fetch', fetchGuideHandler);

// POST /guides/save - Save game guide with sections
router.post('/save', async (req: Request, res: Response) => {
  try {
    const { gameId, guideSections } = req.body;

    if (!gameId) {
      return sendErrorResponse(res, 400, 'gameId is required', 
        'Example: { gameId: "baldurs_gate_3_prologue", guideSections: ["Step 1...", "Step 2..."] }');
    }

    if (!Array.isArray(guideSections)) {
      return sendErrorResponse(res, 400, 'guideSections must be an array', 
        'Example: { gameId: "baldurs_gate_3_prologue", guideSections: ["Step 1...", "Step 2..."] }');
    }

    const result = await saveGameGuide({ gameId, guideSections });
    
    sendSuccessResponse(res, 'Game guide saved successfully', result);
    
  } catch (error: any) {
    handleCatchError(res, error, 'Game guide save operation');
  }
});

// GET /guides/:category/:guideId - Fetch guide segment by category and guideId
router.get('/:category/:guideId', async (req: Request, res: Response) => {
  try {
    const { category, guideId } = req.params;
    const { sectionStart = 0, sectionEnd = 2 } = req.query;

    const content = await fetchGuideSegment({
      category,
      guideId,
      start: Number(sectionStart),
      end: Number(sectionEnd)
    });

    res.setHeader("Content-Type", "text/plain");
    res.status(200).send(content);
    
  } catch (error: any) {
    handleCatchError(res, error, 'Guide segment fetch operation');
  }
});

export default router;