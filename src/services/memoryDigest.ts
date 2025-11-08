import { getAuditHistory, getContextWindow, getReinforcementConfig } from './contextualReinforcement.js';
import type { MemoryDigestEntry, MemoryDigestResponse } from '../types/reinforcement.js';

export function getMemoryDigest(): MemoryDigestResponse {
  const config = getReinforcementConfig();
  const contexts = getContextWindow();
  const digestSize = Math.min(config.digestSize, contexts.length);
  const selected = contexts.slice(-digestSize);

  const entries: MemoryDigestEntry[] = selected.map((entry) => ({
    id: entry.id,
    source: entry.source,
    summary: entry.summary,
    timestamp: new Date(entry.timestamp).toISOString(),
    score: entry.score,
    patternId: entry.patternId
  }));

  const audits = getAuditHistory();
  const lastAudit = audits[audits.length - 1];

  return {
    mode: config.mode,
    window: config.window,
    digest: entries.map((entry) => entry.id),
    entries,
    last_audit: lastAudit ? new Date(lastAudit.timestamp).toISOString() : undefined
  };
}
