import { constants as fsConstants, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INTEGRITY_MANIFEST,
  type ProtectedConfigId,
  type ProtectedConfigManifestEntry
} from '@platform/runtime/integrityManifest.js';
import {
  CANONICAL_INTEGRITY_DIGEST_VERSION,
  IntegrityPayloadSchemaError,
  assertIntegrityPayloadSchema,
  computeIntegrityHash
} from '@platform/runtime/integrityDigest.js';
import { getEnv } from '@platform/runtime/env.js';
import {
  resolveAssistantRegistryPath,
  resolveDaemonTokensFilePath,
  resolveFallbackMessagesSearchPaths,
  resolvePromptsConfigSearchPaths
} from '@platform/runtime/protectedConfigCandidatePaths.js';

export type ProtectedDigestMode =
  | 'generate'
  | 'check'
  | 'check-pinned'
  | 'precutover';

export type ProtectedDigestErrorCode =
  | 'candidate_required'
  | 'candidate_unavailable'
  | 'duplicate_source'
  | 'expected_hash_required'
  | 'invalid_expected_hash'
  | 'invalid_environment_override'
  | 'invalid_json'
  | 'invalid_source_mapping'
  | 'no_explicit_pins'
  | 'schema_invalid'
  | 'source_changed'
  | 'source_empty'
  | 'source_not_pinned'
  | 'source_not_regular'
  | 'source_not_supported'
  | 'source_too_large'
  | 'source_unavailable'
  | 'structure_too_deep'
  | 'structure_too_large'
  | 'unexpected_argument'
  | 'unknown_protected_id';

export interface ProtectedDigestCommandOptions {
  mode: ProtectedDigestMode;
  id?: ProtectedConfigId;
  sources: Map<ProtectedConfigId, string>;
  expectedHash?: string;
}

export interface ProtectedDigestResult {
  id: ProtectedConfigId;
  expectedHashEnv: string;
  status: 'generated' | 'invalid' | 'match' | 'mismatch' | 'unpinned';
  candidateDigest?: string;
  expectedDigest?: string;
  errorCode?: ProtectedDigestErrorCode;
}

export interface ProtectedDigestReport {
  schemaVersion: '1.0.0';
  canonicalization: typeof CANONICAL_INTEGRITY_DIGEST_VERSION;
  mode: ProtectedDigestMode;
  readOnly: true;
  preCutoverRequired: boolean;
  preCutoverComplete: boolean;
  results: ProtectedDigestResult[];
  summary: {
    manifestEntries: number;
    evaluated: number;
    pinned: number;
    unpinned: number;
    generated: number;
    matched: number;
    mismatched: number;
    invalid: number;
  };
  errorCode?: ProtectedDigestErrorCode;
}

export interface ProtectedDigestExecution {
  exitCode: 0 | 1;
  report: ProtectedDigestReport;
}

export interface ProtectedDigestExecutionContext {
  cwd: string;
  readEnvironment: (name: string) => string | undefined;
}

export interface ProtectedDigestCliOptions extends Partial<ProtectedDigestExecutionContext> {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}

class ProtectedDigestCommandError extends Error {
  constructor(
    readonly code: ProtectedDigestErrorCode,
    readonly protectedId?: ProtectedConfigId
  ) {
    super(code);
    this.name = 'ProtectedDigestCommandError';
  }
}

const EXPECTED_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function isProtectedConfigId(value: string): value is ProtectedConfigId {
  return Object.prototype.hasOwnProperty.call(INTEGRITY_MANIFEST, value);
}

function requireArgumentValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new ProtectedDigestCommandError('unexpected_argument');
  }
  return value;
}

