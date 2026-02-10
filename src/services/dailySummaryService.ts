import fs from 'fs';
import path from 'path';
import { callOpenAI, getDefaultModel } from './openai.js';
import { loadState, updateState } from './stateManager.js';
import { getEnv } from '../config/env.js';
import { DAILY_SUMMARY_PROMPT_LINES } from '../config/dailySummaryTemplates.js';
import { readJsonFileSafely } from '../utils/jsonFileUtils.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { z } from 'zod';
import { parseModelOutputWithSchema } from './safety/aiOutputBoundary.js';

interface SummarySources {
  systemState: Record<string, unknown>;
  memoryState?: Record<string, unknown>;
  healthHistory?: unknown;
  logsPreview: string[];
}

export interface DailySummaryResult {
  model: string;
  file: string;
  summary: Record<string, unknown>;
  generatedAt: string;
  triggeredBy: string;
}

const MEMORY_DIR = path.join(process.cwd(), 'memory');
const dailySummaryOutputSchema = z.record(z.unknown());

function collectLogsPreview(): string[] {
  const logsDir = path.join(process.cwd(), 'logs');
  //audit Assumption: missing logs directory means no previews; risk: false empty; invariant: return array; handling: guard.
  if (!fs.existsSync(logsDir)) return [];

  const previews: string[] = [];
  const files = fs.readdirSync(logsDir).filter(file => file.endsWith('.log') || file.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(logsDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      previews.push(`${file}: ${raw.slice(0, 400)}`);
    } catch (error: unknown) {
      //audit Assumption: log read failures should be skipped; risk: missing preview; invariant: continue; handling: log and continue.
      console.error('[DAILY-SUMMARY] Failed to read log file', filePath, resolveErrorMessage(error));
    }
  }
  return previews.slice(0, 5);
}

async function buildSummarySources(): Promise<SummarySources> {
  const systemState = loadState() as Record<string, unknown>;
  const memoryState = readJsonFileSafely<Record<string, unknown>>(path.join(MEMORY_DIR, 'state.json'));
  const healthHistory = readJsonFileSafely<Record<string, unknown>>(path.join(process.cwd(), 'logs', 'healthcheck.json'));
  const logsPreview = collectLogsPreview();

  return {
    systemState,
    memoryState,
    healthHistory,
    logsPreview
  };
}

function ensureSummaryDir(): void {
  //audit Assumption: missing memory dir requires creation; risk: mkdir failure; invariant: path exists after; handling: mkdir with recursive.
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function resolveSummaryFile(date: Date): string {
  ensureSummaryDir();
  const isoDate = date.toISOString().split('T')[0];
  return path.join(MEMORY_DIR, `summary-${isoDate}.json`);
}

function buildPrompt(model: string, sources: SummarySources): string {
  //audit Assumption: prompt lines are safe to concatenate; risk: large payload; invariant: string output; handling: join with newlines.
  //audit Assumption: untrusted data is delimited; risk: prompt injection; invariant: data treated as content; handling: explicit delimiters and instructions.
  return [
    DAILY_SUMMARY_PROMPT_LINES.intro(model),
    ...DAILY_SUMMARY_PROMPT_LINES.instructions,
    JSON.stringify(sources),
    DAILY_SUMMARY_PROMPT_LINES.dataEnd
  ].join('\n');
}

/**
 * Generate a daily JSON summary of system state.
 * Purpose: Synthesize system, memory, and log snapshots into a structured summary.
 * Inputs/Outputs: triggeredBy optional string; returns DailySummaryResult with metadata.
 * Edge cases: OpenAI failure falls back to a heuristic summary.
 */
export async function generateDailySummary(triggeredBy: string = 'cli'): Promise<DailySummaryResult> {
  const sources = await buildSummarySources();
  // Use config layer for env access (adapter boundary pattern)
  const model = getEnv('DAILY_SUMMARY_MODEL') || getDefaultModel();
  const prompt = buildPrompt(model, sources);

  let parsed: Record<string, unknown> = {};
  try {
    const result = await callOpenAI(model, prompt, 1500, false, {
      responseFormat: { type: 'json_object' },
      metadata: { route: 'daily-summary', triggeredBy }
    });
    //audit Assumption: daily summary output must pass schema validation before persistence; risk: malformed summary file writes; invariant: object payload required; handling: strict boundary parser with explicit fallback.
    parsed = parseModelOutputWithSchema(result.output || '{}', dailySummaryOutputSchema, {
      source: 'dailySummaryService.generateDailySummary',
      allowFallback: true,
      fallbackValue: {}
    });
  } catch (error) {
    //audit Assumption: OpenAI failure should trigger fallback summary; risk: degraded accuracy; invariant: return valid summary; handling: fallback values.
    console.error('[DAILY-SUMMARY] Failed to generate via OpenAI, falling back to heuristic summary', error);
    parsed = {
      summary: 'Daily summary fallback',
      highlights: [
        `Self tests recorded: ${getHealthHistoryLength(sources.healthHistory)}`
      ],
      risks: ['Unable to reach OpenAI - verify API key'],
      nextSteps: ['Retry summary generation once connectivity is restored']
    };
  }

  const generatedAt = new Date().toISOString();
  const file = resolveSummaryFile(new Date());
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        generatedAt,
        model,
        triggeredBy,
        sources,
        summary: parsed
      },
      null,
      2
    )
  );

  updateState({
    dailySummary: {
      generatedAt,
      file,
      model,
      triggeredBy
    }
  });

  return {
    model,
    file,
    summary: parsed,
    generatedAt,
    triggeredBy
  };
}

function getHealthHistoryLength(healthHistory: unknown): number {
  //audit Assumption: non-object means no history; risk: false zero; invariant: number return; handling: guard.
  if (!healthHistory || typeof healthHistory !== 'object') {
    return 0;
  }
  const record = healthHistory as Record<string, unknown>;
  const history = record.history;
  //audit Assumption: history array holds entries; risk: non-array; invariant: return length or 0; handling: Array.isArray.
  return Array.isArray(history) ? history.length : 0;
}
