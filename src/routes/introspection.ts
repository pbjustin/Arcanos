import { promises as fs } from "node:fs";
import path from "node:path";
import express, { Request, Response } from "express";
import getGptModuleMap from "@platform/runtime/gptRouterConfig.js";
import {
  initializeModuleRegistry,
  listRegisteredModules
} from "@services/moduleRegistry.js";
import { isPublicGptModule } from "@services/moduleCatalog.js";
import { asyncHandler } from "@shared/http/index.js";
import {
  BACKSTAGE_BOOKER_MANAGED_ASYNC_RESULT_OPENAPI_PATH,
} from '@shared/backstage/backstageBookerAsyncContinuation.js';
import { resolveGptRouting } from "./_core/gptDispatch.js";

const router = express.Router();
const CUSTOM_GPT_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  "contracts",
  "custom_gpt_route.openapi.v1.json"
);
const ARCANOS_GAMING_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  "contracts",
  "arcanos_gaming.openapi.v1.json"
);
const BACKSTAGE_BOOKER_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  'contracts',
  'backstage_booker.openapi.v1.json'
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
const ACTION_PLAN_EXECUTION_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  'contracts',
  'action_plan_execution.openapi.v1.json'
);
const CUSTOM_GPT_BRIDGE_OPENAPI_CONTRACT_PATH = path.resolve(
  process.cwd(),
  'openapi',
  'custom-gpt-bridge.yaml'
);

export const BACKSTAGE_BOOKER_BUILDER_CONTRACT_VERSION = '1.6.0';
export const BACKSTAGE_BOOKER_BUILDER_ASYNC_RESULT_PATH =
  BACKSTAGE_BOOKER_MANAGED_ASYNC_RESULT_OPENAPI_PATH;
const BACKSTAGE_BOOKER_LEGACY_ASYNC_RESULT_PATH = '/jobs/{jobId}/result';

interface JsonRecord {
  [key: string]: unknown;
}

