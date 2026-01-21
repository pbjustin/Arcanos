import fs from 'fs';
import path from 'path';
import { callOpenAI, getDefaultModel } from './openai.js';
import { loadState, updateState } from './stateManager.js';

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

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  } catch (error) {
    console.error(`[DAILY-SUMMARY] Failed to read ${filePath}`, error);
    return undefined;
  }
}

function collectLogsPreview(): string[] {
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) return [];

  const previews: string[] = [];
  const files = fs.readdirSync(logsDir).filter(file => file.endsWith('.log') || file.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(logsDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      previews.push(`${file}: ${raw.slice(0, 400)}`);
    } catch (error) {
      console.error('[DAILY-SUMMARY] Failed to read log file', filePath, error);
    }
  }
  return previews.slice(0, 5);
}

async function buildSummarySources(): Promise<SummarySources> {
  const systemState = loadState() as Record<string, unknown>;
  const memoryState = readJsonFile(path.join(MEMORY_DIR, 'state.json'));
  const healthHistory = readJsonFile(path.join(process.cwd(), 'logs', 'healthcheck.json'));
  const logsPreview = collectLogsPreview();

  return {
    systemState,
    memoryState,
    healthHistory,
    logsPreview
  };
}

function ensureSummaryDir(): void {
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
  return [
    `You are the ARCANOS daily journal running on the fine-tuned model ${model}.`,
    'Summarize the following state into JSON with keys summary, highlights (array of strings), risks (array), and nextSteps (array).',
    'Keep entries factual and reference observed data only. Include model provenance metadata.',
    'Data:',
    JSON.stringify(sources)
  ].join('\n');
}

export async function generateDailySummary(triggeredBy: string = 'cli'): Promise<DailySummaryResult> {
  const sources = await buildSummarySources();
  const model = process.env.DAILY_SUMMARY_MODEL || getDefaultModel();
  const prompt = buildPrompt(model, sources);

  let parsed: Record<string, unknown> = {};
  try {
    const result = await callOpenAI(model, prompt, 1500, false, {
      responseFormat: { type: 'json_object' },
      metadata: { route: 'daily-summary', triggeredBy }
    });
    parsed = JSON.parse(result.output || '{}');
  } catch (error) {
    console.error('[DAILY-SUMMARY] Failed to generate via OpenAI, falling back to heuristic summary', error);
    parsed = {
      summary: 'Daily summary fallback',
      highlights: [
        `Self tests recorded: ${Array.isArray((sources.healthHistory as any)?.history) ? (sources.healthHistory as any).history.length : 0}`
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
