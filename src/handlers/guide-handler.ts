/**
 * Guide Handler - Fetch guide content using existing memory access layer
 * Designed for ARCANOS-style async memory + OpenAI SDK compliance
 */

import { Request, Response } from 'express';
import { getMemory } from '../services/memory';
import { formatGuideChunks } from '../utils/formatter';

export interface GuideSection {
  sections: string[];
  title?: string;
  metadata?: any;
}

/**
 * Fetch guide handler for incomplete guide returns using existing memory access layer
 * @param req - Express request object (expects guideId in body)
 * @param res - Express response object
 */
export const fetchGuideHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { guideId } = req.body;

    if (!guideId) {
      res.status(400).json({ error: "Missing guideId in request." });
      return;
    }

    // Use your existing memory access pattern
    const guide = await getMemory(`guides/${guideId}`);

    if (!guide || !Array.isArray(guide.sections)) {
      res.status(404).json({ error: "Guide not found or incomplete." });
      return;
    }

    const fullText = formatGuideChunks(guide.sections); // using formatGuideChunks() as suggested

    res.setHeader("Content-Type", "text/plain");
    res.status(200).send(fullText);

  } catch (err: any) {
    console.error("Fetch guide error:", err.message);
    res.status(500).json({ 
      error: "Internal guide fetch error", 
      debug: err.stack 
    });
  }
};