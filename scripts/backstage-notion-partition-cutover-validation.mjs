#!/usr/bin/env node

import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BACKSTAGE_NOTION_PARTITION_CUTOVER_CASES_FILE_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_CUTOVER_CASES_FILE_MAX_BYTES = 256 * 1024;

const OPERATION = 'backstage_notion_partition_cutover_validation';
const MAX_CASES = 64;
const MAX_PATH_BYTES = 4_096;
const SAFE_VALIDATION_CODE =
  /^BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_[A-Z0-9_]{1,80}$/u;
const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FORBIDDEN_IDENTITY_VALUES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const ENVELOPE_KEYS = new Set([
  'cases',
  'configurationGeneration',
  'configurationSemanticDigest',
  'universeId',
  'version',
]);

const CLI_ERROR_CODES = Object.freeze({
  argumentInvalid: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_ARGUMENT_INVALID',
  confirmationRequired: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CONFIRMATION_REQUIRED',
  casesFileUnavailable: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CASES_FILE_UNAVAILABLE',
  casesFileNotRegular: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CASES_FILE_NOT_REGULAR',
  casesFileEmpty: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CASES_FILE_EMPTY',
  casesFileTooLarge: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CASES_FILE_TOO_LARGE',
  casesFileChanged: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CASES_FILE_CHANGED',
  casesFileInvalidJson: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CASES_FILE_INVALID_JSON',
  casesFileInvalid: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CASES_FILE_INVALID',
  configurationStale: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_CONFIGURATION_STALE',
  modeNotShadow: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_MODE_NOT_SHADOW',
  databaseUnavailable: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_DATABASE_UNAVAILABLE',
  openAiUnavailable: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_OPENAI_UNAVAILABLE',
  validationFailed: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_VALIDATION_FAILED',
  reportInvalid: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_REPORT_INVALID',
  databaseCloseFailed: 'BACKSTAGE_NOTION_PARTITION_CUTOVER_CLI_DATABASE_CLOSE_FAILED',
});

class BackstageNotionPartitionCutoverCliError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BackstageNotionPartitionCutoverCliError';
    this.code = code;
  }
}

function fail(code) {
  throw new BackstageNotionPartitionCutoverCliError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error) {
  return error instanceof Error && 'code' in error;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameResolvedPath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function requireArgumentValue(argv, index) {
  const value = argv[index + 1];
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('--')
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    fail(CLI_ERROR_CODES.argumentInvalid);
  }
  return value;
}

export function parseBackstageNotionPartitionCutoverCliArguments(argv) {
  let casesFile;
  let sealCurrent = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--cases-file') {
      if (casesFile !== undefined) {
        fail(CLI_ERROR_CODES.argumentInvalid);
      }
      casesFile = requireArgumentValue(argv, index);
      index += 1;
      continue;
    }
    if (argument === '--seal-current') {
      if (sealCurrent) {
        fail(CLI_ERROR_CODES.argumentInvalid);
      }
      sealCurrent = true;
      continue;
    }
    fail(CLI_ERROR_CODES.argumentInvalid);
  }
  if (!sealCurrent) {
    fail(CLI_ERROR_CODES.confirmationRequired);
  }
  if (casesFile === undefined) {
    fail(CLI_ERROR_CODES.argumentInvalid);
  }
  return Object.freeze({ casesFile, sealCurrent: true });
}

