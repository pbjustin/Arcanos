import fs from 'fs';
import path from 'path';
import { updateState } from './stateManager.js';

export interface SelfTestPrompt {
  id: string;
  prompt: string;
  expectation: string;
}

export interface SelfTestResult {
  id: string;
  prompt: string;
  expectation: string;
  statusCode: number;
  latencyMs: number;
  success: boolean;
  message?: string;
  activeModel?: string;
  module?: string;
  responsePreview?: string;
}

export interface SelfTestSummary {
  triggeredBy: string;
  baseUrl: string;
  targetModel: string;
  completedAt: string;
  passCount: number;
  failCount: number;
  results: SelfTestResult[];
}

export interface SelfTestOptions {
  baseUrl?: string;
  prompts?: SelfTestPrompt[];
  triggeredBy?: string;
  targetModel?: string;
}

const defaultPrompts: SelfTestPrompt[] = [
  {
    id: 'readiness',
    prompt: 'Respond with a concise status update proving ARCANOS is online and ready for work.',
    expectation: 'Model responds with operational readiness signal.'
  },
  {
    id: 'memory-awareness',
    prompt: 'Summarize any memory context you can access in one paragraph.',
    expectation: 'Model references stored memory context without errors.'
  },
  {
    id: 'module-routing',
    prompt: 'Which internal module handled this request? Reply in JSON {"module":"name"}.',
    expectation: 'Model identifies the executing module and formats JSON correctly.'
  }
];

const LOG_FILE = path.join(process.cwd(), 'logs', 'healthcheck.json');

function resolveBaseUrl(): string {
  if (process.env.SELF_TEST_BASE_URL) return process.env.SELF_TEST_BASE_URL;
  if (process.env.SERVER_URL) return process.env.SERVER_URL.replace(/\/$/, '');
  const port = process.env.PORT || '8080';
  return `http://127.0.0.1:${port}`;
}

function ensureLogFile(): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(LOG_FILE)) {
    const seed = {
      history: [] as SelfTestSummary[],
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(LOG_FILE, JSON.stringify(seed, null, 2));
  }
}

function appendLog(summary: SelfTestSummary): void {
  ensureLogFile();
  try {
    const existingRaw = fs.readFileSync(LOG_FILE, 'utf8');
    const parsed = existingRaw ? JSON.parse(existingRaw) : { history: [] };
    const history: SelfTestSummary[] = Array.isArray(parsed.history) ? parsed.history : [];
    history.push(summary);
    const trimmed = history.slice(-20);
    fs.writeFileSync(
      LOG_FILE,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          history: trimmed
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error('[SELF-TEST] Failed to append log', error);
  }
}

async function executePrompt(
  baseUrl: string,
  targetModel: string,
  prompt: SelfTestPrompt
): Promise<SelfTestResult> {
  const started = Date.now();
  const endpoint = `${baseUrl.replace(/\/$/, '')}/ask`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'arcanos-self-test/1.0',
        'x-confirmed': 'yes'
      },
      body: JSON.stringify({
        prompt: prompt.prompt,
        sessionId: 'self-test',
        overrideAuditSafe: 'self-test'
      })
    });

    const latencyMs = Date.now() - started;
    const statusCode = res.status;

    if (!res.ok) {
      return {
        id: prompt.id,
        prompt: prompt.prompt,
        expectation: prompt.expectation,
        statusCode,
        latencyMs,
        success: false,
        message: `HTTP ${res.status} ${res.statusText}`
      };
    }

    const data = (await res.json()) as Record<string, any>;
    const activeModel = typeof data.activeModel === 'string' ? data.activeModel : undefined;
    const moduleName = typeof data.module === 'string' ? data.module : undefined;
    const responsePreview = typeof data.result === 'string' ? data.result.slice(0, 200) : undefined;
    const modelMatches = activeModel ? activeModel.includes(targetModel) : true;
    const success = Boolean(data.result) && modelMatches;

    return {
      id: prompt.id,
      prompt: prompt.prompt,
      expectation: prompt.expectation,
      statusCode,
      latencyMs,
      success,
      message: success
        ? 'Model responded successfully'
        : `Active model mismatch: expected ${targetModel}, received ${activeModel || 'unknown'}`,
      activeModel,
      module: moduleName,
      responsePreview
    };
  } catch (error) {
    return {
      id: prompt.id,
      prompt: prompt.prompt,
      expectation: prompt.expectation,
      statusCode: 0,
      latencyMs: Date.now() - started,
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function runSelfTestPipeline(options: SelfTestOptions = {}): Promise<SelfTestSummary> {
  const baseUrl = options.baseUrl || resolveBaseUrl();
  const prompts = options.prompts && options.prompts.length > 0 ? options.prompts : defaultPrompts;
  const targetModel = options.targetModel || process.env.FINETUNED_MODEL_ID || process.env.AI_MODEL || 'gpt-4-turbo';
  const triggeredBy = options.triggeredBy || 'cli';

  const results: SelfTestResult[] = [];
  for (const prompt of prompts) {
    const result = await executePrompt(baseUrl, targetModel, prompt);
    results.push(result);
  }

  const passCount = results.filter(r => r.success).length;
  const failCount = results.length - passCount;
  const summary: SelfTestSummary = {
    triggeredBy,
    baseUrl,
    targetModel,
    completedAt: new Date().toISOString(),
    passCount,
    failCount,
    results
  };

  appendLog(summary);
  updateState({
    selfTest: {
      ...summary,
      lastRun: summary.completedAt,
      status: failCount === 0 ? 'pass' : 'fail'
    }
  });

  return summary;
}
