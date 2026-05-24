import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadPolicyModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'bridge-policy.mjs')).href);
}

async function loadEvalModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'bridge-eval.mjs')).href);
}

describe('gptoss bridge policy', () => {
  it('excludes OpenAI raw output from reports by default', async () => {
    const bridgeEval = await loadEvalModule() as {
      buildReport: (input: unknown) => unknown;
    };

    const report = bridgeEval.buildReport({
      prompt: 'Explain the local bridge contract.',
      bridgeConfig: {
        gptossModel: 'gpt-oss-20b',
        openaiReferenceModel: 'gpt-4.1-mini',
      },
      candidateResult: {
        status: 'ok',
        latencyMs: 10,
        output: 'LOCAL_OUTPUT_SENTINEL',
      },
      referenceResult: {
        status: 'ok',
        latencyMs: 20,
        output: 'OPENAI_RAW_OUTPUT_SENTINEL',
      },
    });

    const serialized = JSON.stringify(report);
    expect(serialized).toContain('LOCAL_OUTPUT_SENTINEL');
    expect(serialized).not.toContain('OPENAI_RAW_OUTPUT_SENTINEL');
  });

  it('blocks OpenAI output persistence requests', async () => {
    const policy = await loadPolicyModule() as {
      buildBridgePolicy: (input: unknown) => unknown;
      shouldPersistReferenceOutput: (input?: unknown) => unknown;
    };

    const policyResult = policy.buildBridgePolicy({ openAiRawPersistence: true }) as {
      ok?: boolean;
      errors?: Array<{ code?: string; message?: string }>;
    };
    const persistenceDecision = policy.shouldPersistReferenceOutput({ explicitPersist: true }) as {
      allowed?: boolean;
      requested?: boolean;
      reason?: string;
    };

    expect(policyResult).toMatchObject({
      ok: false,
      errors: [{ code: 'openai_raw_persistence_forbidden' }],
    });
    expect(persistenceDecision).toMatchObject({ allowed: false, requested: true });
    expect(persistenceDecision.reason?.toLowerCase()).toContain('openai');
  });

  it('allows local-only candidate eval with network enabled and no reference persistence', async () => {
    const policy = await loadPolicyModule() as {
      buildBridgePolicy: (input: unknown) => unknown;
      parsePolicyArgs: (input?: string[]) => unknown;
    };

    const policyResult = policy.buildBridgePolicy(
      policy.parsePolicyArgs(['--compare', '--allow-network', '--local-only'])
    ) as {
      ok?: boolean;
      policy?: {
        dryRun?: boolean;
        allowNetwork?: boolean;
        localOnly?: boolean;
        enableOpenAiReference?: boolean;
        openAiRawPersistence?: boolean;
      };
      errors?: unknown[];
    };

    expect(policyResult).toMatchObject({
      ok: true,
      policy: {
        dryRun: false,
        allowNetwork: true,
        localOnly: true,
        enableOpenAiReference: false,
        openAiRawPersistence: false,
      },
      errors: [],
    });
  });

  it('treats explicit reference output inclusion as forbidden persistence', async () => {
    const policy = await loadPolicyModule() as {
      buildBridgePolicy: (input: unknown) => unknown;
      parsePolicyArgs: (input?: string[]) => unknown;
    };

    const policyResult = policy.buildBridgePolicy(
      policy.parsePolicyArgs(['--include-reference-output'])
    ) as {
      ok?: boolean;
      errors?: Array<{ code?: string }>;
    };

    expect(policyResult).toMatchObject({
      ok: false,
      errors: [{ code: 'openai_raw_persistence_forbidden' }],
    });
  });
});
