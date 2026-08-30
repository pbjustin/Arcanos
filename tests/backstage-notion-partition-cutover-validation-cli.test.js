import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  BACKSTAGE_NOTION_PARTITION_CUTOVER_CASES_FILE_MAX_BYTES,
  createDefaultBackstageNotionPartitionCutoverCliEffects,
  runBackstageNotionPartitionCutoverValidationCli,
} from '../scripts/backstage-notion-partition-cutover-validation.mjs';
import {
  parseBackstageNotionPartitionConfiguration,
} from '../src/shared/backstage/backstageNotionPartitionCore.js';
import {
  validateBackstageNotionPartitionCutoverValidationInput,
} from '../src/services/backstageNotionPartitionCutoverValidation.js';

const UNIVERSE_ID = 'my-universe-2k26';
const CONFIGURATION_GENERATION = 'generation-7';
const temporaryDirectories = [];

const CASES = Object.freeze([
  Object.freeze({
    caseId: 'exact-raw',
    kind: 'exact_scope',
    query: Object.freeze({
      query: 'PRIVATE exact representative query',
      retrievalMode: 'relevant',
      retrievalScope: Object.freeze({
        pageTitle: 'Synthetic Raw authority',
        scopeKind: 'page',
      }),
    }),
  }),
  Object.freeze({
    caseId: 'relevant-raw',
    kind: 'relevant',
    query: 'PRIVATE relevant representative query',
  }),
  Object.freeze({
    caseId: 'complete-audit',
    kind: 'complete_scope',
    query: Object.freeze({
      query: 'PRIVATE complete representative query',
      retrievalMode: 'complete_scope',
      retrievalScope: Object.freeze({
        pageTitle: 'Synthetic audit authority',
        scopeKind: 'subtree',
      }),
    }),
  }),
]);

const RAW_CONFIGURATION = JSON.stringify({
  version: 1,
  generation: CONFIGURATION_GENERATION,
  universes: [{
    universeId: UNIVERSE_ID,
    shards: [{
      shardKey: 'raw/year-2026',
      rootPageId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Raw 2026',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:raw'],
      categoryTags: ['raw'],
      capacity: {
        maxPages: 512,
        maxChunks: 2048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }],
  }],
});
const CURRENT_CONFIGURATION = parseBackstageNotionPartitionConfiguration(RAW_CONFIGURATION);

if (CURRENT_CONFIGURATION.status !== 'valid') {
  throw new Error('Test partition configuration must be valid.');
}
const CURRENT_POLICY = Object.freeze({
  configuration: CURRENT_CONFIGURATION,
  mode: Object.freeze({ status: 'valid', mode: 'shadow' }),
});

function validEnvelope(overrides = {}) {
  return {
    version: 1,
    universeId: UNIVERSE_ID,
    configurationGeneration: CONFIGURATION_GENERATION,
    configurationSemanticDigest: CURRENT_CONFIGURATION.semanticDigest,
    cases: CASES,
    ...overrides,
  };
}

function attestation() {
  return {
    version: 1,
    universeId: UNIVERSE_ID,
    partitionConfigurationGeneration: CONFIGURATION_GENERATION,
    partitionConfigurationHash: CURRENT_CONFIGURATION.semanticDigest,
    attestationDigest: 'a'.repeat(64),
    validatedAt: new Date('2026-08-30T15:00:00.000Z'),
    caseCount: 3,
    exactScopeCaseCount: 1,
    relevantCaseCount: 1,
    completeScopeCaseCount: 1,
    cursorContinuationCaseCount: 1,
  };
}

function createEffects(overrides = {}) {
  return {
    suppressRuntimeOutput: false,
    readCasesFile: jest.fn(async () => validEnvelope()),
    validateInput: jest.fn(async input => (
      validateBackstageNotionPartitionCutoverValidationInput(input)
    )),
    readCurrentPolicy: jest.fn(async () => CURRENT_POLICY),
    initializeDatabase: jest.fn(async () => true),
    initializeOpenAIAdapter: jest.fn(async () => undefined),
    validateAndPersist: jest.fn(async () => attestation()),
    closeDatabase: jest.fn(async () => undefined),
    ...overrides,
  };
}

