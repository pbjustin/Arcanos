import fs from 'fs';
import path from 'path';
import { DecisionRecord } from './types.js';
import { recordTraceEvent } from '../utils/telemetry.js';

interface AnalyticsState {
  totals: {
    decisions: number;
    successful: number;
    rejected: number;
  };
  perRoute: Record<string, number>;
  latency: {
    averageMs: number;
    lastMs: number;
  };
  recent: DecisionRecord[];
  lastUpdated: string | null;
}

const RECENT_LIMIT = parseInt(process.env.AFOL_ANALYTICS_RECENT_LIMIT || '50', 10);

const defaultAnalyticsPath = process.env.AFOL_ANALYTICS_PATH
  ? path.resolve(process.env.AFOL_ANALYTICS_PATH)
  : path.resolve(process.cwd(), 'logs', 'afol-analytics.json');

let analyticsFilePath = defaultAnalyticsPath;

const state: AnalyticsState = {
  totals: {
    decisions: 0,
    successful: 0,
    rejected: 0
  },
  perRoute: {
    primary: 0,
    backup: 0,
    reject: 0
  },
  latency: {
    averageMs: 0,
    lastMs: 0
  },
  recent: [],
  lastUpdated: null
};

function ensureDestination(): void {
  const directory = path.dirname(analyticsFilePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function updateLatency(latencyMs: number): void {
  state.latency.lastMs = latencyMs;
  const previousAverage = state.latency.averageMs;
  const count = state.totals.decisions;
  state.latency.averageMs = count === 1 ? latencyMs : Math.round(((previousAverage * (count - 1)) + latencyMs) / count);
}

export function configureAnalytics(options: { filePath?: string } = {}): void {
  if (options.filePath) {
    analyticsFilePath = path.resolve(options.filePath);
  } else {
    analyticsFilePath = defaultAnalyticsPath;
  }
}

export async function persistDecision(decision: DecisionRecord): Promise<void> {
  state.totals.decisions += 1;
  if (decision.ok) {
    state.totals.successful += 1;
  } else {
    state.totals.rejected += 1;
  }

  state.perRoute[decision.route.name] = (state.perRoute[decision.route.name] || 0) + 1;
  updateLatency(decision.meta.latencyMs);

  state.recent.push(decision);
  if (state.recent.length > Math.max(5, RECENT_LIMIT)) {
    state.recent.splice(0, state.recent.length - RECENT_LIMIT);
  }

  state.lastUpdated = new Date().toISOString();

  ensureDestination();

  const payload = {
    ...state,
    recent: state.recent
  };

  try {
    await fs.promises.writeFile(analyticsFilePath, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  } catch (error) {
    console.warn('[afol-analytics] Failed to persist analytics snapshot', error);
  }

  recordTraceEvent('afol.analytics.persisted', {
    decisionId: decision.id,
    route: decision.route.name,
    ok: decision.ok
  });
}

export function getAnalyticsSnapshot() {
  return {
    ...state,
    recent: [...state.recent]
  };
}

export function resetAnalytics(): void {
  state.totals = { decisions: 0, successful: 0, rejected: 0 };
  state.perRoute = { primary: 0, backup: 0, reject: 0 };
  state.latency = { averageMs: 0, lastMs: 0 };
  state.recent = [];
  state.lastUpdated = null;

  if (fs.existsSync(analyticsFilePath)) {
    try {
      fs.unlinkSync(analyticsFilePath);
    } catch (error) {
      console.warn('[afol-analytics] Failed to reset analytics file', error);
    }
  }
}

