// Synthetic HTTP peer for the real Swift client. No production gateway, provider,
// credential, filesystem, database, queue, or executor implementation is imported.
export const IOS_GATEWAY_PREVIEW_CONTRACT = Object.freeze({
  metadataPath: '/ios/gateway-contract',
  createPath: '/gpt-access/jobs/create',
  resultPath: '/gpt-access/jobs/result',
  listPath: '/gpt-access/capabilities/v1',
  detailPath: '/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT',
  runPath: '/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run',
  selectorHeader: 'x-native-preview-fixture',
  selector: 'ios-gateway-v1',
  bearer: 'Bearer test-ios-preview-only-v1',
  proofHeader: 'x-arcanos-preview-ios-gateway-version',
  proofVersion: 'ios-gateway-client/v1',
  contractSource: 'src/services/gptAccessGateway.ts#buildGptAccessOpenApiDocument',
  fixtures: Object.freeze({
    aiTask: 'sealed-ios-gateway-ai-v1',
    aiAnswer: 'Synthetic iOS Gateway answer.',
    failedTask: 'sealed-ios-gateway-failed-v1',
    unavailableTask: 'sealed-ios-gateway-unavailable-v1',
    unavailableMessage: 'SYNTHETIC_IOS_PREVIEW_PRIVATE_ERROR_MARKER',
    patch: 'sealed-ios-preview-patch-v1',
    patchSha256: 'a'.repeat(64),
    testProfile: 'typescript-unit',
  }),
});

const contract = IOS_GATEWAY_PREVIEW_CONTRACT;
const MAX_ENTRIES = 64;
const TTL_MS = 120_000;
const actions = ['tests.run', 'patch.preview', 'patch.apply'];
const routeKeys = new Set([
  `GET ${contract.metadataPath}`, `GET ${contract.listPath}`, `GET ${contract.detailPath}`,
  `POST ${contract.createPath}`, `POST ${contract.resultPath}`, `POST ${contract.runPath}`,
]);

export interface IosGatewayPreviewRequest {
  method: string;
  path: string;
  fixture?: string;
  authorization?: string;
  idempotencyKey?: string;
  body?: unknown;
  rawBody?: string;
}

export interface IosGatewayPreviewResponse {
  statusCode: number;
  payload: Record<string, unknown>;
}

export function isIosGatewayPreviewRoute(method: string, path: string): boolean {
  return routeKeys.has(`${method} ${path}`);
}

/** Only this public, inert marker may pass the native app's credential denial. */
export function isIosGatewayPreviewAdmission(request: IosGatewayPreviewRequest): boolean {
  return isIosGatewayPreviewRoute(request.method, request.path)
    && request.fixture === contract.selector
    && (request.authorization === undefined || request.authorization === contract.bearer);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,240}$/u.test(value);
}

function error(statusCode: number, code: string, message = 'Synthetic iOS preview request rejected.'): IosGatewayPreviewResponse {
  return { statusCode, payload: { ok: false, error: { code, message } } };
}

interface FixtureJob {
  id: string;
  expiresAt: number;
  rawBody: string;
  key: string;
  action: string;
  pendingReads: number;
}

interface FixtureChallenge {
  id: string;
  expiresAt: number;
  rawBody: string;
  key: string;
  action: string;
}

