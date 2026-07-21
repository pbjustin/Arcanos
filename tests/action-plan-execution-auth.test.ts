import type { Request } from 'express';
import {
  authenticateActionPlanRequest,
  extractActionPlanBearerToken,
  resolveActionPlanAuthConfiguration,
} from '../src/services/actionPlanExecution/auth.js';
import { deriveActionPlanExecutionRealm } from '../src/services/actionPlanExecution/realm.js';

const requesterToken = 'r'.repeat(40);
const operatorToken = 'o'.repeat(40);
const executorToken = 'e'.repeat(40);

function requestWithAuthorization(value?: string, duplicate = false): Request {
  const rawHeaders = value
    ? duplicate
      ? ['Authorization', value, 'authorization', value]
      : ['Authorization', value]
    : [];
  return {
    rawHeaders,
    header: (name: string) => name.toLowerCase() === 'authorization' ? value : undefined,
  } as unknown as Request;
}

function configuredEnv(): NodeJS.ProcessEnv {
  return {
    ACTION_PLAN_REQUEST_TOKEN: requesterToken,
    ACTION_PLAN_REQUEST_PRINCIPAL_ID: 'requester-1',
    ACTION_PLAN_OPERATOR_TOKEN: operatorToken,
    ACTION_PLAN_OPERATOR_PRINCIPAL_ID: 'operator-1',
    ACTION_PLAN_EXECUTOR_TOKEN: executorToken,
    ACTION_PLAN_EXECUTOR_PRINCIPAL_ID: 'executor-1',
    ACTION_PLAN_EXECUTOR_INSTANCE_ID: 'instance-1',
    ACTION_PLAN_EXECUTOR_AGENT_ID: 'agent-1',
  };
}

describe('Phase 2E purpose-bound ActionPlan authentication', () => {
  it.each([
    [requesterToken, 'requester', 'requester-1'],
    [operatorToken, 'operator', 'operator-1'],
    [executorToken, 'executor', 'executor-1'],
  ] as const)('maps a valid credential to only its configured server principal', (token, role, principalId) => {
    expect(authenticateActionPlanRequest(
      requestWithAuthorization(`Bearer ${token}`),
      configuredEnv(),
    )).toMatchObject({ role, principalId });
  });

  it.each([
    undefined,
    '',
    `bearer ${requesterToken}`,
    `Bearer  ${requesterToken}`,
    `Bearer ${requesterToken} `,
    `Basic ${requesterToken}`,
    `Bearer ${requesterToken}\nextra`,
  ])('rejects a missing or malformed authorization boundary without normalization', value => {
    expect(extractActionPlanBearerToken(requestWithAuthorization(value))).toBeNull();
  });

  it('rejects duplicate Authorization headers', () => {
    expect(extractActionPlanBearerToken(
      requestWithAuthorization(`Bearer ${requesterToken}`, true),
    )).toBeNull();
  });

  it('fails the complete configuration closed when role credentials or principals overlap', () => {
    const env = configuredEnv();
    env.ACTION_PLAN_OPERATOR_TOKEN = requesterToken;
    expect(resolveActionPlanAuthConfiguration(env)).toEqual({ valid: false, principals: [] });

    const principalOverlap = configuredEnv();
    principalOverlap.ACTION_PLAN_EXECUTOR_PRINCIPAL_ID = 'requester-1';
    expect(resolveActionPlanAuthConfiguration(principalOverlap)).toEqual({ valid: false, principals: [] });
  });

  it('does not retain credential material in the authenticated principal', () => {
    const principal = authenticateActionPlanRequest(
      requestWithAuthorization(`Bearer ${executorToken}`),
      configuredEnv(),
    );
    expect(JSON.stringify(principal)).not.toContain(executorToken);
    expect(principal).toEqual({
      role: 'executor',
      principalId: 'executor-1',
      executorInstanceId: 'instance-1',
      executorAgentId: 'agent-1',
    });
  });
});

describe('Phase 2E execution realm derivation', () => {
  it('derives Railway realm only from paired trusted deployment identifiers', () => {
    expect(deriveActionPlanExecutionRealm({
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_ENVIRONMENT_ID: 'environment-1',
    })).toBe('railway:project-1:environment-1');
  });

  it('fails closed for partial Railway identity or request-like realm values', () => {
    expect(deriveActionPlanExecutionRealm({ RAILWAY_PROJECT_ID: 'project-1' })).toBeNull();
    expect(deriveActionPlanExecutionRealm({ ACTION_PLAN_EXECUTION_LOCAL_REALM: 'preview:caller' })).toBeNull();
    expect(deriveActionPlanExecutionRealm({
      RAILWAY_PROJECT_ID: `p${'a'.repeat(127)}`,
      RAILWAY_ENVIRONMENT_ID: `e${'b'.repeat(127)}`,
    })).toBeNull();
  });

  it('permits only explicit mode-compatible local seams without Railway markers', () => {
    expect(deriveActionPlanExecutionRealm({
      NODE_ENV: 'test',
      ACTION_PLAN_EXECUTION_LOCAL_REALM: 'local-test',
    })).toBe('local-test');
    expect(deriveActionPlanExecutionRealm({
      NODE_ENV: 'production',
      ACTION_PLAN_EXECUTION_LOCAL_REALM: 'local-development',
    })).toBeNull();
    expect(deriveActionPlanExecutionRealm({
      NODE_ENV: 'test',
      ACTION_PLAN_EXECUTION_LOCAL_REALM: 'local-test',
      RAILWAY_SERVICE_ID: 'service-1',
    })).toBeNull();
  });
});
