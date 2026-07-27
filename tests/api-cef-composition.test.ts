import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'cef-composition-token-123456789012345678901';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

const memoryConsistencyGateMock = jest.fn(
  (_req: Request, res: Response, _next: NextFunction) => {
    res.status(418).json({
      ok: false,
      error: {
        code: 'WRITING_PLANE_GATE_REACHED',
      },
    });
  }
);

jest.unstable_mockModule(
  '@transport/http/middleware/memoryConsistencyGate.js',
  () => ({
    memoryConsistencyGate: memoryConsistencyGateMock,
  })
);

const commandRouter = express.Router();
commandRouter.get('/', (_req, res) => {
  res.status(200).json({ kind: 'command-registry' });
});
commandRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
commandRouter.post('/execute', (_req, res) => {
  res.status(200).json({ kind: 'command-execution' });
});
jest.unstable_mockModule('@routes/api-commands.js', () => ({
  default: commandRouter,
}));

const agentRouter = express.Router();
agentRouter.post('/api/agent/execute', (_req, res) => {
  res.status(200).json({ kind: 'agent-execution' });
});
jest.unstable_mockModule('@routes/api-agent.js', () => ({
  default: agentRouter,
}));

const unrelatedApiRouteModules = [
  '@routes/api-arcanos.js',
  '@routes/api-sim.js',
  '@routes/api-memory.js',
  '@routes/api-save-conversation.js',
  '@routes/api-codebase.js',
  '@routes/api-control-plane.js',
  '@routes/api-assistants.js',
  '@routes/api-vision.js',
  '@routes/api-transcribe.js',
  '@routes/api-update.js',
  '@routes/api-daemon.js',
  '@routes/api-prompt-debug.js',
  '@routes/api-ai-routing-debug.js',
  '@routes/api-reusable-code.js',
  '@routes/pr-analysis.js',
  '@routes/openai.js',
  '@routes/afol.js',
  '@routes/web-search.js',
] as const;

for (const moduleName of unrelatedApiRouteModules) {
  jest.unstable_mockModule(moduleName, () => ({
    default: express.Router(),
  }));
}

const request = (await import('supertest')).default;
const {
  cefHttpBoundary,
} = await import('../src/services/controlPlane/cefHttpBoundary.js');
const {
  cefBodyParser,
} = await import('../src/services/controlPlane/cefBodyParser.js');
const apiRouter = (await import('../src/routes/api/index.js')).default;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:cef-composition';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
}

function buildApp(): express.Express {
  const app = express();
  app.use('/api/commands', cefHttpBoundary);
  app.use('/api/agent', cefHttpBoundary);
  app.use('/api/commands', cefBodyParser);
  app.use('/api/agent', cefBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.use('/', apiRouter);
  return app;
}

describe('API CEF production composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
  });

  it('dispatches authenticated command reads before the writing-plane gate', async () => {
    const response = await request(buildApp())
      .get('/api/commands/')
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(response.status).toBe(200);
    expect(response.body.kind).toBe('command-registry');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('keeps command and agent execution behind the writing-plane gate', async () => {
    const commandResponse = await request(buildApp())
      .post('/api/commands/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ command: 'system:status' });
    const agentResponse = await request(buildApp())
      .post('/api/agent/execute/')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ goal: 'Summarize status.' });

    expect(commandResponse.status).toBe(418);
    expect(commandResponse.body.error.code).toBe(
      'WRITING_PLANE_GATE_REACHED'
    );
    expect(agentResponse.status).toBe(418);
    expect(agentResponse.body.error.code).toBe(
      'WRITING_PLANE_GATE_REACHED'
    );
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(2);
  });

  it('rejects anonymous malformed execution JSON before parsing or dispatch', async () => {
    const response = await request(buildApp())
      .post('/api/agent/execute')
      .set('Content-Type', 'application/json')
      .send('{"goal":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
});
