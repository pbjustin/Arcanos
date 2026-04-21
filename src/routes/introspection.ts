import { promises as fs } from "node:fs";
import path from "node:path";
import express, { Request, Response } from "express";
import getGptModuleMap from "@platform/runtime/gptRouterConfig.js";
import { loadModuleDefinitions } from "@services/moduleLoader.js";
import { asyncHandler } from "@shared/http/index.js";
import { resolveGptRouting } from "./_core/gptDispatch.js";

const router = express.Router();
const CUSTOM_GPT_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  "contracts",
  "custom_gpt_route.openapi.v1.json"
);
const JOB_RESULT_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  'contracts',
  'job_result.openapi.v1.json'
);
const JOB_STATUS_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  'contracts',
  'job_status.openapi.v1.json'
);
const CUSTOM_GPT_BRIDGE_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  'openapi',
  'custom-gpt-bridge.yaml'
);

async function readOpenApiContract(contractPath: string): Promise<unknown> {
  const rawContract = await fs.readFile(contractPath, "utf8");
  return JSON.parse(rawContract) as unknown;
}

router.get(
  "/contracts/custom_gpt_route.openapi.v1.json",
  asyncHandler(async (_req: Request, res: Response) => {
    const contract = await readOpenApiContract(CUSTOM_GPT_OPENAPI_CONTRACT_PATH);
    //audit Assumption: Custom GPT builders should always fetch the latest contract from the backend instead of caching a stale local copy; failure risk: action routing drifts back to deprecated paths like `/ask`; expected invariant: this endpoint returns the live canonical schema and discourages intermediary caching; handling strategy: serve deterministic JSON with `no-store`.
    res.set("cache-control", "no-store, max-age=0");
    return res.json(contract);
  })
);

router.get(
  '/contracts/job_result.openapi.v1.json',
  asyncHandler(async (_req: Request, res: Response) => {
    const contract = await readOpenApiContract(JOB_RESULT_OPENAPI_CONTRACT_PATH);
    res.set('cache-control', 'no-store, max-age=0');
    return res.json(contract);
  })
);

router.get(
  '/contracts/job_status.openapi.v1.json',
  asyncHandler(async (_req: Request, res: Response) => {
    const contract = await readOpenApiContract(JOB_STATUS_OPENAPI_CONTRACT_PATH);
    res.set('cache-control', 'no-store, max-age=0');
    return res.json(contract);
  })
);

router.get(
  '/openapi/custom-gpt-bridge.yaml',
  asyncHandler(async (_req: Request, res: Response) => {
    const contract = await fs.readFile(CUSTOM_GPT_BRIDGE_OPENAPI_CONTRACT_PATH, 'utf8');
    res.set('cache-control', 'no-store, max-age=0');
    res.type('text/yaml');
    return res.send(contract);
  })
);

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