export function parseProtectedDigestArguments(
  argv: string[]
): ProtectedDigestCommandOptions | { help: true } {
  let idValue: string | undefined;
  let expectedHash: string | undefined;
  let checkSelected = false;
  let checkPinned = false;
  let precutover = false;
  let help = false;
  const rawSources: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--id':
        if (idValue !== undefined) {
          throw new ProtectedDigestCommandError('unexpected_argument');
        }
        idValue = requireArgumentValue(argv, index);
        index += 1;
        break;
      case '--source':
        rawSources.push(requireArgumentValue(argv, index));
        index += 1;
        break;
      case '--expected-hash':
        if (expectedHash !== undefined) {
          throw new ProtectedDigestCommandError('unexpected_argument');
        }
        expectedHash = requireArgumentValue(argv, index);
        index += 1;
        break;
      case '--check':
        if (checkSelected) {
          throw new ProtectedDigestCommandError('unexpected_argument');
        }
        checkSelected = true;
        break;
      case '--check-pinned':
        if (checkPinned) {
          throw new ProtectedDigestCommandError('unexpected_argument');
        }
        checkPinned = true;
        break;
      case '--precutover':
        if (precutover) {
          throw new ProtectedDigestCommandError('unexpected_argument');
        }
        precutover = true;
        break;
      default:
        throw new ProtectedDigestCommandError('unexpected_argument');
    }
  }

  if (help) {
    if (argv.length !== 1) {
      throw new ProtectedDigestCommandError('unexpected_argument');
    }
    return { help: true };
  }

  if (checkPinned || precutover) {
    if (
      (checkPinned && precutover)
      || checkSelected
      || idValue !== undefined
      || expectedHash !== undefined
      || (precutover && rawSources.length > 0)
    ) {
      throw new ProtectedDigestCommandError('unexpected_argument');
    }
    const sources = new Map<ProtectedConfigId, string>();
    for (const rawSource of rawSources) {
      const separatorIndex = rawSource.indexOf('=');
      if (separatorIndex <= 0 || separatorIndex === rawSource.length - 1) {
        throw new ProtectedDigestCommandError('invalid_source_mapping');
      }
      const rawId = rawSource.slice(0, separatorIndex);
      const sourcePath = rawSource.slice(separatorIndex + 1);
      if (!isProtectedConfigId(rawId)) {
        throw new ProtectedDigestCommandError('unknown_protected_id');
      }
      if (sources.has(rawId)) {
        throw new ProtectedDigestCommandError('duplicate_source', rawId);
      }
      sources.set(rawId, sourcePath);
    }
    return {
      mode: precutover ? 'precutover' : 'check-pinned',
      sources
    };
  }

  if (!idValue || !isProtectedConfigId(idValue)) {
    throw new ProtectedDigestCommandError(
      idValue ? 'unknown_protected_id' : 'unexpected_argument'
    );
  }
  if (rawSources.length > 1) {
    throw new ProtectedDigestCommandError('duplicate_source', idValue);
  }
  if (!checkSelected && expectedHash !== undefined) {
    throw new ProtectedDigestCommandError('unexpected_argument', idValue);
  }
  const sources = new Map<ProtectedConfigId, string>();
  if (rawSources[0]) {
    sources.set(idValue, rawSources[0]);
  }
  if (expectedHash !== undefined && expectedHash.trim().length === 0) {
    throw new ProtectedDigestCommandError('unexpected_argument', idValue);
  }
  return {
    mode: checkSelected ? 'check' : 'generate',
    id: idValue,
    sources,
    expectedHash
  };
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameResolvedPath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function readBoundedCandidateFile(
  sourcePath: string,
  cwd: string,
  maxBytes: number
): Promise<unknown> {
  const absolutePath = path.resolve(cwd, sourcePath);
  let beforePathStats: BigIntStats;
  try {
    beforePathStats = await fs.lstat(absolutePath, { bigint: true });
  } catch {
    throw new ProtectedDigestCommandError('source_unavailable');
  }

  if (beforePathStats.isSymbolicLink() || !beforePathStats.isFile()) {
    throw new ProtectedDigestCommandError('source_not_regular');
  }
  if (beforePathStats.size <= 0n) {
    throw new ProtectedDigestCommandError('source_empty');
  }
  if (beforePathStats.size > BigInt(maxBytes)) {
    throw new ProtectedDigestCommandError('source_too_large');
  }

  try {
    const canonicalPath = await fs.realpath(absolutePath);
    if (!sameResolvedPath(absolutePath, canonicalPath)) {
      throw new ProtectedDigestCommandError('source_not_regular');
    }
  } catch (error) {
    if (error instanceof ProtectedDigestCommandError) {
      throw error;
    }
    throw new ProtectedDigestCommandError('source_unavailable');
  }

  const noFollowFlag = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | noFollowFlag);
  } catch (error) {
    throw new ProtectedDigestCommandError(
      isNodeError(error) && error.code === 'ELOOP'
        ? 'source_not_regular'
        : 'source_unavailable'
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
      throw new ProtectedDigestCommandError('source_changed');
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
      throw new ProtectedDigestCommandError('source_changed');
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
      throw new ProtectedDigestCommandError('source_changed');
    }

    // Match the runtime consumers' Node UTF-8 decoding exactly. In particular,
    // Buffer decoding preserves a leading BOM so JSON.parse rejects it instead
    // of tooling accepting a candidate that runtime loading will refuse.
    const decoded = bytes.toString('utf8');
    try {
      return JSON.parse(decoded) as unknown;
    } catch {
      throw new ProtectedDigestCommandError('invalid_json');
    }
  } finally {
    await handle.close();
  }
}

