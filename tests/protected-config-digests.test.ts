import { createHash } from 'node:crypto';
import fs, {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  CANONICAL_INTEGRITY_DIGEST_VERSION,
  computeIntegrityHash
} from '../src/platform/runtime/integrityDigest.js';
import { INTEGRITY_MANIFEST } from '../src/platform/runtime/integrityManifest.js';
import {
  executeProtectedDigestCommand,
  parseProtectedDigestArguments,
  runProtectedDigestCli
} from '../src/core/commands/protectedDigest.js';
import {
  DISPATCH_PATTERN_BINDINGS,
  DISPATCH_V9_EXEMPT_ROUTES,
  getDispatchPatternIntegrityPayload
} from '../src/platform/runtime/dispatchPatternPayload.js';
import { buildGptModuleMapCandidate } from '../src/platform/runtime/gptRouterCandidate.js';
import { resolveGptModuleMapEntry } from '../src/shared/gpt/gptModuleMapResolution.js';

const REPOSITORY_ROOT = resolve(process.cwd());
const createdDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-protected-digest-'));
  createdDirectories.push(directory);
  return directory;
}

function writeJson(directory: string, name: string, payload: unknown): string {
  const filePath = join(directory, name);
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function isolatedEnvironment(
  values: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of Object.values(INTEGRITY_MANIFEST)) {
    Reflect.deleteProperty(environment, entry.expectedHashEnv);
  }
  for (const name of [
    'ASSISTANT_REGISTRY_PATH',
    'DAEMON_TOKENS_FILE',
    'GPT_MODULE_MAP',
    'GPTID_ARCANOS_GAMING',
    'GPTID_ARCANOS_TUTOR',
    'GPTID_BACKSTAGE_BOOKER'
  ]) {
    Reflect.deleteProperty(environment, name);
  }
  return { ...environment, ...values };
}

