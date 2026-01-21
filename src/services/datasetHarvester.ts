/**
 * Dataset Harvester Service
 * 
 * Automatically extracts and stores dataset references from audit text output.
 * Scans AI-generated content for mentions of datasets, data sources, and knowledge bases,
 * then persists them to the memory system for future reference and training.
 * 
 * Features:
 * - Pattern-based extraction of dataset mentions
 * - Confidence scoring (high/medium/low)
 * - Automatic slugification and deduplication
 * - Memory system integration
 * - Persistent logging to dataset-harvest.log
 * 
 * @module datasetHarvester
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { storeMemory } from './memoryAware.js';

/**
 * Confidence levels for harvested dataset references.
 */
export type DatasetConfidence = 'high' | 'medium' | 'low';

/**
 * Result of a dataset harvest operation.
 */
export interface DatasetHarvestResult {
  name: string;
  summary: string;
  confidence: DatasetConfidence;
  tags: string[];
  memoryKey: string;
  stored: boolean;
  persistedAt: string;
  requestId?: string;
  sessionId?: string;
}

/**
 * Options for customizing harvest behavior.
 */
interface HarvestOptions {
  sourcePrompt?: string;
  sessionId?: string;
  requestId?: string;
}

const LOG_DIR = process.env.ARC_DATASET_LOG_PATH || join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'dataset-harvest.log');

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Converts a raw dataset name to a URL-safe slug.
 * 
 * @param raw - Raw dataset name
 * @param fallbackIndex - Index to use if slug is empty
 * @returns Slugified dataset name
 */
function slugifyDatasetName(raw: string, fallbackIndex: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
  return slug || `dataset-${fallbackIndex}`;
}

/**
 * Extracts a dataset name from a line of text using pattern matching.
 * Tries multiple patterns: "dataset:", "data source:", "corpus:".
 * 
 * @param line - Line of text to parse
 * @returns Extracted dataset name or truncated line
 */
function extractDatasetName(line: string): string {
  const datasetMatch = line.match(/dataset\s*(?:-|:)?\s*(.+)/i);
  if (datasetMatch && datasetMatch[1]) {
    return datasetMatch[1].trim();
  }

  const sourceMatch = line.match(/data\s*source\s*(?:-|:)?\s*(.+)/i);
  if (sourceMatch && sourceMatch[1]) {
    return sourceMatch[1].trim();
  }

  const corpusMatch = line.match(/corpus\s*(?:-|:)?\s*(.+)/i);
  if (corpusMatch && corpusMatch[1]) {
    return corpusMatch[1].trim();
  }

  return line.substring(0, 80).trim();
}

/**
 * Determines confidence level based on keyword presence in the line.
 * 
 * @param line - Line to analyze
 * @returns Confidence level (high, medium, or low)
 */
function determineConfidence(line: string): DatasetConfidence {
  if (/dataset/i.test(line)) {
    return 'high';
  }
  if (/data\s*source|corpus|knowledge\s*base/i.test(line)) {
    return 'medium';
  }
  return 'low';
}

/**
 * Removes list markers, bullet points, and extra whitespace from a line.
 * 
 * @param line - Line to sanitize
 * @returns Cleaned line
 */
function sanitizeLine(line: string): string {
  return line
    .replace(/^[-*•\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts all potential dataset references from audit text.
 * Filters lines by dataset-related keywords and deduplicates results.
 * 
 * @param auditText - Full audit output text to scan
 * @returns Array of candidate dataset descriptions
 */
function extractDatasetCandidates(auditText: string): string[] {
  const lines = auditText.split(/\r?\n/);
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    if (!rawLine) continue;
    if (!/(dataset|data\s*set|data\s*source|corpus|knowledge\s*base)/i.test(rawLine)) continue;

    const cleaned = sanitizeLine(rawLine);
    if (!cleaned) continue;

    if (seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    candidates.push(cleaned);
  }

  return candidates;
}

/**
 * Appends a harvest result to the persistent log file.
 * 
 * @param result - Harvest result to log
 */
function logHarvest(result: DatasetHarvestResult): void {
  try {
    const line = `${JSON.stringify(result)}\n`;
    appendFileSync(LOG_FILE, line);
  } catch (error) {
    console.error('❌ [DATASET-HARVEST] Failed to write harvest log:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Harvests dataset references from audit text and stores them in memory.
 * Scans the text for dataset-related keywords, extracts candidate references,
 * assigns confidence scores, and persists each to the memory system.
 * 
 * @param auditText - Audit output text to scan for datasets
 * @param options - Optional context including sourcePrompt, sessionId, and requestId
 * @returns Array of harvest results with storage status
 * 
 * @example
 * const results = harvestDatasetsFromAudit(auditOutput, {
 *   sourcePrompt: userPrompt,
 *   sessionId: 'session123',
 *   requestId: 'req456'
 * });
 * console.log(`Harvested ${results.length} datasets`);
 */
export function harvestDatasetsFromAudit(
  auditText: string,
  options: HarvestOptions = {}
): DatasetHarvestResult[] {
  if (!auditText || typeof auditText !== 'string') {
    return [];
  }

  const candidates = extractDatasetCandidates(auditText);
  if (!candidates.length) {
    return [];
  }

  const results: DatasetHarvestResult[] = [];
  const promptSnippet = options.sourcePrompt?.substring(0, 200);

  candidates.forEach((candidate, index) => {
    const name = extractDatasetName(candidate);
    const confidence = determineConfidence(candidate);
    const slug = slugifyDatasetName(name, index + 1);
    const memoryKey = `dataset:${slug}`;
    const persistedAt = new Date().toISOString();
    const tags = ['dataset', 'audit', confidence];

    const storedEntry = storeMemory(
      memoryKey,
      JSON.stringify({
        name,
        summary: candidate,
        discoveredAt: persistedAt,
        sourcePrompt: promptSnippet,
        requestId: options.requestId,
        sessionId: options.sessionId,
        confidence
      }),
      'fact',
      {
        moduleId: 'dataset-harvester',
        tags,
        sessionId: options.sessionId
      }
    );

    const result: DatasetHarvestResult = {
      name,
      summary: candidate,
      confidence,
      tags,
      memoryKey,
      stored: Boolean(storedEntry),
      persistedAt,
      requestId: options.requestId,
      sessionId: options.sessionId
    };

    logHarvest(result);
    console.log(
      `📦 [DATASET-HARVEST] ${result.stored ? 'Stored' : 'Skipped'} dataset candidate: ${name} (confidence: ${confidence})`
    );

    results.push(result);
  });

  return results;
}

export default harvestDatasetsFromAudit;