function readJsonRecord(value: unknown, fieldName: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Backstage Booker OpenAPI ${fieldName} is invalid.`);
  }
  return value as JsonRecord;
}

function cloneJsonDocument(value: unknown): JsonRecord {
  try {
    return readJsonRecord(
      JSON.parse(JSON.stringify(value)) as unknown,
      'document'
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Backstage Booker')) {
      throw error;
    }
    throw new Error('Backstage Booker OpenAPI document is invalid.');
  }
}

/**
 * Project the repository contract into the Builder-safe bearer continuation.
 * Direct clients retain the generic job-token route; only the live Builder
 * projection replaces that operation with the managed Backstage bearer lane.
 */
export function buildBackstageBookerBuilderOpenApiDocument(
  baseDocument: unknown
): JsonRecord {
  const document = cloneJsonDocument(baseDocument);
  const info = readJsonRecord(document.info, 'info');
  const paths = readJsonRecord(document.paths, 'paths');
  const legacyPathItem = readJsonRecord(
    paths[BACKSTAGE_BOOKER_LEGACY_ASYNC_RESULT_PATH],
    'legacy async result path'
  );
  const legacyOperation = readJsonRecord(
    legacyPathItem.get,
    'legacy async result operation'
  );
  const components = readJsonRecord(document.components, 'components');
  const schemas = readJsonRecord(components.schemas, 'schemas');
  const parameters = readJsonRecord(components.parameters, 'parameters');
  const acceptedSchema = readJsonRecord(
    schemas.BackstageAsyncAcceptedResponse,
    'async accepted schema'
  );
  const acceptedProperties = readJsonRecord(
    acceptedSchema.properties,
    'async accepted properties'
  );
  const resultSchema = readJsonRecord(
    schemas.BackstageJobResultLookup,
    'async result schema'
  );
  const resultProperties = readJsonRecord(
    resultSchema.properties,
    'async result properties'
  );
  const legacyResponses = readJsonRecord(
    legacyOperation.responses,
    'legacy async result responses'
  );

  info.version = BACKSTAGE_BOOKER_BUILDER_CONTRACT_VERSION;
  info.description =
    'Builder-specific contract for Backstage Booker. The configured Action uses one dedicated bearer for continuity, generation, simulation, exact reads, queued-result continuation, and canon writes. Production-sized generation is durably queued; the same managed bearer retrieves its result without forwarding a dynamic job token. Only canon writes require ChatGPT consequential-action approval.';

  const bearerResultOperation: JsonRecord = {
    ...legacyOperation,
    operationId: 'getBackstageBookerJobResult',
    summary: 'Retrieve queued Backstage Booker generation',
    description:
      'After runBackstageBooker returns queued or running, call this operation with the exact returned jobId. The configured Backstage Booker Bearer credential is applied automatically. waitForResultMs performs one bounded wait for the existing job; if status remains pending, call this same operation again. Never resubmit runBackstageBooker while polling.',
    'x-openai-isConsequential': false,
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: 'jobId',
        in: 'path',
        required: true,
        description: 'Exact jobId returned by runBackstageBooker.',
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'waitForResultMs',
        in: 'query',
        required: false,
        description:
          'Bounded server-side wait for the existing queued job. Use 30000. A pending response may be queried again without creating replacement work.',
        schema: {
          type: 'integer',
          minimum: 0,
          maximum: 30000,
          default: 30000,
        },
      },
    ],
    responses: {
      ...legacyResponses,
      '400': {
        description: 'The job identifier, wait bound, query shape, or request body is invalid.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/BackstagePublicErrorResponse' },
          },
        },
      },
      '401': {
        description: 'The dedicated Backstage Booker Bearer credential is missing or invalid.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/BackstagePublicErrorResponse' },
          },
        },
      },
      '429': {
        description: 'The authenticated Backstage Booker request budget was exceeded.',
        headers: {
          'Retry-After': { $ref: '#/components/headers/RetryAfter' },
        },
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/RateLimitResponse' },
          },
        },
      },
      '503': {
        description: 'Backstage Booker authentication, durable job reads, or protected result materialization is unavailable.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/BackstagePublicErrorResponse' },
          },
        },
      },
    },
  };

  const projectedPaths: JsonRecord = {};
  for (const [pathName, pathItem] of Object.entries(paths)) {
    if (pathName === BACKSTAGE_BOOKER_LEGACY_ASYNC_RESULT_PATH) {
      projectedPaths[BACKSTAGE_BOOKER_BUILDER_ASYNC_RESULT_PATH] = {
        get: bearerResultOperation,
      };
    } else {
      projectedPaths[pathName] = pathItem;
    }
  }
  document.paths = projectedPaths;

  const runPathItem = readJsonRecord(
    projectedPaths['/gpt/backstage-booker'],
    'run path'
  );
  const runOperation = readJsonRecord(runPathItem.post, 'run operation');
  runOperation.description =
    'Run one non-persistent Booker action with the configured bearer. Continuity and simulation remain synchronous. Heavy booking generation may return queued or running; then call getBackstageBookerJobResult with the returned jobId until terminal. Never resubmit generation while the accepted job is active. Canon writes use writeBackstageCanon.';
  const runResponses = readJsonRecord(runOperation.responses, 'run responses');
  runResponses['401'] = {
    description: 'A presented Backstage Booker Bearer credential was invalid, malformed, or duplicated.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/BackstagePublicErrorResponse' },
      },
    },
  };
  const acceptedResponse = readJsonRecord(runResponses['202'], '202 response');
  acceptedResponse.description =
    'Production-sized booking generation was accepted by the existing durable worker queue. Do not resubmit it. Call getBackstageBookerJobResult with the returned jobId; the configured Bearer credential authenticates continuation.';

  acceptedSchema.required = Array.isArray(acceptedSchema.required)
    ? acceptedSchema.required.filter(
        value => value !== 'jobReadToken'
          && value !== 'jobReadTokenHeader'
          && value !== 'stream'
      )
    : acceptedSchema.required;
  delete acceptedProperties.jobReadToken;
  delete acceptedProperties.jobReadTokenHeader;
  delete acceptedProperties.stream;
  acceptedProperties.poll = {
    type: 'string',
    description:
      'Managed-bearer result path for getBackstageBookerJobResult. Call that operation with the returned jobId.',
  };
  acceptedSchema.description =
    'Accepted Backstage Booker generation. Builder continuation uses jobId plus the managed Bearer-authenticated getBackstageBookerJobResult operation; dynamic job-token forwarding and the token-authenticated stream route are intentionally absent from this projection.';

  resultSchema.required = Array.isArray(resultSchema.required)
    ? resultSchema.required.filter(value => value !== 'stream')
    : resultSchema.required;
  delete resultProperties.stream;
  resultProperties.poll = {
    type: 'string',
    description:
      'Managed-bearer path for the same getBackstageBookerJobResult operation. Reuse it while status is pending.',
  };

  delete parameters.JobReadToken;
  if (Object.keys(parameters).length === 0) {
    delete components.parameters;
  }

  return document;
}

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
  "/contracts/arcanos_gaming.openapi.v1.json",
  asyncHandler(async (_req: Request, res: Response) => {
    const contract = await readOpenApiContract(ARCANOS_GAMING_OPENAPI_CONTRACT_PATH);
    res.set("cache-control", "no-store, max-age=0");
    return res.json(contract);
  })
);

router.get(
  '/contracts/backstage_booker.openapi.v1.json',
  asyncHandler(async (_req: Request, res: Response) => {
    const contract = buildBackstageBookerBuilderOpenApiDocument(
      await readOpenApiContract(BACKSTAGE_BOOKER_OPENAPI_CONTRACT_PATH)
    );
    res.set('cache-control', 'no-store, max-age=0');
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
  '/contracts/action_plan_execution.openapi.v1.json',
  asyncHandler(async (_req: Request, res: Response) => {
    const contract = await readOpenApiContract(ACTION_PLAN_EXECUTION_OPENAPI_CONTRACT_PATH);
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
    await initializeModuleRegistry();
    const gptModuleMap = await getGptModuleMap();
    const modules = listRegisteredModules();

    const moduleList = modules
      .filter(m => isPublicGptModule(m.definition))
      .map(m => ({
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