export async function readBoundedRegularCutoverCasesFile(
  sourcePath,
  cwd = process.cwd()
) {
  const absolutePath = path.resolve(cwd, sourcePath);
  let beforePathStats;
  try {
    beforePathStats = await fs.lstat(absolutePath, { bigint: true });
  } catch {
    fail(CLI_ERROR_CODES.casesFileUnavailable);
  }
  if (beforePathStats.isSymbolicLink() || !beforePathStats.isFile()) {
    fail(CLI_ERROR_CODES.casesFileNotRegular);
  }
  if (beforePathStats.size <= 0n) {
    fail(CLI_ERROR_CODES.casesFileEmpty);
  }
  if (beforePathStats.size > BigInt(
    BACKSTAGE_NOTION_PARTITION_CUTOVER_CASES_FILE_MAX_BYTES
  )) {
    fail(CLI_ERROR_CODES.casesFileTooLarge);
  }

  try {
    const canonicalPath = await fs.realpath(absolutePath);
    if (!sameResolvedPath(absolutePath, canonicalPath)) {
      fail(CLI_ERROR_CODES.casesFileNotRegular);
    }
  } catch (error) {
    if (error instanceof BackstageNotionPartitionCutoverCliError) {
      throw error;
    }
    fail(CLI_ERROR_CODES.casesFileUnavailable);
  }

  const noFollowFlag = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | noFollowFlag);
  } catch (error) {
    fail(
      isNodeError(error) && error.code === 'ELOOP'
        ? CLI_ERROR_CODES.casesFileNotRegular
        : CLI_ERROR_CODES.casesFileUnavailable
    );
  }

  try {
    const openedStats = await handle.stat({ bigint: true });
    if (
      !openedStats.isFile()
      || !sameFileIdentity(beforePathStats, openedStats)
      || beforePathStats.size !== openedStats.size
      || beforePathStats.mtimeNs !== openedStats.mtimeNs
    ) {
      fail(CLI_ERROR_CODES.casesFileChanged);
    }

    const bytes = Buffer.allocUnsafe(Number(openedStats.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== bytes.length) {
      fail(CLI_ERROR_CODES.casesFileChanged);
    }

    const afterHandleStats = await handle.stat({ bigint: true });
    const afterPathStats = await fs.lstat(absolutePath, { bigint: true });
    const afterCanonicalPath = await fs.realpath(absolutePath);
    if (
      !afterHandleStats.isFile()
      || afterPathStats.isSymbolicLink()
      || !afterPathStats.isFile()
      || !sameFileIdentity(openedStats, afterHandleStats)
      || !sameFileIdentity(openedStats, afterPathStats)
      || openedStats.size !== afterHandleStats.size
      || openedStats.size !== afterPathStats.size
      || openedStats.mtimeNs !== afterHandleStats.mtimeNs
      || openedStats.mtimeNs !== afterPathStats.mtimeNs
      || !sameResolvedPath(absolutePath, afterCanonicalPath)
    ) {
      fail(CLI_ERROR_CODES.casesFileChanged);
    }

    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      fail(CLI_ERROR_CODES.casesFileInvalidJson);
    }
  } finally {
    await handle.close();
  }
}

export function parseBackstageNotionPartitionCutoverCasesEnvelope(value) {
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== ENVELOPE_KEYS.size
    || Object.keys(value).some(key => !ENVELOPE_KEYS.has(key))
    || value.version !== BACKSTAGE_NOTION_PARTITION_CUTOVER_CASES_FILE_VERSION
    || typeof value.universeId !== 'string'
    || !UNIVERSE_ID_PATTERN.test(value.universeId)
    || FORBIDDEN_IDENTITY_VALUES.has(value.universeId)
    || typeof value.configurationGeneration !== 'string'
    || !GENERATION_PATTERN.test(value.configurationGeneration)
    || FORBIDDEN_IDENTITY_VALUES.has(value.configurationGeneration)
    || typeof value.configurationSemanticDigest !== 'string'
    || !SHA256_PATTERN.test(value.configurationSemanticDigest)
    || !Array.isArray(value.cases)
    || value.cases.length < 3
    || value.cases.length > MAX_CASES
  ) {
    fail(CLI_ERROR_CODES.casesFileInvalid);
  }
  return Object.freeze({
    version: value.version,
    universeId: value.universeId,
    configurationGeneration: value.configurationGeneration,
    configurationSemanticDigest: value.configurationSemanticDigest,
    cases: Object.freeze([...value.cases]),
  });
}

function assertPolicyIsCurrent(envelope, policy) {
  const configuration = policy?.configuration;
  if (
    !isPlainObject(policy)
    || !isPlainObject(configuration)
    || configuration.status !== 'valid'
    || configuration.generation !== envelope.configurationGeneration
    || configuration.semanticDigest !== envelope.configurationSemanticDigest
    || !Array.isArray(configuration.universes)
    || !configuration.universes.some(universe => (
      isPlainObject(universe)
      && universe.universeId === envelope.universeId
    ))
  ) {
    fail(CLI_ERROR_CODES.configurationStale);
  }
  if (
    !isPlainObject(policy.mode)
    || policy.mode.status !== 'valid'
    || policy.mode.mode !== 'shadow'
  ) {
    fail(CLI_ERROR_CODES.modeNotShadow);
  }
}

function normalizeValidatedAt(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === value) {
      return value;
    }
  }
  fail(CLI_ERROR_CODES.validationFailed);
}

function requireBoundedCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    fail(CLI_ERROR_CODES.validationFailed);
  }
  return value;
}

function readSafeValidationCode(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  const code = descriptor?.value;
  return typeof code === 'string' && SAFE_VALIDATION_CODE.test(code)
    ? code
    : null;
}

