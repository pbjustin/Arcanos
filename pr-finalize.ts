// PATCH: Finalize GitHub PR Push with Clean Return Serialization
// Fixes: PR data truncation, memory hydration lag, and broken response formatting

import { generatePR } from './services/git';
import { buildPatchSet } from './services/ai-reflections';
import { safeStringify } from './utils/serialization'; // helper to avoid circular JSON

(async () => {
  try {
    const patch = await buildPatchSet({
      useMemory: true,
      hydrateMemoryBeforeCommit: true,
    });

    const prResult = await generatePR({
      patch,
      branchName: `codex/pr-finalize-${Date.now()}`,
      commitMessage: "\ud83d\udd12 Patch: Finalize PR with safe memory and JSON output",
      forcePush: true,
      verifyLock: false
    });

    console.log("\u2705 PR created:", safeStringify(prResult)); // ensure clean logging
  } catch (err) {
    console.error("\u274c PR Finalization Failed:", safeStringify(err));
  }
})();
