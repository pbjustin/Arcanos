import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const originalEnvironment = process.env;
const authorityEnvironmentNames = [
  'FINETUNED_MODEL_ID', 'RAILWAY_FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID',
  'AI_MODEL', 'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL'
];
const isolatedEnvironmentNames = [
  ...authorityEnvironmentNames,
  'OPENAI_API_KEY', 'RAILWAY_OPENAI_API_KEY', 'API_KEY', 'OPENAI_KEY',
  'DATABASE_URL', 'RAILWAY_DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
  'REDIS_URL', 'RAILWAY_API_TOKEN', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID',
  'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_DEPLOYMENT_ID',
  'ARCANOS_GPT_ACCESS_TOKEN', 'ARCANOS_GPT_ACCESS_BASE_URL', 'ARCANOS_GPT_ACCESS_SCOPES',
  'ARCANOS_JOB_READ_CAPABILITY_SECRET', 'ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET'
];

const initializeDatabase = jest.fn(async () => true);
const initializeMemory = jest.fn(async () => undefined);
const verifySchema = jest.fn(async () => undefined);
const probeRailwayApi = jest.fn(async () => ({ ok: true }));
const hydrateJudgedResponseFeedbackContext = jest.fn(async () => 0);
const validateAPIKeyAtStartup = jest.fn(() => false);
const verifyIntegrityManifestConfiguration = jest.fn();
const activateUnsafeCondition = jest.fn();
const emitSafetyAuditEvent = jest.fn();
const getGptRegistrySnapshot = jest.fn(async () => ({
  validation: {
    registeredGptCount: 2,
    registeredGptIds: ['arcanos-core', 'core'],
    requiredGptIds: ['arcanos-core', 'core'],
    missingGptIds: []
  }
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  aiLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  recordTraceEvent: jest.fn()
}));
jest.unstable_mockModule('@core/db/index.js', () => ({
  initializeDatabaseWithSchema: initializeDatabase
}));
jest.unstable_mockModule('@core/persistenceManagerHierarchy.js', () => ({ verifySchema }));
jest.unstable_mockModule('@core/memory/store.js', () => ({
  default: { initialize: initializeMemory }
}));
jest.unstable_mockModule('@platform/runtime/environmentSecurity.js', () => ({
  initializeEnvironmentSecurity: jest.fn(async () => ({
    isTrusted: true, safeMode: false, issues: [], policyApplied: 'trusted'
  })),
  getEnvironmentSecuritySummary: jest.fn(() => ({
    trusted: true, safeMode: false, issues: [], fingerprint: 'synthetic-startup-fingerprint'
  }))
}));
jest.unstable_mockModule('@services/railwayClient.js', () => ({
  isRailwayApiConfigured: jest.fn(() => false), probeRailwayApi
}));
jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  verifyIntegrityManifestConfiguration
}));
jest.unstable_mockModule('@services/safety/runtimeState.js', () => ({ activateUnsafeCondition }));
jest.unstable_mockModule('@services/safety/auditEvents.js', () => ({ emitSafetyAuditEvent }));
jest.unstable_mockModule('@services/judgedResponseFeedback.js', () => ({
  hydrateJudgedResponseFeedbackContext
}));
jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({ getGptRegistrySnapshot }));

async function loadPreflight() {
  const credentials = await import('../src/services/openai/credentialProvider.js');
  // Replace the startup provider probe, but retain the actual throwing model
  // selector so a generation-policy read in preflight remains a regression.
  jest.unstable_mockModule('@services/openai.js', () => ({
    validateAPIKeyAtStartup,
    getDefaultModel: credentials.getDefaultModel
  }));
  const { performStartupPreflight } = await import('../src/core/startup.js');
  const { validateEnvironment } = await import('../src/platform/runtime/environmentValidation.js');
  return { performStartupPreflight, validateEnvironment, credentials };
}

describe('deterministic startup without generative final authority', () => {
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnvironment };
    // Blank sentinels prevent dotenv from restoring local credentials or an
    // authority alias when this isolated startup graph is imported.
    for (const name of isolatedEnvironmentNames) process.env[name] = '';
    process.env.NODE_ENV = 'test';
    process.env.FORCE_MOCK = 'true';
    process.env.RUN_WORKERS = 'false';
    process.env.RAILWAY_ENVIRONMENT = 'development';
    process.env.PORT = '8080';
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    process.env = originalEnvironment;
    jest.resetModules();
  });

  function expectNoDependencyWork() {
    expect(initializeDatabase).not.toHaveBeenCalled();
    expect(initializeMemory).not.toHaveBeenCalled();
    expect(verifySchema).not.toHaveBeenCalled();
    expect(probeRailwayApi).not.toHaveBeenCalled();
    expect(hydrateJudgedResponseFeedbackContext).not.toHaveBeenCalled();
  }

  it('completes preflight with valid registrations while generation remains unavailable', async () => {
    const { performStartupPreflight, validateEnvironment, credentials } = await loadPreflight();
    expect(validateEnvironment().isValid).toBe(true);

    await expect(performStartupPreflight()).resolves.toBeUndefined();

    expect(validateAPIKeyAtStartup).toHaveBeenCalledTimes(1);
    expect(getGptRegistrySnapshot).toHaveBeenCalledTimes(1);
    expect(verifyIntegrityManifestConfiguration).toHaveBeenCalledTimes(1);
    expect(activateUnsafeCondition).not.toHaveBeenCalled();
    expect(emitSafetyAuditEvent).not.toHaveBeenCalled();
    expectNoDependencyWork();
    expect(() => credentials.resolveGenerativeModel('final')).toThrow(
      expect.objectContaining({ code: 'FINAL_AUTHORITY_UNAVAILABLE' })
    );
  });

  it.each(['gpt-6.1-sol', 'ft:synthetic authority'])(
    'retains real environment validation rejection for malformed authority %s', async authority => {
      process.env.FINETUNED_MODEL_ID = authority;
      const { performStartupPreflight, validateEnvironment } = await loadPreflight();
      const validation = validateEnvironment();
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toEqual(expect.arrayContaining([expect.stringContaining('Invalid value for AI_MODEL')]));

      await expect(performStartupPreflight()).rejects.toThrow('STARTUP_ENVIRONMENT_INVALID');

      expect(validateAPIKeyAtStartup).not.toHaveBeenCalled();
      expect(getGptRegistrySnapshot).not.toHaveBeenCalled();
      expect(verifyIntegrityManifestConfiguration).not.toHaveBeenCalled();
      expectNoDependencyWork();
    }
  );
});
