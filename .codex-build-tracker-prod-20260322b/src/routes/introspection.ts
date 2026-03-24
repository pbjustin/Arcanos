import express, { Request, Response } from "express";
import getGptModuleMap from "@platform/runtime/gptRouterConfig.js";
import { loadModuleDefinitions } from "@services/moduleLoader.js";
import { asyncHandler } from "@shared/http/index.js";
import { resolveGptRouting } from "./_core/gptDispatch.js";

const router = express.Router();

router.get(
  "/_introspection",
  asyncHandler(async (req: Request, res: Response) => {
    const gptModuleMap = await getGptModuleMap();
    const modules = await loadModuleDefinitions();

    const moduleList = modules.map(m => ({
      name: m.definition.name,
      route: m.route,
      description: m.definition.description ?? null,
      actions: Object.keys(m.definition.actions ?? {}),
      gptIds: m.definition.gptIds ?? [],
    }));

    return res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      counts: {
        modules: moduleList.length,
        gptIds: Object.keys(gptModuleMap).length,
      },
      modules: moduleList,
      gptMap: gptModuleMap,
    });
  })
);


router.get(
  "/_introspection/gpt/:gptId",
  asyncHandler(async (req: Request, res: Response) => {
    const gptId = req.params.gptId;
    const envelope = await resolveGptRouting(gptId, (req as any).requestId);
    const status =
      envelope.ok ? 200 : envelope.error.code === "UNKNOWN_GPT" ? 404 : 400;
    return res.status(status).json(envelope);
  })
);

export default router;