function assertStructureBounds(
  payload: unknown,
  maxDepth: number,
  maxNodes: number
): void {
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: payload }];
  const visited = new WeakSet<object>();
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    nodeCount += 1;
    if (nodeCount > maxNodes) {
      throw new ProtectedDigestCommandError('structure_too_large');
    }
    if (current.depth > maxDepth) {
      throw new ProtectedDigestCommandError('structure_too_deep');
    }
    if (
      typeof current.value === 'number'
      && !Number.isFinite(current.value)
    ) {
      throw new ProtectedDigestCommandError('schema_invalid');
    }
    if (!current.value || typeof current.value !== 'object') {
      continue;
    }
    if (visited.has(current.value)) {
      throw new ProtectedDigestCommandError('structure_too_large');
    }
    visited.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ depth: current.depth + 1, value: child });
    }
  }
}

async function selectFirstExistingPath(
  candidatePaths: readonly string[]
): Promise<string> {
  const fallbackPath = candidatePaths[0];
  if (!fallbackPath) {
    throw new ProtectedDigestCommandError('candidate_required');
  }
  for (const candidatePath of candidatePaths) {
    try {
      await fs.lstat(candidatePath);
      return candidatePath;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        return candidatePath;
      }
    }
  }
  return fallbackPath;
}

async function resolveCandidatePayload(
  entry: ProtectedConfigManifestEntry,
  sourceOverride: string | undefined,
  context: ProtectedDigestExecutionContext
): Promise<unknown> {
  const source = entry.candidateSource;
  switch (source.kind) {
    case 'dispatch_runtime': {
      if (sourceOverride) {
        throw new ProtectedDigestCommandError('source_not_supported', entry.id);
      }
      const { getDispatchPatternIntegrityPayload } = await import(
        '@platform/runtime/dispatchPatternPayload.js'
      );
      return getDispatchPatternIntegrityPayload();
    }
    case 'gpt_router_catalog': {
      if (sourceOverride) {
        throw new ProtectedDigestCommandError('source_not_supported', entry.id);
      }
      const { buildGptModuleMapCandidate } = await import(
        '@platform/runtime/gptRouterCandidate.js'
      );
      return buildGptModuleMapCandidate({
        onInvalidOverride: () => {
          throw new ProtectedDigestCommandError(
            'invalid_environment_override',
            entry.id
          );
        },
        readEnvironment: context.readEnvironment
      });
    }
    case 'runtime_json_file': {
      let candidatePath = sourceOverride;
      if (!candidatePath) {
        const runtimePaths = (() => {
          switch (source.resolver) {
            case 'assistant_registry':
              return [resolveAssistantRegistryPath(
                context.readEnvironment('ASSISTANT_REGISTRY_PATH'),
                context.cwd
              )];
            case 'daemon_tokens':
              return [resolveDaemonTokensFilePath(
                context.readEnvironment('DAEMON_TOKENS_FILE'),
                context.cwd
              )];
            case 'fallback_messages':
              return resolveFallbackMessagesSearchPaths(context.cwd);
            case 'prompts_config':
              return resolvePromptsConfigSearchPaths(context.cwd);
          }
        })();
        candidatePath = await selectFirstExistingPath(runtimePaths);
      }
      return readBoundedCandidateFile(candidatePath, context.cwd, source.bounds.maxBytes);
    }
    case 'explicit_json_file': {
      if (!sourceOverride) {
        throw new ProtectedDigestCommandError('candidate_required', entry.id);
      }
      return readBoundedCandidateFile(sourceOverride, context.cwd, source.bounds.maxBytes);
    }
  }
}

function resolvePinnedHash(
  entry: ProtectedConfigManifestEntry,
  readEnvironment: (name: string) => string | undefined
): string | undefined {
  const environmentHash = readEnvironment(entry.expectedHashEnv)?.trim();
  if (environmentHash) {
    return environmentHash;
  }
  const builtInHash = entry.builtInExpectedHash?.trim();
  return builtInHash || undefined;
}