function buildSuccessReport(envelope, attestation) {
  if (
    !isPlainObject(attestation)
    || attestation.version !== BACKSTAGE_NOTION_PARTITION_CUTOVER_CASES_FILE_VERSION
    || attestation.universeId !== envelope.universeId
    || attestation.partitionConfigurationGeneration
      !== envelope.configurationGeneration
    || attestation.partitionConfigurationHash
      !== envelope.configurationSemanticDigest
    || typeof attestation.attestationDigest !== 'string'
    || !SHA256_PATTERN.test(attestation.attestationDigest)
  ) {
    fail(CLI_ERROR_CODES.validationFailed);
  }
  return Object.freeze({
    schemaVersion: '1.0.0',
    ok: true,
    outcome: 'evidence_sealed',
    operation: OPERATION,
    evidenceSealed: true,
    modeChanged: false,
    universeId: envelope.universeId,
    configurationGeneration: envelope.configurationGeneration,
    configurationSemanticDigest: envelope.configurationSemanticDigest,
    validationVersion: attestation.version,
    attestationDigest: attestation.attestationDigest,
    validatedAt: normalizeValidatedAt(attestation.validatedAt),
    caseCount: requireBoundedCount(attestation.caseCount),
    exactScopeCaseCount: requireBoundedCount(attestation.exactScopeCaseCount),
    relevantCaseCount: requireBoundedCount(attestation.relevantCaseCount),
    completeScopeCaseCount: requireBoundedCount(attestation.completeScopeCaseCount),
    cursorContinuationCaseCount: requireBoundedCount(
      attestation.cursorContinuationCaseCount
    ),
  });
}

function renderFailure(error, evidenceSealed) {
  const validationCode = readSafeValidationCode(error);
  const candidateCode = error instanceof BackstageNotionPartitionCutoverCliError
    ? error.code
    : validationCode
      ? validationCode
      : CLI_ERROR_CODES.validationFailed;
  return JSON.stringify({
    schemaVersion: '1.0.0',
    ok: false,
    outcome: evidenceSealed
      ? 'evidence_sealed_with_post_commit_failure'
      : 'evidence_not_sealed',
    operation: OPERATION,
    evidenceSealed,
    modeChanged: false,
    error: { code: candidateCode },
  });
}

function suppressRuntimeOutput() {
  const consoleMethods = ['debug', 'error', 'info', 'log', 'trace', 'warn'];
  const previousConsoleMethods = new Map(
    consoleMethods.map(method => [method, console[method]])
  );
  const previousStdoutWrite = process.stdout.write;
  const previousStderrWrite = process.stderr.write;
  const discardWrite = () => true;
  for (const method of consoleMethods) {
    console[method] = () => undefined;
  }
  process.stdout.write = discardWrite;
  process.stderr.write = discardWrite;
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    process.stdout.write = previousStdoutWrite;
    process.stderr.write = previousStderrWrite;
    for (const [method, implementation] of previousConsoleMethods) {
      console[method] = implementation;
    }
  };
}

export function createDefaultBackstageNotionPartitionCutoverCliEffects() {
  let databaseModulePromise;
  let openAIAdapter = null;
  const loadDatabaseModule = () => {
    databaseModulePromise ??= import('../dist/core/db/client.js');
    return databaseModulePromise;
  };
  const readCurrentPolicy = async () => {
    const [environment, partitionCore] = await Promise.all([
      import('../dist/platform/runtime/env.js'),
      import('../dist/shared/backstage/backstageNotionPartitionCore.js'),
    ]);
    return Object.freeze({
      configuration: partitionCore.parseBackstageNotionPartitionConfiguration(
        environment.getEnv(partitionCore.BACKSTAGE_NOTION_PARTITIONS_ENV_NAME)
      ),
      mode: partitionCore.parseBackstageNotionPartitionedIndexMode(
        environment.getEnv(
          partitionCore.BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME
        )
      ),
    });
  };
  return Object.freeze({
    suppressRuntimeOutput: true,
    readCasesFile: readBoundedRegularCutoverCasesFile,
    validateInput: async input => {
      const validation = await import(
        '../dist/services/backstageNotionPartitionCutoverValidation.js'
      );
      return validation.validateBackstageNotionPartitionCutoverValidationInput(input);
    },
    readCurrentPolicy,
    initializeDatabase: async () => {
      const database = await loadDatabaseModule();
      return database.initializeDatabase(
        'backstage-notion-partition-cutover-validation-cli'
      );
    },
    initializeOpenAIAdapter: async () => {
      const openai = await import('../dist/services/openaiClient.js');
      openAIAdapter = openai.getConfiguredOpenAIAdapter();
    },
    validateAndPersist: async input => {
      if (!openAIAdapter) {
        fail(CLI_ERROR_CODES.openAiUnavailable);
      }
      const [validation, embeddings] = await Promise.all([
        import('../dist/services/backstageNotionPartitionCutoverEvidence.js'),
        import('../dist/services/openai/embeddings.js'),
      ]);
      return validation.validateAndPersistBackstageNotionPartitionCutover({
        ...input,
        overrides: {
          embedQuery: query => embeddings.createEmbedding(query, openAIAdapter),
          assertRuntimePolicyCurrent: async () => {
            const policy = await readCurrentPolicy();
            assertPolicyIsCurrent({
              universeId: input.universeId,
              configurationGeneration: input.expectedConfiguration.generation,
              configurationSemanticDigest:
                input.expectedConfiguration.semanticDigest,
            }, policy);
          },
        },
      });
    },
    closeDatabase: async () => {
      const database = await loadDatabaseModule();
      await database.close();
    },
  });
}

