/**
 * Loop Contract Loader
 * Machine-readable contract lives in /contracts/loop_contract.v1.json
 */
import fs from "fs";
import path from "path";

export type DecisionOutput = 'NOOP' | 'SOFT_UPDATE' | 'PATCH_PROPOSAL' | 'ESCALATE' | 'ROLLBACK';

export interface LoopContract {
  version: string;
  name: string;
  decisionOutputs: DecisionOutput[];
  autonomyLevels: Record<string, string>;
  prohibitedPaths: string[];
  rollback: {
    required: boolean;
    maxAutoRollbackAttempts: number;
    rollbackOn: string[];
  };
  evidence: {
    required: boolean;
    store: 'filesystem';
    defaultDir: string;
    retentionDays: number;
  };
  privacy: {
    piiScrub: boolean;
    redactCredentials: boolean;
    minimizePayload: boolean;
  };
}

let cachedLoopContract: LoopContract | null = null;

export function loadLoopContract(): LoopContract {
  //audit Assumption: loop contract is static during process lifetime; risk: stale contract if file changes at runtime; invariant: repeated calls return validated object; handling: cache after first successful parse.
  if (cachedLoopContract) {
    return cachedLoopContract;
  }

  const contractPath = path.join(process.cwd(), "contracts", "loop_contract.v1.json");
  const raw = fs.readFileSync(contractPath, "utf-8");
  cachedLoopContract = JSON.parse(raw) as LoopContract;
  return cachedLoopContract;
}