function invalidResult(
  entry: ProtectedConfigManifestEntry,
  code: ProtectedDigestErrorCode,
  expectedDigest?: string
): ProtectedDigestResult {
  return {
    id: entry.id,
    expectedHashEnv: entry.expectedHashEnv,
    status: 'invalid',
    ...(expectedDigest ? { expectedDigest } : {}),
    errorCode: code
  };
}

async function evaluateEntry(
  entry: ProtectedConfigManifestEntry,
  expectedDigest: string | undefined,
  sourceOverride: string | undefined,
  context: ProtectedDigestExecutionContext
): Promise<ProtectedDigestResult> {
  if (expectedDigest && !EXPECTED_HASH_PATTERN.test(expectedDigest)) {
    return invalidResult(entry, 'invalid_expected_hash');
  }

  let payload: unknown;
  try {
    payload = await resolveCandidatePayload(entry, sourceOverride, context);
    assertStructureBounds(
      payload,
      entry.candidateSource.bounds.maxDepth,
      entry.candidateSource.bounds.maxNodes
    );
    assertIntegrityPayloadSchema(entry.schema, payload);
  } catch (error) {
    if (error instanceof IntegrityPayloadSchemaError) {
      return invalidResult(entry, 'schema_invalid', expectedDigest);
    }
    if (error instanceof ProtectedDigestCommandError) {
      return invalidResult(entry, error.code, expectedDigest);
    }
    return invalidResult(entry, 'candidate_unavailable', expectedDigest);
  }

  const candidateDigest = computeIntegrityHash(payload);
  if (!expectedDigest) {
    return {
      id: entry.id,
      expectedHashEnv: entry.expectedHashEnv,
      status: 'generated',
      candidateDigest
    };
  }
  return {
    id: entry.id,
    expectedHashEnv: entry.expectedHashEnv,
    status: candidateDigest === expectedDigest ? 'match' : 'mismatch',
    candidateDigest,
    expectedDigest
  };
}

function buildReport(
  mode: ProtectedDigestMode,
  results: ProtectedDigestResult[],
  manifestEntries: number,
  noExplicitPins: boolean
): ProtectedDigestExecution {
  const summary = {
    manifestEntries,
    evaluated: results.filter(
      result => result.status !== 'unpinned' || result.candidateDigest !== undefined
    ).length,
    pinned: results.filter(result => result.expectedDigest || result.errorCode === 'invalid_expected_hash').length,
    unpinned: results.filter(result => result.status === 'unpinned').length,
    generated: results.filter(result => result.status === 'generated').length,
    matched: results.filter(result => result.status === 'match').length,
    mismatched: results.filter(result => result.status === 'mismatch').length,
    invalid: results.filter(result => result.status === 'invalid').length
  };
  const preCutoverComplete =
    mode === 'precutover' && noExplicitPins
      ? true
      : (mode === 'check-pinned' || mode === 'precutover')
        && !noExplicitPins
        && summary.mismatched === 0
        && summary.invalid === 0
        && summary.matched === summary.pinned;
  const preCutoverRequired =
    (mode === 'check-pinned' || mode === 'precutover')
    && !noExplicitPins;
  const failed =
    summary.invalid > 0
    || summary.mismatched > 0
    || (mode === 'check-pinned' && noExplicitPins)
    || (mode === 'check' && summary.matched !== 1);
  const reportResults = mode === 'precutover'
    ? results.map((result): ProtectedDigestResult => ({
        id: result.id,
        expectedHashEnv: result.expectedHashEnv,
        status: result.status,
        ...(result.errorCode ? { errorCode: result.errorCode } : {})
      }))
    : results;

  return {
    exitCode: failed ? 1 : 0,
    report: {
      schemaVersion: '1.0.0',
      canonicalization: CANONICAL_INTEGRITY_DIGEST_VERSION,
      mode,
      readOnly: true,
      preCutoverRequired,
      preCutoverComplete,
      results: reportResults,
      summary,
      ...(mode === 'check-pinned' && noExplicitPins
        ? { errorCode: 'no_explicit_pins' as const }
        : {})
    }
  };
}

