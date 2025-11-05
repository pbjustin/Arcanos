import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { storeMemory } from './memoryAware.js';

export type DatasetConfidence = 'high' | 'medium' | 'low';

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

function slugifyDatasetName(raw: string, fallbackIndex: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
  return slug || `dataset-${fallbackIndex}`;
}

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

function determineConfidence(line: string): DatasetConfidence {
  if (/dataset/i.test(line)) {
    return 'high';
  }
  if (/data\s*source|corpus|knowledge\s*base/i.test(line)) {
    return 'medium';
  }
  return 'low';
}

function sanitizeLine(line: string): string {
  return line
    .replace(/^[-*•\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function logHarvest(result: DatasetHarvestResult): void {
  try {
    const line = `${JSON.stringify(result)}\n`;
    appendFileSync(LOG_FILE, line);
  } catch (error) {
    console.error('❌ [DATASET-HARVEST] Failed to write harvest log:', error instanceof Error ? error.message : 'Unknown error');
  }
}

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