function readEnvironment(
  environment: NodeJS.ProcessEnv
): (name: string) => string | undefined {
  return name => environment[name];
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('canonical protected-config digests', () => {
  it('preserves the existing semantic JSON canonicalization contract', () => {
    const left = {
      zeta: ['first', 'second'],
      alpha: { right: 2, left: 1 }
    };
    const reordered = {
      alpha: { left: 1, right: 2 },
      zeta: ['first', 'second']
    };

    expect(CANONICAL_INTEGRITY_DIGEST_VERSION).toBe('arcanos-semantic-json-v1');
    expect(computeIntegrityHash(left)).toBe(computeIntegrityHash(reordered));
    expect(computeIntegrityHash(left)).not.toBe(
      computeIntegrityHash({ ...reordered, zeta: ['second', 'first'] })
    );
    expect(computeIntegrityHash(JSON.parse('{\n  "alpha": {"left": 1, "right": 2}, "zeta": ["first", "second"]\n}')))
      .toBe(computeIntegrityHash(left));
  });

  it('uses the complete dispatch payload rather than its bindings-only version hash', () => {
    const payload = getDispatchPatternIntegrityPayload();

    expect(payload).toEqual({
      bindings: DISPATCH_PATTERN_BINDINGS,
      exemptRoutes: DISPATCH_V9_EXEMPT_ROUTES
    });
    expect(computeIntegrityHash(payload)).not.toBe(
      createHash('sha256').update(JSON.stringify(DISPATCH_PATTERN_BINDINGS)).digest('hex')
    );
  });

  it('reports every manifest entry and fails a stale explicit pin without leaking candidates', async () => {
    const directory = createTemporaryDirectory();
    const secretSentinel = 'daemon-secret-sentinel-never-print';
    const daemonPayload = { daemon_alpha: secretSentinel };
    const genericPayload = { mode: 'strict', nested: { enabled: true } };
    const daemonSource = writeJson(directory, 'daemon tokens.json', daemonPayload);
    const genericSource = writeJson(directory, 'generic.json', genericPayload);
    const beforeFiles = readdirSync(directory).sort();
    const beforeDaemonBytes = readFileSync(daemonSource);
    const beforeGenericBytes = readFileSync(genericSource);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const synchronousWriteSpy = jest.spyOn(fs, 'writeFileSync');
    const asynchronousWriteSpy = jest.spyOn(fs.promises, 'writeFile');

    let exitCode: 0 | 1 = 1;
    let synchronousWriteCount = -1;
    let asynchronousWriteCount = -1;
    try {
      exitCode = await runProtectedDigestCli({
        argv: [
          '--check-pinned',
          '--source',
          `protected_json_file=${genericSource}`
        ],
        cwd: REPOSITORY_ROOT,
        env: isolatedEnvironment({
          DAEMON_TOKENS_FILE: daemonSource,
          SAFETY_EXPECTED_HASH_DAEMON_TOKENS: computeIntegrityHash(daemonPayload),
          SAFETY_EXPECTED_HASH_PROTECTED_JSON: '0'.repeat(64)
        }),
        stdout: value => stdout.push(value),
        stderr: value => stderr.push(value)
      });
      synchronousWriteCount = synchronousWriteSpy.mock.calls.length;
      asynchronousWriteCount = asynchronousWriteSpy.mock.calls.length;
    } finally {
      synchronousWriteSpy.mockRestore();
      asynchronousWriteSpy.mockRestore();
    }

    const rendered = `${stdout.join('')}\n${stderr.join('')}`;
    const report = JSON.parse(stdout.join('')) as {
      canonicalization: string;
      results: Array<{ id: string; status: string }>;
      summary: Record<string, number>;
    };

    expect(exitCode).toBe(1);
    expect(report.canonicalization).toBe(CANONICAL_INTEGRITY_DIGEST_VERSION);
    expect(report.results).toHaveLength(Object.keys(INTEGRITY_MANIFEST).length);
    expect(report.results.map(result => result.id)).toEqual(
      [...Object.keys(INTEGRITY_MANIFEST)].sort((left, right) => left.localeCompare(right))
    );
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'daemon_tokens', status: 'match' }),
      expect.objectContaining({ id: 'protected_json_file', status: 'mismatch' })
    ]));
    expect(report.summary).toMatchObject({
      manifestEntries: 7,
      evaluated: 2,
      pinned: 2,
      matched: 1,
      mismatched: 1,
      unpinned: 5
    });
    expect(rendered).not.toContain(secretSentinel);
    expect(rendered).not.toContain(directory);
    expect(rendered).not.toContain('daemon tokens.json');
    expect(readdirSync(directory).sort()).toEqual(beforeFiles);
    expect(readFileSync(daemonSource)).toEqual(beforeDaemonBytes);
    expect(readFileSync(genericSource)).toEqual(beforeGenericBytes);
    expect(synchronousWriteCount).toBe(0);
    expect(asynchronousWriteCount).toBe(0);
  });

  it('fails closed when an explicit pin has no resolvable candidate', async () => {
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: createTemporaryDirectory(),
        readEnvironment: readEnvironment(isolatedEnvironment({
          SAFETY_EXPECTED_HASH_PROTECTED_JSON: 'a'.repeat(64)
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'protected_json_file',
        status: 'invalid',
        errorCode: 'candidate_required'
      })
    ]));
    expect(execution.report.preCutoverComplete).toBe(false);
  });

  it('rejects a pre-cutover comparison with no explicit pins', async () => {
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(isolatedEnvironment())
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.errorCode).toBe('no_explicit_pins');
    expect(execution.report.results).toHaveLength(Object.keys(INTEGRITY_MANIFEST).length);
    expect(execution.report.summary).toMatchObject({ pinned: 0, unpinned: 7 });
    expect(execution.report.preCutoverComplete).toBe(false);
  });

  it('lets the startup gate skip when no runtime-owned pins are configured', async () => {
    const execution = await executeProtectedDigestCommand(
      { mode: 'precutover', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(isolatedEnvironment())
      }
    );

    expect(execution.exitCode).toBe(0);
    expect(execution.report.preCutoverRequired).toBe(false);
    expect(execution.report.preCutoverComplete).toBe(true);
    expect(execution.report.results).toHaveLength(6);
    expect(execution.report.summary).toMatchObject({
      manifestEntries: 6,
      pinned: 0,
      unpinned: 6
    });
    expect(execution.report).not.toHaveProperty('errorCode');
  });

  it('leaves the tooling-only generic pin to explicit manual comparison', async () => {
    const execution = await executeProtectedDigestCommand(
      { mode: 'precutover', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(isolatedEnvironment({
          SAFETY_EXPECTED_HASH_PROTECTED_JSON: 'a'.repeat(64)
        }))
      }
    );

    expect(execution.exitCode).toBe(0);
    expect(execution.report.preCutoverRequired).toBe(false);
    expect(execution.report.preCutoverComplete).toBe(true);
    expect(execution.report.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'protected_json_file' })
    ]));
  });

  it('redacts digests from automatic startup-gate reports', async () => {
    const execution = await executeProtectedDigestCommand(
      { mode: 'precutover', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(isolatedEnvironment({
          SAFETY_EXPECTED_HASH_DISPATCH_PATTERNS: computeIntegrityHash(
            getDispatchPatternIntegrityPayload()
          )
        }))
      }
    );

    expect(execution.exitCode).toBe(0);
    const result = execution.report.results.find(
      entry => entry.id === 'dispatch_patterns'
    );
    expect(result).toMatchObject({ status: 'match' });
    expect(result).not.toHaveProperty('candidateDigest');
    expect(result).not.toHaveProperty('expectedDigest');
  });

  it('rejects non-canonical explicit pin syntax before resolving a candidate', async () => {
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(isolatedEnvironment({
          SAFETY_EXPECTED_HASH_DISPATCH_PATTERNS: 'A'.repeat(64)
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'dispatch_patterns',
        status: 'invalid',
        errorCode: 'invalid_expected_hash'
      })
    ]));
  });

  it('derives the effective GPT candidate from the catalog and supplied environment only', async () => {
    const gptModuleMap = JSON.stringify({
      'operator-tutor': { route: 'tutor', module: 'ARCANOS:TUTOR' }
    });
    const candidateEnvironment = isolatedEnvironment({ GPT_MODULE_MAP: gptModuleMap });
    const candidate = await buildGptModuleMapCandidate({
      readEnvironment: readEnvironment(candidateEnvironment)
    });
    const candidateDigest = computeIntegrityHash(candidate);
    const comparisonEnvironment = {
      ...candidateEnvironment,
      SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG: candidateDigest
    };

    expect(candidate['operator-tutor']).toEqual({
      route: 'tutor',
      module: 'ARCANOS:TUTOR'
    });

    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(comparisonEnvironment)
      }
    );

    expect(execution.exitCode).toBe(0);
    expect(execution.report.preCutoverComplete).toBe(true);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt_router_config', status: 'match' })
    ]));
  });

  it('fails a malformed GPT_MODULE_MAP instead of hashing the default map', async () => {
    const cleanCandidate = await buildGptModuleMapCandidate({
      readEnvironment: readEnvironment(isolatedEnvironment())
    });
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(isolatedEnvironment({
          GPT_MODULE_MAP: '{',
          SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG:
            computeIntegrityHash(cleanCandidate)
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gpt_router_config',
        status: 'invalid',
        errorCode: 'invalid_environment_override'
      })
    ]));
  });

  it.each([
    {
      name: 'partially invalid map entry',
      overrides: {
        GPT_MODULE_MAP: JSON.stringify({
          valid: { route: 'tutor', module: 'ARCANOS:TUTOR' },
          invalid: { route: 'missing', module: 'ARCANOS:MISSING' }
        })
      }
    },
    {
      name: 'protected legacy alias',
      overrides: { GPTID_ARCANOS_TUTOR: 'cli' }
    }
  ])('fails a $name instead of silently hashing defaults', async ({ overrides }) => {
    const cleanCandidate = await buildGptModuleMapCandidate({
      readEnvironment: readEnvironment(isolatedEnvironment())
    });
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(isolatedEnvironment({
          ...overrides,
          SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG:
            computeIntegrityHash(cleanCandidate)
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gpt_router_config',
        status: 'invalid',
        errorCode: 'invalid_environment_override'
      })
    ]));
  });

  it('captures prototype-named GPT aliases in the digest and resolves only own entries', async () => {
    const cleanEnvironment = isolatedEnvironment();
    const cleanCandidate = await buildGptModuleMapCandidate({
      readEnvironment: readEnvironment(cleanEnvironment)
    });
    const configuredEnvironment = isolatedEnvironment({
      GPT_MODULE_MAP:
        '{"__proto__":{"route":"tutor","module":"ARCANOS:TUTOR"}}'
    });
    const configuredCandidate = await buildGptModuleMapCandidate({
      readEnvironment: readEnvironment(configuredEnvironment)
    });

    expect(Object.getPrototypeOf(configuredCandidate)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(configuredCandidate, '__proto__')).toBe(true);
    expect(computeIntegrityHash(configuredCandidate)).not.toBe(
      computeIntegrityHash(cleanCandidate)
    );
    expect(resolveGptModuleMapEntry('__proto__', configuredCandidate)).toEqual({
      entry: { route: 'tutor', module: 'ARCANOS:TUTOR' },
      matchMethod: 'exact',
      matchedId: '__proto__'
    });
    expect(resolveGptModuleMapEntry('__proto__', {})).toBeNull();
  });

  it('generates a candidate independently of an ambient stale pin', async () => {
    const directory = createTemporaryDirectory();
    const payload = { daemon_alpha: 'candidate-value' };
    const source = writeJson(directory, 'daemon.json', payload);
    const execution = await executeProtectedDigestCommand(
      {
        mode: 'generate',
        id: 'daemon_tokens',
        sources: new Map([['daemon_tokens', source]])
      },
      {
        cwd: directory,
        readEnvironment: readEnvironment(isolatedEnvironment({
          SAFETY_EXPECTED_HASH_DAEMON_TOKENS: 'f'.repeat(64)
        }))
      }
    );

    expect(execution.exitCode).toBe(0);
    expect(execution.report.results).toEqual([
      expect.objectContaining({
        id: 'daemon_tokens',
        status: 'generated',
        candidateDigest: computeIntegrityHash(payload)
      })
    ]);
    expect(execution.report.summary.evaluated).toBe(1);
  });

  it.each([
    {
      id: 'prompts_config',
      pin: 'SAFETY_EXPECTED_HASH_PROMPTS',
      relativePath: join('config', 'prompts.json')
    },
    {
      id: 'fallback_messages',
      pin: 'SAFETY_EXPECTED_HASH_FALLBACK_MESSAGES',
      relativePath: join('config', 'fallbackMessages.json')
    },
    {
      id: 'assistant_registry',
      pin: 'SAFETY_EXPECTED_HASH_ASSISTANT_REGISTRY',
      relativePath: join('config', 'assistants.json')
    }
  ] as const)('matches the runtime-selected valid $id candidate', async ({
    id,
    pin,
    relativePath
  }) => {
    const payload = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8')
    ) as unknown;
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: REPOSITORY_ROOT,
        readEnvironment: readEnvironment(isolatedEnvironment({
          [pin]: computeIntegrityHash(payload)
        }))
      }
    );

    expect(execution.exitCode).toBe(0);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, status: 'match' })
    ]));
  });

  it('rejects a schema-invalid candidate before producing its digest', async () => {
    const directory = createTemporaryDirectory();
    const source = writeJson(directory, 'invalid-daemon.json', { daemon_alpha: 42 });
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: directory,
        readEnvironment: readEnvironment(isolatedEnvironment({
          DAEMON_TOKENS_FILE: source,
          SAFETY_EXPECTED_HASH_DAEMON_TOKENS: 'b'.repeat(64)
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'daemon_tokens',
        status: 'invalid',
        errorCode: 'schema_invalid'
      })
    ]));
    const daemonResult = execution.report.results.find(result => result.id === 'daemon_tokens');
    expect(daemonResult).not.toHaveProperty('candidateDigest');
  });

  it('shares the runtime assistant tools validator and rejects object-shaped tools', async () => {
    const directory = createTemporaryDirectory();
    const source = writeJson(directory, 'assistants.json', {
      ALPHA: {
        id: 'asst_alpha',
        name: 'Alpha',
        instructions: null,
        tools: {},
        model: 'gpt-4.1-mini',
        normalizedName: 'ALPHA'
      }
    });
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: directory,
        readEnvironment: readEnvironment(isolatedEnvironment({
          ASSISTANT_REGISTRY_PATH: source,
          SAFETY_EXPECTED_HASH_ASSISTANT_REGISTRY: 'd'.repeat(64)
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'assistant_registry',
        status: 'invalid',
        errorCode: 'schema_invalid'
      })
    ]));
  });

  it('does not let pre-cutover source overrides replace runtime-owned paths', async () => {
    const directory = createTemporaryDirectory();
    const runtimeSource = writeJson(directory, 'runtime.json', {
      daemon_alpha: 'runtime-value'
    });
    const unrelatedSource = writeJson(directory, 'unrelated.json', {
      daemon_alpha: 'known-good-value'
    });
    const execution = await executeProtectedDigestCommand(
      {
        mode: 'check-pinned',
        sources: new Map([['daemon_tokens', unrelatedSource]])
      },
      {
        cwd: directory,
        readEnvironment: readEnvironment(isolatedEnvironment({
          DAEMON_TOKENS_FILE: runtimeSource,
          SAFETY_EXPECTED_HASH_DAEMON_TOKENS: computeIntegrityHash({
            daemon_alpha: 'known-good-value'
          })
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'daemon_tokens',
        status: 'invalid',
        errorCode: 'source_not_supported'
      })
    ]));
  });

  it('preserves nonblank path-environment whitespace exactly like runtime', async () => {
    const directory = createTemporaryDirectory();
    const setting = ' daemon tokens.json ';
    const payload = { daemon_alpha: 'spaced-path-value' };
    writeJson(directory, setting, payload);
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: directory,
        readEnvironment: readEnvironment(isolatedEnvironment({
          DAEMON_TOKENS_FILE: setting,
          SAFETY_EXPECTED_HASH_DAEMON_TOKENS: computeIntegrityHash(payload)
        }))
      }
    );

    expect(execution.exitCode).toBe(0);
    expect(execution.report.preCutoverComplete).toBe(true);
  });

  it('rejects a UTF-8 BOM exactly as the runtime JSON readers do', async () => {
    const directory = createTemporaryDirectory();
    const source = join(directory, 'bom-daemon.json');
    writeFileSync(source, '\uFEFF{"daemon_alpha":"value"}\n', 'utf8');
    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: directory,
        readEnvironment: readEnvironment(isolatedEnvironment({
          DAEMON_TOKENS_FILE: source,
          SAFETY_EXPECTED_HASH_DAEMON_TOKENS: 'b'.repeat(64)
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'daemon_tokens',
        status: 'invalid',
        errorCode: 'invalid_json'
      })
    ]));
  });

  it('rejects symlink candidates without disclosing their target', async () => {
    const directory = createTemporaryDirectory();
    const target = writeJson(directory, 'secret-target.json', { daemon_alpha: 'hidden-value' });
    const link = join(directory, 'candidate-link.json');
    try {
      symlinkSync(target, link, 'file');
    } catch {
      return;
    }

    const execution = await executeProtectedDigestCommand(
      { mode: 'check-pinned', sources: new Map() },
      {
        cwd: directory,
        readEnvironment: readEnvironment(isolatedEnvironment({
          DAEMON_TOKENS_FILE: link,
          SAFETY_EXPECTED_HASH_DAEMON_TOKENS: 'c'.repeat(64)
        }))
      }
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'daemon_tokens',
        status: 'invalid',
        errorCode: 'source_not_regular'
      })
    ]));
    expect(JSON.stringify(execution.report)).not.toContain(target);
    expect(JSON.stringify(execution.report)).not.toContain('hidden-value');
  });

  it('exposes the canonical compiled package commands', () => {
    const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['integrity:protected-digest']).toBe(
      'npm run build && node --import ./scripts/register-esm-loader.mjs dist/core/commands/protectedDigest.js'
    );
    expect(packageJson.scripts['integrity:protected-digest:check']).toBe(
      'npm run integrity:protected-digest -- --check-pinned'
    );
    expect(packageJson.scripts['integrity:protected-digest:compiled']).toBe(
      'node --import ./scripts/register-esm-loader.mjs dist/core/commands/protectedDigest.js'
    );
    expect(packageJson.scripts['integrity:protected-digest:check:compiled']).toBe(
      'npm run integrity:protected-digest:compiled -- --check-pinned'
    );
    expect(packageJson.scripts['integrity:protected-digest:precutover']).toBe(
      'npm run integrity:protected-digest:compiled -- --precutover'
    );
  });

  it('rejects comparison-only arguments in generation mode', () => {
    expect(() => parseProtectedDigestArguments([
      '--id',
      'dispatch_patterns',
      '--expected-hash',
      'a'.repeat(64)
    ])).toThrow('unexpected_argument');
    expect(() => parseProtectedDigestArguments([
      '--id',
      'dispatch_patterns',
      '--check',
      '--check'
    ])).toThrow('unexpected_argument');
    expect(() => parseProtectedDigestArguments([
      '--check-pinned',
      '--check-pinned'
    ])).toThrow('unexpected_argument');
    expect(() => parseProtectedDigestArguments([
      '--precutover',
      '--source',
      'daemon_tokens=ignored.json'
    ])).toThrow('unexpected_argument');
  });
});
