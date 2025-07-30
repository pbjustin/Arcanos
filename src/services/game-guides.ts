/**
 * Game Guide Service - Generalized game guide storage across multiple titles
 * Designed for ARCANOS memory backend with OpenAI SDK compliance
 */

import { saveMemory, getMemory } from './memory';

export interface SaveGameGuideParams {
  gameId: string;
  guideSections: string[];
}

export interface GameGuidePayload {
  id: string;
  sections: string[];
  lastUpdated: string;
}

export interface FetchGuideSegmentParams {
  category: string;
  guideId: string;
  start?: number;
  end?: number;
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

/**
 * Fetch any game guide section using dynamic route pattern
 * Memory path pattern: guides/{category}/{guideId}
 * Compatible with: latest OpenAI SDK + ARCANOS backend utilities
 * @param params - Object containing category, guideId, start, and end parameters
 * @returns Promise resolving to guide segment string or error message
 */
export async function fetchGuideSegment({
  category,
  guideId,
  start = 0,
  end = 2
}: FetchGuideSegmentParams): Promise<string> {
  const path = `guides/${category}/${guideId}`;
  console.log(`[DEBUG] Fetching guide from path: ${path}`);
  
  const guide = await getMemory(path);
  console.log(`[DEBUG] Guide retrieved:`, guide);

  if (!guide || !Array.isArray(guide.sections)) {
    console.log(`[DEBUG] Guide validation failed - guide exists: ${!!guide}, has sections array: ${guide && Array.isArray(guide.sections)}`);
    return `⚠️ Could not load guide segment: ${category}/${guideId}`;
  }

  const result = guide.sections.slice(start, end).join("\n\n");
  console.log(`[DEBUG] Returning segments ${start}-${end-1}:`, result);
  return result;
}