export function createIosGatewayPreviewFixture(
  identity: { prNumber: number; sourceCommit: string },
  options: { now?: () => number } = {},
): { handle(request: IosGatewayPreviewRequest): IosGatewayPreviewResponse } {
  const now = options.now ?? Date.now;
  const jobs = new Map<string, FixtureJob>();
  const challenges = new Map<string, FixtureChallenge>();
  let sequence = 0;
  const prune = () => {
    for (const [id, job] of jobs) if (job.expiresAt <= now()) jobs.delete(id);
    for (const [id, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(id);
  };
  const jobReceipt = (job: FixtureJob, deduped: boolean): IosGatewayPreviewResponse => ({
    statusCode: job.action.startsWith('ai:') ? 202 : 200,
    payload: job.action.startsWith('ai:')
      ? { ok: true, jobId: job.id, traceId: 'ios-preview', status: 'queued', deduped, resultEndpoint: contract.resultPath }
      : { ok: true, result: { ok: true, accepted: true, persisted: true, action: job.action,
        jobId: job.id, status: 'pending', deduped, traceId: 'ios-preview', poll: contract.resultPath } },
  });
  const createJob = (action: string, key: string, rawBody: string): IosGatewayPreviewResponse => {
    const existing = [...jobs.values()].find((job) => job.key === key);
    if (existing) {
      return existing.action === action && existing.rawBody === rawBody
        ? jobReceipt(existing, true) : error(409, 'IOS_PREVIEW_IDEMPOTENCY_CONFLICT');
    }
    if (jobs.size >= MAX_ENTRIES || !Number.isSafeInteger(sequence + 1)) return error(429, 'IOS_PREVIEW_CAPACITY');
    const id = `14950000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
    const job: FixtureJob = { id, key, rawBody, action, expiresAt: now() + TTL_MS,
      pendingReads: action.startsWith('ai:') ? 1 : 0 };
    jobs.set(id, job);
    return jobReceipt(job, false);
  };
  const result = (id: string): IosGatewayPreviewResponse => {
    const job = jobs.get(id);
    const pending = job !== undefined && job.pendingReads > 0;
    if (pending) job.pendingReads -= 1;
    const failed = job?.action === 'ai:failed';
    const status = !job ? 'not_found' : pending ? 'pending' : failed ? 'failed' : 'completed';
    let output: unknown = null;
    if (job && !pending && !failed) {
      output = job.action.startsWith('ai:')
        ? { ok: true, result: { result: contract.fixtures.aiAnswer } }
        : { protocolVersion: 'local-agent-job-v1', outcome: 'succeeded', output:
          job.action === 'tests.run'
            ? { profile: contract.fixtures.testProfile, status: 'passed', exitCode: 0, stdout: '', stderr: '', durationMs: 0, truncated: false }
            : job.action === 'patch.preview'
              ? { patchSha256: contract.fixtures.patchSha256, files: ['synthetic.txt'], applicable: true,
                check: { exitCode: 0, stdout: '', stderr: '', truncated: false } }
              : { patchSha256: contract.fixtures.patchSha256, files: ['synthetic.txt'], applied: true } };
    }
    return { statusCode: 200, payload: {
      ok: true, traceId: 'ios-preview', jobId: id, status,
      jobStatus: !job ? null : pending ? 'running' : failed ? 'failed' : 'completed',
      lifecycleStatus: !job ? 'not_found' : pending ? 'running' : failed ? 'failed' : 'completed',
      createdAt: null, updatedAt: null, completedAt: null, retentionUntil: null,
      idempotencyUntil: null, expiresAt: null, poll: contract.resultPath, stream: contract.resultPath,
      resultEndpoint: contract.resultPath, result: output,
      error: failed && !pending ? { code: 'IOS_PREVIEW_JOB_FAILED', message: 'Synthetic job failure.' } : null,
    } };
  };

  return { handle(request) {
    if (!isIosGatewayPreviewAdmission(request)) return error(404, 'IOS_PREVIEW_NOT_FOUND');
    if (request.authorization !== contract.bearer) return error(401, 'IOS_PREVIEW_UNAUTHORIZED');
    prune();
    if (request.method === 'GET') {
      if (request.body !== undefined || request.rawBody) return error(400, 'IOS_PREVIEW_INVALID_REQUEST');
      if (request.path === contract.metadataPath) return { statusCode: 200, payload: {
        schemaVersion: 1, proofVersion: contract.proofVersion, synthetic: true,
        prNumber: identity.prNumber, sourceCommit: identity.sourceCommit,
        contractSource: contract.contractSource, fixtures: contract.fixtures,
        protectedEffectsEnabled: false,
      } };
      const capability = { id: 'ARCANOS:LOCAL_AGENT', description: 'Synthetic iOS preview only.', route: null,
        actions, enabled: true };
      return request.path === contract.listPath
        ? { statusCode: 200, payload: { ok: true, capabilities: [capability] } }
        : { statusCode: 200, payload: { ok: true, exists: true, capability: {
          ...capability, name: 'ARCANOS:LOCAL_AGENT', defaultAction: null, defaultTimeoutMs: null,
          actionMetadata: Object.fromEntries(actions.map((action) => [action, {
            risk: action === 'patch.preview' ? 'readonly' : 'privileged',
            requiresConfirmation: action !== 'patch.preview', executionTarget: 'python-daemon',
          }])),
        } } };
    }
    const body = request.body;
    const raw = request.rawBody;
    if (!record(body) || typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 4096 || !raw.endsWith('}')) {
      return error(400, 'IOS_PREVIEW_INVALID_REQUEST');
    }
    // The integration captures raw bytes before parsing; never accept a caller-supplied
    // alternate body alongside the bytes used to bind a confirmation.
    try {
      if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(body)) return error(400, 'IOS_PREVIEW_INVALID_REQUEST');
    } catch { return error(400, 'IOS_PREVIEW_INVALID_REQUEST'); }
    if (request.path === contract.resultPath) {
      if (!Object.keys(body).every((key) => ['jobId', 'traceId'].includes(key))
        || typeof body.jobId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(body.jobId)
        || (body.traceId !== undefined && body.traceId !== 'ios-preview')) return error(400, 'IOS_PREVIEW_INVALID_REQUEST');
      return result(body.jobId);
    }
    if (request.path === contract.createPath) {
      if (!exactKeys(body, ['gptId', 'task', 'maxOutputTokens', 'idempotencyKey'])
        || body.gptId !== 'arcanos-core' || body.maxOutputTokens !== 1024 || !safeKey(body.idempotencyKey)) {
        return error(400, 'IOS_PREVIEW_INVALID_REQUEST');
      }
      if (body.task === contract.fixtures.unavailableTask) return error(503, 'IOS_PREVIEW_UNAVAILABLE', contract.fixtures.unavailableMessage);
      if (body.task !== contract.fixtures.aiTask && body.task !== contract.fixtures.failedTask) return error(400, 'IOS_PREVIEW_INVALID_REQUEST');
      return createJob(body.task === contract.fixtures.aiTask ? 'ai:success' : 'ai:failed', `ai:${body.idempotencyKey}`, raw);
    }
    if (!safeKey(request.idempotencyKey) || !record(body.payload)
      || !exactKeys(body, body.confirmation_token === undefined ? ['action', 'payload'] : ['action', 'payload', 'confirmation_token'])) {
      return error(400, 'IOS_PREVIEW_INVALID_REQUEST');
    }
    const action = body.action;
    const payload = body.payload;
    const validPayload = action === 'tests.run'
      ? exactKeys(payload, ['profile']) && payload.profile === contract.fixtures.testProfile
      : action === 'patch.preview'
        ? exactKeys(payload, ['patch']) && payload.patch === contract.fixtures.patch
        : action === 'patch.apply' && exactKeys(payload, ['patch', 'expectedPatchSha256'])
          && payload.patch === contract.fixtures.patch && payload.expectedPatchSha256 === contract.fixtures.patchSha256;
    if (!validPayload || typeof action !== 'string') return error(400, 'IOS_PREVIEW_INVALID_REQUEST');
    const key = `capability:${request.idempotencyKey}`;
    if (body.confirmation_token !== undefined) {
      const token = body.confirmation_token;
      const challenge = typeof token === 'string' ? challenges.get(token) : undefined;
      if (!challenge) return error(403, 'IOS_PREVIEW_CONFIRMATION_REJECTED');
      challenges.delete(challenge.id);
      const expected = `${challenge.rawBody.slice(0, -1)},"confirmation_token":${JSON.stringify(challenge.id)}}`;
      if (challenge.key !== key || challenge.action !== action || raw !== expected) return error(403, 'IOS_PREVIEW_CONFIRMATION_REJECTED');
      return createJob(action, key, challenge.rawBody);
    }
    if (action === 'patch.preview') return createJob(action, key, raw);
    if (challenges.size >= MAX_ENTRIES) return error(429, 'IOS_PREVIEW_CAPACITY');
    const id = `synthetic-ios-challenge-${++sequence}`;
    const expiresAt = now() + TTL_MS;
    challenges.set(id, { id, key, rawBody: raw, action, expiresAt });
    return { statusCode: 403, payload: {
      code: 'CONFIRMATION_REQUIRED', confirmationRequired: true, endpoint: contract.runPath, method: 'POST',
      confirmationChallenge: { id, issuedAt: new Date(now()).toISOString(), expiresAt: new Date(expiresAt).toISOString(), ttlMs: TTL_MS },
    } };
  } };
}
