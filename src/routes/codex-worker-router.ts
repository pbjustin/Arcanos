import { Router, Request, Response } from "express";
import { runDiagnostics } from "../handlers/diagnostics";
import { runRefactor } from "../handlers/refactor";
import { createDraftBranch } from "../handlers/branchDraft";
import { editBackendCode } from "../handlers/backendEdit";
import { validateCodexIntent, CodexIntent } from "../utils/intentParser";
import { logToStudio } from "../studio/logger";

const router = Router();

// Map of available intent handlers
const intentRouter: Record<string, (payload: any, meta?: any) => Promise<any>> =
  {
    diagnostic: runDiagnostics,
    edit: editBackendCode,
    refactor: runRefactor,
    branchDraft: createDraftBranch,
  };

router.post("/codex/intent", async (req: Request, res: Response) => {
  try {
    const { prompt, meta } = req.body || {};
    const parsed: CodexIntent | null = validateCodexIntent(prompt);

    if (!parsed || !(parsed.intent in intentRouter)) {
      return res.status(400).json({ error: "Invalid or unknown intent" });
    }

    const handler = intentRouter[parsed.intent];
    const result = await handler(parsed.payload, meta);

    logToStudio({
      action: parsed.intent,
      source: "codex-worker-router",
      result,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, result });
  } catch (error: any) {
    logToStudio({
      action: "error",
      source: "codex-worker-router",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
    res.status(500).json({ error: error.message });
  }
});

export default router;