export async function executeProtectedDigestCommand(
  options: ProtectedDigestCommandOptions,
  context: ProtectedDigestExecutionContext = {
    cwd: process.cwd(),
    readEnvironment: getEnv
  }
): Promise<ProtectedDigestExecution> {
  const manifestEntries = (Object.values(INTEGRITY_MANIFEST) as ProtectedConfigManifestEntry[])
    .sort((left, right) => left.id.localeCompare(right.id));
  const selectedEntries = options.mode === 'precutover'
    ? manifestEntries.filter(entry => entry.runtimeOwned)
    : manifestEntries;

  for (const sourceId of options.sources.keys()) {
    if (!isProtectedConfigId(sourceId)) {
      throw new ProtectedDigestCommandError('unknown_protected_id');
    }
  }

  if (options.mode === 'check-pinned' || options.mode === 'precutover') {
    const results: ProtectedDigestResult[] = [];
    let explicitPinCount = 0;
    for (const entry of selectedEntries) {
      const expectedDigest = resolvePinnedHash(entry, context.readEnvironment);
      const sourceOverride = options.sources.get(entry.id);
      if (!expectedDigest) {
        if (sourceOverride) {
          results.push(invalidResult(entry, 'source_not_pinned'));
        } else {
          results.push({
            id: entry.id,
            expectedHashEnv: entry.expectedHashEnv,
            status: 'unpinned'
          });
        }
        continue;
      }
      explicitPinCount += 1;
      if (sourceOverride && entry.candidateSource.kind !== 'explicit_json_file') {
        results.push(invalidResult(entry, 'source_not_supported', expectedDigest));
        continue;
      }
      results.push(await evaluateEntry(entry, expectedDigest, sourceOverride, context));
    }
    return buildReport(
      options.mode,
      results,
      selectedEntries.length,
      explicitPinCount === 0
    );
  }

  const entry = options.id ? INTEGRITY_MANIFEST[options.id] : undefined;
  if (!entry) {
    throw new ProtectedDigestCommandError('unknown_protected_id');
  }
  const ambientHash = resolvePinnedHash(entry, context.readEnvironment);
  const expectedDigest = options.mode === 'generate'
    ? undefined
    : options.expectedHash !== undefined
      ? options.expectedHash.trim()
      : ambientHash;
  if (options.mode === 'check' && !expectedDigest) {
    const result = invalidResult(entry, 'expected_hash_required');
    return buildReport(options.mode, [result], manifestEntries.length, false);
  }
  const result = await evaluateEntry(
    entry,
    expectedDigest,
    options.sources.get(entry.id),
    context
  );
  return buildReport(options.mode, [result], manifestEntries.length, false);
}

function renderHelp(): string {
  return [
    'Protected configuration semantic digest tool (read-only).',
    '',
    'Generate one candidate:',
    '  --id <protected-id> [--source <json-path>]',
    '',
    'Compare one candidate:',
    '  --id <protected-id> [--source <json-path>] --check [--expected-hash <sha256>]',
    '',
    'Complete pre-cutover comparison against explicit environment/built-in pins:',
    '  --check-pinned [--source <protected-id>=<json-path>]...',
    '',
    'Startup gate (evaluates the six runtime-owned pins; skips when none are configured):',
    '  --precutover',
    '',
    'The command never writes candidates, pins, runtime state, or provider state.'
  ].join('\n');
}

function renderCommandError(error: ProtectedDigestCommandError): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    readOnly: true,
    error: {
      code: error.code,
      ...(error.protectedId ? { id: error.protectedId } : {})
    }
  });
}

export async function runProtectedDigestCli(
  options: ProtectedDigestCliOptions = {}
): Promise<0 | 1> {
  const stdout = options.stdout ?? (value => process.stdout.write(value));
  const stderr = options.stderr ?? (value => process.stderr.write(value));
  try {
    const parsed = parseProtectedDigestArguments(options.argv ?? process.argv.slice(2));
    if ('help' in parsed) {
      stdout(`${renderHelp()}\n`);
      return 0;
    }
    const execution = await executeProtectedDigestCommand(parsed, {
      cwd: options.cwd ?? process.cwd(),
      readEnvironment: options.readEnvironment
        ?? (options.env ? name => options.env?.[name] : getEnv)
    });
    stdout(`${JSON.stringify(execution.report, null, 2)}\n`);
    return execution.exitCode;
  } catch (error) {
    const commandError = error instanceof ProtectedDigestCommandError
      ? error
      : new ProtectedDigestCommandError('candidate_unavailable');
    stderr(`${renderCommandError(commandError)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  process.exitCode = await runProtectedDigestCli();
}