function statefulEffects(effects) {
  return [
    effects.initializeDatabase,
    effects.initializeOpenAIAdapter,
    effects.validateAndPersist,
    effects.closeDatabase,
  ];
}

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-cutover-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  jest.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('Backstage Notion partition cutover validation CLI', () => {
  it('requires the exact seal-current confirmation before reading the cases file', async () => {
    const effects = createEffects();
    const stderr = jest.fn();

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--cases-file', 'cases.json'],
      effects,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(effects.readCasesFile).not.toHaveBeenCalled();
    for (const effect of statefulEffects(effects)) {
      expect(effect).not.toHaveBeenCalled();
    }
    expect(stderr.mock.calls[0]?.[0]).toContain(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CONFIRMATION_REQUIRED'
    );
  });

  it('rejects a non-closed or invalid cases envelope with zero runtime effects', async () => {
    const effects = createEffects({
      readCasesFile: jest.fn(async () => ({ ...validEnvelope(), unexpected: true })),
    });

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--cases-file', 'cases.json', '--seal-current'],
      effects,
      stderr: jest.fn(),
    });

    expect(exitCode).toBe(1);
    expect(effects.validateInput).not.toHaveBeenCalled();
    expect(effects.readCurrentPolicy).not.toHaveBeenCalled();
    for (const effect of statefulEffects(effects)) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid representative cases before reading current runtime state', async () => {
    const effects = createEffects({
      readCasesFile: jest.fn(async () => validEnvelope({
        cases: CASES.map(item => item.kind === 'relevant'
          ? { ...item, query: CASES[0].query }
          : item),
      })),
    });

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--cases-file', 'cases.json', '--seal-current'],
      effects,
      stderr: jest.fn(),
    });

    expect(exitCode).toBe(1);
    expect(effects.readCurrentPolicy).not.toHaveBeenCalled();
    for (const effect of statefulEffects(effects)) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it('rejects an oversized regular cases file before any runtime effects', async () => {
    const directory = createTemporaryDirectory();
    const fileName = 'oversized-cases.json';
    writeFileSync(
      join(directory, fileName),
      'x'.repeat(BACKSTAGE_NOTION_PARTITION_CUTOVER_CASES_FILE_MAX_BYTES + 1),
      'utf8'
    );
    const effects = createEffects();
    delete effects.readCasesFile;
    const stderr = jest.fn();

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--cases-file', fileName, '--seal-current'],
      cwd: directory,
      effects,
      stderr,
    });

    expect(exitCode).toBe(1);
    for (const effect of statefulEffects(effects)) {
      expect(effect).not.toHaveBeenCalled();
    }
    expect(stderr.mock.calls[0]?.[0]).toContain(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CASES_FILE_TOO_LARGE'
    );
  });

  it('rejects stale generation or semantic binding before database, OpenAI, or validation', async () => {
    for (const staleBinding of [
      { configurationGeneration: 'generation-6' },
      { configurationSemanticDigest: 'b'.repeat(64) },
    ]) {
      const effects = createEffects({
        readCasesFile: jest.fn(async () => validEnvelope(staleBinding)),
      });

      const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
        argv: ['--seal-current', '--cases-file', 'cases.json'],
        effects,
        stderr: jest.fn(),
      });

      expect(exitCode).toBe(1);
      expect(effects.readCurrentPolicy).toHaveBeenCalledTimes(1);
      for (const effect of statefulEffects(effects)) {
        expect(effect).not.toHaveBeenCalled();
      }
    }
  });

  it('requires the exact live shadow mode before database or provider effects', async () => {
    for (const mode of [
      { status: 'valid', mode: 'monolith' },
      { status: 'valid', mode: 'partitioned' },
      { status: 'invalid', mode: 'monolith' },
    ]) {
      const effects = createEffects({
        readCurrentPolicy: jest.fn(async () => ({
          configuration: CURRENT_CONFIGURATION,
          mode,
        })),
      });
      const stderr = jest.fn();

      const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
        argv: ['--seal-current', '--cases-file', 'cases.json'],
        effects,
        stderr,
      });

      expect(exitCode).toBe(1);
      for (const effect of statefulEffects(effects)) {
        expect(effect).not.toHaveBeenCalled();
      }
      expect(stderr.mock.calls[0]?.[0]).toContain(
        'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_MODE_NOT_SHADOW'
      );
    }
  });

  it('validates and persists exactly once, emits no case content, and closes the pool', async () => {
    const events = [];
    const effects = createEffects({
      initializeDatabase: jest.fn(async () => {
        events.push('database');
        return true;
      }),
      initializeOpenAIAdapter: jest.fn(async () => {
        events.push('openai');
      }),
      validateAndPersist: jest.fn(async () => {
        events.push('validate');
        return attestation();
      }),
      closeDatabase: jest.fn(async () => {
        events.push('close');
      }),
    });
    const stdout = jest.fn();

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--cases-file', 'cases.json', '--seal-current'],
      effects,
      stdout,
      stderr: jest.fn(),
    });

    expect(exitCode).toBe(0);
    expect(events).toEqual(['database', 'openai', 'validate', 'close']);
    expect(effects.validateAndPersist).toHaveBeenCalledTimes(1);
    expect(effects.validateAndPersist).toHaveBeenCalledWith({
      universeId: UNIVERSE_ID,
      cases: CASES,
      expectedConfiguration: {
        generation: CONFIGURATION_GENERATION,
        semanticDigest: CURRENT_CONFIGURATION.semanticDigest,
      },
    });
    expect(effects.closeDatabase).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls[0]?.[0] ?? '';
    expect(output).toContain('"evidenceSealed": true');
    expect(output).toContain('"modeChanged": false');
    expect(output).not.toContain('PRIVATE');
    expect(output).not.toContain('representative query');
  });

  it('always closes after database initialization and redacts validation errors', async () => {
    const effects = createEffects({
      validateAndPersist: jest.fn(async () => {
        throw new Error('PRIVATE secret query and database locator');
      }),
    });
    const stderr = jest.fn();

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--seal-current', '--cases-file', 'cases.json'],
      effects,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(effects.closeDatabase).toHaveBeenCalledTimes(1);
    const output = stderr.mock.calls[0]?.[0] ?? '';
    expect(output).toContain('BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_VALIDATION_FAILED');
    expect(output).not.toContain('PRIVATE');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(512);
  });

  it('reports a bounded post-commit outcome when database close fails after sealing', async () => {
    const effects = createEffects({
      closeDatabase: jest.fn(async () => {
        throw new Error('PRIVATE database close locator');
      }),
    });
    const stdout = jest.fn();
    const stderr = jest.fn();

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--seal-current', '--cases-file', 'cases.json'],
      effects,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const output = stderr.mock.calls[0]?.[0] ?? '';
    expect(output).toContain('BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_DATABASE_CLOSE_FAILED');
    expect(output).toContain('"evidenceSealed":true');
    expect(output).toContain('"modeChanged":false');
    expect(output).toContain('evidence_sealed_with_post_commit_failure');
    expect(output).not.toContain('PRIVATE');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(512);
  });

  it('does not misreport a malformed post-seal attestation as uncommitted', async () => {
    const effects = createEffects({
      validateAndPersist: jest.fn(async () => ({
        ...attestation(),
        partitionConfigurationHash: 'b'.repeat(64),
      })),
    });
    const stderr = jest.fn();

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--seal-current', '--cases-file', 'cases.json'],
      effects,
      stderr,
    });

    expect(exitCode).toBe(1);
    const output = stderr.mock.calls[0]?.[0] ?? '';
    expect(output).toContain('BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_REPORT_INVALID');
    expect(output).toContain('"evidenceSealed":true');
  });

  it('suppresses raw default-effect stdout and stderr for the full runtime window', async () => {
    expect(
      createDefaultBackstageNotionPartitionCutoverCliEffects().suppressRuntimeOutput
    ).toBe(true);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const effects = createEffects({
      suppressRuntimeOutput: true,
      initializeDatabase: jest.fn(async () => {
        console.error('PRIVATE raw database error');
        process.stderr.write('PRIVATE raw database write');
        return true;
      }),
      validateAndPersist: jest.fn(async () => {
        console.error('PRIVATE raw retrieval error');
        process.stderr.write('PRIVATE raw retrieval write');
        return attestation();
      }),
      closeDatabase: jest.fn(async () => {
        console.error('PRIVATE raw close error');
        process.stderr.write('PRIVATE raw close write');
      }),
    });
    const stdout = jest.fn();

    const exitCode = await runBackstageNotionPartitionCutoverValidationCli({
      argv: ['--seal-current', '--cases-file', 'cases.json'],
      effects,
      stdout,
      stderr: jest.fn(),
    });

    expect(exitCode).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(stdout.mock.calls[0]?.[0]).not.toContain('PRIVATE');
    consoleError.mockRestore();
    stderrWrite.mockRestore();
  });

  it('publishes the compiled package entrypoint without embedding confirmation', () => {
    const packageJson = JSON.parse(readFileSync(
      join(process.cwd(), 'package.json'),
      'utf8'
    ));
    expect(packageJson.scripts['backstage:notion:partition:cutover:validate']).toBe(
      'npm run build && node --import ./scripts/register-esm-loader.mjs '
      + 'scripts/backstage-notion-partition-cutover-validation.mjs'
    );
    expect(
      packageJson.scripts['check:backstage-notion-partition-cutover-cli-syntax']
    ).toBe(
      'node --check scripts/backstage-notion-partition-cutover-validation.mjs'
    );
    expect(packageJson.scripts.build).toContain(
      'npm run check:backstage-notion-partition-cutover-cli-syntax'
    );
  });
});
