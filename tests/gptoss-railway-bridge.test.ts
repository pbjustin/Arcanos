import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jest } from '@jest/globals';

async function loadPolicyModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'railway-policy.mjs')).href);
}

async function loadBridgeModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'railway-cli-bridge.mjs')).href);
}

async function loadRedactionModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'railway-redaction.mjs')).href);
}

async function loadCandidateModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'railway-training-candidate.mjs')).href);
}

describe('gptoss railway CLI bridge', () => {
  it('fails closed for unknown actions', async () => {
    const policy = await loadPolicyModule() as {
      resolveRailwayPolicy: (input: unknown) => unknown;
    };

    const result = policy.resolveRailwayPolicy({ action: 'railway.rm' }) as {
      ok?: boolean;
      errors?: Array<{ code?: string }>;
    };

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: 'unknown_action' }],
    });
  });

  it('maps read-only actions to argv arrays', async () => {
    const policy = await loadPolicyModule() as {
      resolveRailwayPolicy: (input: unknown) => unknown;
    };

    const result = policy.resolveRailwayPolicy({
      action: 'railway.logs',
      service: 'arcanos-api',
      environment: 'production',
      limit: 25,
    }) as {
      ok?: boolean;
      policy?: { command?: string[]; risk?: string; requiresConfirmation?: boolean };
    };

    expect(result).toMatchObject({
      ok: true,
      policy: {
        risk: 'readonly',
        requiresConfirmation: false,
        command: [
          'railway',
          'logs',
          '--service',
          'arcanos-api',
          '--environment',
          'production',
          '--json',
        ],
      },
    });
  });

  it('allows status without service and fails closed on unsupported scoping', async () => {
    const policy = await loadPolicyModule() as {
      resolveRailwayPolicy: (input: unknown) => unknown;
    };

    const dryStatus = policy.resolveRailwayPolicy({
      action: 'railway.status',
    }) as { ok?: boolean; policy?: { command?: string[] } };
    const productionStatus = policy.resolveRailwayPolicy({
      action: 'railway.status',
      environment: 'production',
    }) as { ok?: boolean; errors?: Array<{ code?: string }>; policy?: { command?: string[] } };

    expect(dryStatus).toMatchObject({
      ok: true,
      policy: { command: ['railway', 'status', '--json'] },
    });
    expect(productionStatus).toMatchObject({
      ok: false,
      errors: [{ code: 'status_scope_unsupported' }],
    });
  });

  it('requires confirmation for privileged actions and still blocks them by default', async () => {
    const policy = await loadPolicyModule() as {
      RAILWAY_CONFIRM_TOKEN: string;
      resolveRailwayPolicy: (input: unknown) => unknown;
    };

    const withoutConfirmation = policy.resolveRailwayPolicy({ action: 'railway.up' }) as {
      ok?: boolean;
      errors?: Array<{ code?: string }>;
    };
    const withConfirmation = policy.resolveRailwayPolicy({
      action: 'railway.up',
      confirmToken: policy.RAILWAY_CONFIRM_TOKEN,
    }) as {
      ok?: boolean;
      policy?: { blockedByDefault?: boolean; risk?: string };
      errors?: Array<{ code?: string }>;
    };

    expect(withoutConfirmation).toMatchObject({
      ok: false,
      errors: [{ code: 'privileged_confirmation_required' }],
    });
    expect(withConfirmation).toMatchObject({
      ok: false,
      policy: { risk: 'privileged', blockedByDefault: true },
      errors: [{ code: 'privileged_action_blocked_by_default' }],
    });
  });

  it('dry-runs without executing Railway CLI', async () => {
    const bridge = await loadBridgeModule() as {
      runRailwayBridge: (input: unknown, dependencies?: unknown) => Promise<unknown>;
    };
    const execFileMock = jest.fn();

    const result = await bridge.runRailwayBridge({
      action: 'railway.status',
      dryRun: true,
    }, { execFileImpl: execFileMock }) as {
      ok?: boolean;
      executed?: boolean;
      commandPreview?: string[];
    };

    expect(result).toMatchObject({
      ok: true,
      executed: false,
      commandPreview: ['railway', 'status', '--json'],
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('does not execute unless --execute is present', async () => {
    const bridge = await loadBridgeModule() as {
      parseArgs: (argv: string[]) => unknown;
      runRailwayBridge: (input: unknown, dependencies?: unknown) => Promise<unknown>;
    };
    const execFileMock = jest.fn();
    const options = bridge.parseArgs([
      '--action',
      'railway.status',
      '--service',
      'arcanos-api',
      '--environment',
      'production',
    ]);

    const result = await bridge.runRailwayBridge(options, { execFileImpl: execFileMock }) as {
      executed?: boolean;
    };

    expect(result.executed).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('uses the Windows Railway shim for execution while preserving command preview', async () => {
    const bridge = await loadBridgeModule() as {
      runRailwayBridge: (input: unknown, dependencies?: unknown) => Promise<unknown>;
    };
    const execFileMock = jest.fn((file, args, options, callback) => {
      callback(null, '{"status":"ok"}', '');
    });

    const result = await bridge.runRailwayBridge({
      action: 'railway.status',
      execute: true,
    }, { execFileImpl: execFileMock }) as {
      executed?: boolean;
      commandPreview?: string[];
    };

    const [file, args, execOptions, callback] = execFileMock.mock.calls[0];
    if (file === process.execPath) {
      expect(args[0]).toContain(join('node_modules', '@railway', 'cli', 'bin', 'railway.js'));
      expect(args.slice(1)).toEqual(['status', '--json']);
    } else {
      expect(file).toBe('railway');
      expect(args).toEqual(['status', '--json']);
    }
    expect(execOptions).toEqual(expect.objectContaining({ shell: false, windowsHide: true }));
    expect(callback).toEqual(expect.any(Function));
    expect(result).toMatchObject({
      executed: true,
      commandPreview: ['railway', 'status', '--json'],
    });
  });

  it('redacts command previews, stdout, stderr, and nested JSON values', async () => {
    const bridge = await loadBridgeModule() as {
      runRailwayBridge: (input: unknown, dependencies?: unknown) => Promise<unknown>;
    };
    const redaction = await loadRedactionModule() as {
      redactCommand: (input: string[]) => string[];
      redactValue: (input: unknown) => unknown;
    };
    const execFileMock = jest.fn((file, args, options, callback) => {
      callback(
        null,
        'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456 DATABASE_URL=postgresql://user:pass@db/railway',
        'Authorization: Bearer abcdefghijklmnopqrs RAILWAY_TOKEN=rwy_abcdefghijklmnopqrstuvwxyz123456',
      );
    });

    const result = await bridge.runRailwayBridge({
      action: 'railway.status',
      execute: true,
    }, { execFileImpl: execFileMock }) as {
      result?: { stdoutPreview?: string; stderrPreview?: string };
    };
    const commandPreview = redaction.redactCommand([
      'railway',
      'variables',
      '--set',
      'DATABASE_URL=postgresql://user:pass@db/railway',
      '--token',
      'rwy_abcdefghijklmnopqrstuvwxyz123456',
    ]);
    const nested = redaction.redactValue({
      ok: true,
      maxNewTokens: 32,
      env: { RAILWAY_TOKEN: 'rwy_abcdefghijklmnopqrstuvwxyz123456' },
      nested: { databaseUrl: 'postgresql://user:pass@db/railway' },
    }) as {
      ok?: boolean;
      maxNewTokens?: number;
      env?: string;
      nested?: { databaseUrl?: string };
    };

    expect(JSON.stringify(result)).not.toContain('sk-proj');
    expect(JSON.stringify(result)).not.toContain('postgresql://user:pass');
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrs');
    expect(result.result?.stdoutPreview).toContain('[REDACTED]');
    expect(result.result?.stderrPreview).toContain('[REDACTED]');
    expect(commandPreview).toEqual([
      'railway',
      'variables',
      '--set',
      'DATABASE_URL=[REDACTED]',
      '--token',
      '[REDACTED]',
    ]);
    expect(nested.ok).toBe(true);
    expect(nested.maxNewTokens).toBe(32);
    expect(nested.env).toBe('[REDACTED]');
    expect(nested.nested?.databaseUrl).toBe('[REDACTED]');
  });

  it('marks generated reports as not trainable and avoids OpenAI/training/vLLM', async () => {
    const bridge = await loadBridgeModule() as {
      runRailwayBridge: (input: unknown, dependencies?: unknown) => Promise<unknown>;
    };

    const result = await bridge.runRailwayBridge({
      action: 'railway.whoami',
      dryRun: true,
    }) as {
      trainingCandidate?: { allowedForTraining?: boolean; requiresHumanReview?: boolean; source?: string };
      openAiCalled?: boolean;
      trainingExecuted?: boolean;
      vllmUsed?: boolean;
    };

    expect(result).toMatchObject({
      trainingCandidate: {
        allowedForTraining: false,
        requiresHumanReview: true,
        source: 'railway_cli_observation',
      },
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
    });
  });

  it('defaults training candidates to unreviewed and not allowed for training', async () => {
    const candidateModule = await loadCandidateModule() as {
      buildRailwayTrainingCandidate: (input: unknown, options?: unknown) => unknown;
    };

    const candidate = candidateModule.buildRailwayTrainingCandidate({
      action: 'railway.logs',
      redacted: true,
      result: { stdoutPreview: 'redacted observation' },
    }, { id: 'railway-candidate-test' }) as {
      source?: string;
      reviewed?: boolean;
      allowed_for_training?: boolean;
      metadata?: { requires_human_review?: boolean; not_raw_training_label?: boolean };
    };

    expect(candidate).toMatchObject({
      id: 'railway-candidate-test',
      source: 'railway_cli_observation',
      reviewed: false,
      allowed_for_training: false,
      metadata: {
        requires_human_review: true,
        not_raw_training_label: true,
      },
    });
  });

  it('uses execFile with shell disabled instead of command strings', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'gptoss', 'railway-cli-bridge.mjs'), 'utf8');

    expect(source).toContain("import { execFile } from 'node:child_process'");
    expect(source).toContain('shell: false');
    expect(source).not.toContain('exec(');
    expect(source).not.toContain('shell: true');
  });
});
