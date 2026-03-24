/**
 * Evidence Pack Writer
 *
 * Writes immutable evidence for each self-improve decision cycle.
 */
import fs from "fs/promises";
import path from "path";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { scrubForStorage } from "@services/privacy/piiScrubber.js";
import { aiLogger } from "@platform/logging/structuredLogging.js";

export interface EvidencePack {
  id: string;
  createdAt: string;
  environment: string;
  autonomyLevel: number;
  decision: 'NOOP' | 'SOFT_UPDATE' | 'PATCH_PROPOSAL' | 'ESCALATE' | 'ROLLBACK';
  trigger: string;
  context: unknown;
  evaluator: unknown;
  actions: unknown;
  rollback?: unknown;
  errors?: unknown;
}


async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeEvidencePack(pack: EvidencePack): Promise<string> {
  const cfg = getConfig();
  const dir = cfg.selfImproveEvidenceDir;
  await ensureDir(dir);

  const scrubbed: EvidencePack = {
    ...pack,
    context: await scrubForStorage(pack.context, { enabled: cfg.selfImprovePiiScrubEnabled }),
    evaluator: await scrubForStorage(pack.evaluator, { enabled: cfg.selfImprovePiiScrubEnabled }),
    actions: await scrubForStorage(pack.actions, { enabled: cfg.selfImprovePiiScrubEnabled }),
    rollback: await scrubForStorage(pack.rollback, { enabled: cfg.selfImprovePiiScrubEnabled }),
    errors: await scrubForStorage(pack.errors, { enabled: cfg.selfImprovePiiScrubEnabled }),
  };

  const filename = `${pack.createdAt.replace(/[:.]/g, '-')}_${pack.id}.json`;
  const outPath = path.join(dir, filename);
  await fs.writeFile(outPath, JSON.stringify(scrubbed, null, 2), "utf-8");

  // Best-effort retention cleanup
  try {
    await pruneEvidencePacks(dir, cfg.selfImproveRetentionDays);
  } catch (e) {
    aiLogger.warn("Evidence pack prune failed", { module: "evidencePack", error: String(e) });
  }

  return outPath;
}

export async function pruneEvidencePacks(dir: string, retentionDays: number): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return;
  }

  for (const file of files) {
    const fp = path.join(dir, file);
    try {
      const st = await fs.stat(fp);
      if (st.isFile() && st.mtimeMs < cutoff) {
        await fs.unlink(fp);
      }
    } catch {
      //audit Assumption: prune failures are non-critical; risk: stale evidence accumulation; invariant: writer path remains available; handling: ignore per-file prune errors.
      // ignore
    }
  }
}
