import type { ModuleDef } from './moduleLoader.js';
import {
  applyArcanosCliApprovedPatch,
  getArcanosCliPolicyMetadata,
  getArcanosCliRepoContext,
  getArcanosCliStatus,
  isArcanosCliBridgeEnabled,
  proposeArcanosCliCommand,
  proposeArcanosCliPatch,
  runArcanosCliApprovedCommand,
  tailArcanosCliAudit
} from './arcanosCliBridge.js';

const ArcanosCli: ModuleDef | undefined = isArcanosCliBridgeEnabled()
  ? {
      name: 'ARCANOS:CLI',
      description: 'Protected control-plane bridge for the optional local ARCANOS Python CLI daemon.',
      defaultAction: 'status',
      defaultTimeoutMs: 30000,
      actions: {
        status: async () => getArcanosCliStatus(),
        policy: async () => getArcanosCliPolicyMetadata(),
        repoContext: async (payload) => getArcanosCliRepoContext(payload),
        proposeCommand: async (payload) => proposeArcanosCliCommand(payload),
        runApprovedCommand: async (payload) => runArcanosCliApprovedCommand(payload),
        proposePatch: async (payload) => proposeArcanosCliPatch(payload),
        applyApprovedPatch: async (payload) => applyArcanosCliApprovedPatch(payload),
        tailAudit: async () => tailArcanosCliAudit()
      }
    }
  : undefined;

export default ArcanosCli;
