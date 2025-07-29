/**
 * Game Guide Service - Generalized game guide storage across multiple titles
 * Designed for ARCANOS memory backend with OpenAI SDK compliance
 */

import { saveMemory } from './memory';

export interface SaveGameGuideParams {
  gameId: string;
  guideSections: string[];
}

export interface GameGuidePayload {
  id: string;
  sections: string[];
  lastUpdated: string;
}

/**
 * Save game guide using existing memory access layer
 * Stores guide sections with metadata for multiple game titles
 * @param params - Object containing gameId and guideSections
 * @returns Promise resolving to saved guide payload
 */
export async function saveGameGuide({ gameId, guideSections }: SaveGameGuideParams): Promise<GameGuidePayload> {
  if (!gameId || !Array.isArray(guideSections)) {
    throw new Error("Missing gameId or invalid guideSections array");
  }

  const memoryKey = `guides/${gameId}/full`;
  const guidePayload: GameGuidePayload = {
    id: gameId,
    sections: guideSections,
    lastUpdated: new Date().toISOString()
  };

  // Use existing memory service to save the guide
  await saveMemory(memoryKey, guidePayload);
  
  console.log(`✅ [GAME-GUIDES] Saved guide for ${gameId} with ${guideSections.length} sections`);
  
  return guidePayload;
}