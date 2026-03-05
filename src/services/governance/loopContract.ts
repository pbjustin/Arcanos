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

export function loadLoopContract(): LoopContract {
  const contractPath = path.join(process.cwd(), "contracts", "loop_contract.v1.json");
  const raw = fs.readFileSync(contractPath, "utf-8");
  return JSON.parse(raw) as LoopContract;
}
