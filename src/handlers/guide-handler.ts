/**
 * Guide Handler - Fetch guide content using existing memory access layer
 * Designed for ARCANOS-style async memory + OpenAI SDK compliance
 * Enhanced with GPT-4 fallback for malformed or incomplete guide results
 */

import { Request, Response } from 'express';
import { getMemory } from '../services/memory';
import { formatGuideChunks } from '../utils/formatter';
import { recoverGameGuide, isMalformed } from '../utils/output-recovery';

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

    // Check if the output appears malformed and apply GPT-4 fallback if needed
    if (isMalformed(fullText, 'markdown')) {
      console.log(`🔄 Applying GPT-4 fallback for guide: ${guideId}`);
      
      try {
        const repairedText = await recoverGameGuide(
          `Fetch ${guideId} guide`,
          fullText
        );
        
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("X-Output-Recovered", "true");
        res.setHeader("X-Recovery-Source", "gpt4-fallback");
        res.status(200).send(repairedText);
        return;
      } catch (fallbackError: any) {
        console.warn(`⚠️ GPT-4 fallback failed for guide ${guideId}:`, fallbackError.message);
        // Continue with original output if fallback fails
      }
    }

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