export async function runBackstageNotionPartitionCutoverValidationCli(options = {}) {
  const stdout = options.stdout ?? (value => process.stdout.write(value));
  const stderr = options.stderr ?? (value => process.stderr.write(value));
  const effects = Object.freeze({
    ...createDefaultBackstageNotionPartitionCutoverCliEffects(),
    ...(options.effects ?? {}),
  });
  const cwd = options.cwd ?? process.cwd();
  let databaseInitializationAttempted = false;
  let evidenceSealed = false;
  let failure = null;
  let report = null;
  let restoreRuntimeOutput = null;

  try {
    const parsed = parseBackstageNotionPartitionCutoverCliArguments(
      options.argv ?? process.argv.slice(2)
    );
    const payload = await effects.readCasesFile(parsed.casesFile, cwd);
    const envelope = parseBackstageNotionPartitionCutoverCasesEnvelope(payload);

    let normalizedInput;
    try {
      normalizedInput = await effects.validateInput({
        universeId: envelope.universeId,
        cases: envelope.cases,
      });
    } catch (error) {
      if (readSafeValidationCode(error)) {
        throw error;
      }
      fail(CLI_ERROR_CODES.casesFileInvalid);
    }
    if (
      !isPlainObject(normalizedInput)
      || normalizedInput.universeId !== envelope.universeId
      || !Array.isArray(normalizedInput.cases)
    ) {
      fail(CLI_ERROR_CODES.casesFileInvalid);
    }

    let policy;
    try {
      policy = await effects.readCurrentPolicy();
    } catch {
      fail(CLI_ERROR_CODES.configurationStale);
    }
    assertPolicyIsCurrent(envelope, policy);

    if (effects.suppressRuntimeOutput === true) {
      restoreRuntimeOutput = suppressRuntimeOutput();
    }

    databaseInitializationAttempted = true;
    let databaseConnected;
    try {
      databaseConnected = await effects.initializeDatabase();
    } catch {
      fail(CLI_ERROR_CODES.databaseUnavailable);
    }
    if (databaseConnected !== true) {
      fail(CLI_ERROR_CODES.databaseUnavailable);
    }

    try {
      await effects.initializeOpenAIAdapter();
    } catch {
      fail(CLI_ERROR_CODES.openAiUnavailable);
    }

    let attestation;
    try {
      attestation = await effects.validateAndPersist({
        universeId: envelope.universeId,
        cases: normalizedInput.cases,
        expectedConfiguration: {
          generation: envelope.configurationGeneration,
          semanticDigest: envelope.configurationSemanticDigest,
        },
      });
    } catch (error) {
      if (readSafeValidationCode(error)) {
        throw error;
      }
      fail(CLI_ERROR_CODES.validationFailed);
    }
    evidenceSealed = true;
    try {
      report = buildSuccessReport(envelope, attestation);
    } catch {
      fail(CLI_ERROR_CODES.reportInvalid);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (databaseInitializationAttempted) {
      try {
        await effects.closeDatabase();
      } catch {
        failure ??= new BackstageNotionPartitionCutoverCliError(
          CLI_ERROR_CODES.databaseCloseFailed
        );
      }
    }
    restoreRuntimeOutput?.();
  }

  if (failure !== null || report === null) {
    stderr(`${renderFailure(failure, evidenceSealed)}\n`);
    return 1;
  }
  stdout(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  process.exitCode = await runBackstageNotionPartitionCutoverValidationCli();
}
