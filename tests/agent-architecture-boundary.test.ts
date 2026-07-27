import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, jest } from '@jest/globals';
import {
  findCircularDependencies,
  findLayerAccessViolations,
  getProtectedLayerFiles,
  runBoundaryChecks,
  scanFileForLayerAccessViolations
} from '../scripts/check-boundaries.js';

describe('agent boundary architecture', () => {
  it('prevents planner modules from importing infrastructure directly', () => {
    const plannerViolations = findLayerAccessViolations().filter(violation =>
      /planner/i.test(violation.filePath)
    );

    //audit Assumption: planner modules must remain infrastructure-blind so every side effect flows through capability -> CEF; failure risk: direct infra imports bypass validation, tracing, and handler allowlists; expected invariant: no planner file triggers the boundary scanner; handling strategy: fail on any planner violation.
    expect(plannerViolations).toEqual([]);
  });

  it('prevents capability modules from importing infrastructure directly', () => {
    const capabilityViolations = findLayerAccessViolations().filter(violation =>
      /capability/i.test(violation.filePath)
    );

    //audit Assumption: capability modules may translate goals to commands but must not touch infrastructure directly; failure risk: capability code bypasses CEF schema validation and durable tracing; expected invariant: no capability file triggers the boundary scanner; handling strategy: fail on any capability violation.
    expect(capabilityViolations).toEqual([]);
  });

  it('flags blocked planner imports deterministically', () => {
    const violations = scanFileForLayerAccessViolations(
      'src/planner/examplePlanner.ts',
      "import fs from 'fs';\nimport { Client } from 'pg';\nimport axios from 'axios';\n"
    );

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/planner/examplePlanner.ts'
      })
    ]));
  });

  it('flags blocked capability imports deterministically', () => {
    const violations = scanFileForLayerAccessViolations(
      'src/capability/exampleCapability.ts',
      "import { query } from '@core/db/query.js';\nimport { DatabaseBackedDagJobQueue } from '../src/jobs/jobQueue.js';\nimport https from 'node:https';\n"
    );

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/capability/exampleCapability.ts'
      })
    ]));
  });

  it('treats planner and capability directories as protected layers', () => {
    const protectedFiles = getProtectedLayerFiles([
      'src/planner/buildPlan.ts',
      'src/capability/routeCommand.ts',
      'src/services/agentGoalPlanner.ts',
      'src/services/ai.handler.ts'
    ]);

    //audit Assumption: new planner/ and capability/ folders must inherit the same CEF boundary enforcement as legacy planner/capability service files; failure risk: directory reorganizations silently fall outside CI enforcement; expected invariant: both directory-based and legacy protected modules are scanned; handling strategy: assert the protected-file resolver keeps all intended entrypoints in scope.
    expect(protectedFiles).toEqual([
      'src/planner/buildPlan.ts',
      'src/capability/routeCommand.ts',
      'src/services/agentGoalPlanner.ts'
    ]);
  });

  it('includes circular TypeScript dependencies in the executable boundary report', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'arcanos-boundaries-'));
    const sourceRoot = path.join(fixtureRoot, 'src');
    mkdirSync(sourceRoot);
    writeFileSync(
      path.join(fixtureRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022'
        }
      }),
      'utf8'
    );
    writeFileSync(
      path.join(sourceRoot, 'first.ts'),
      "import './second.js';\nexport const first = true;\n",
      'utf8'
    );
    writeFileSync(
      path.join(sourceRoot, 'second.ts'),
      "import './first.js';\nexport const second = true;\n",
      'utf8'
    );

    try {
      const circularDependencies = await findCircularDependencies({
        repositoryRoot: fixtureRoot
      });

      expect(circularDependencies).toHaveLength(1);
      expect(
        [...(circularDependencies[0] ?? [])].sort()
      ).toEqual(['src/first.ts', 'src/second.ts']);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it('runs layer access before cycles and marks a circular report as failed', async () => {
    const callOrder: string[] = [];
    const logged: string[] = [];
    const errors: string[] = [];
    const markFailure = jest.fn();

    const circularDependencies = await runBoundaryChecks({
      runLayerAccessCheck: () => {
        callOrder.push('layer-access');
      },
      findCycles: async () => {
        callOrder.push('cycles');
        return [['first.ts', 'second.ts']];
      },
      log: (message: string) => {
        logged.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
      markFailure
    });

    expect(callOrder).toEqual(['layer-access', 'cycles']);
    expect(circularDependencies).toEqual([['first.ts', 'second.ts']]);
    expect(logged).toEqual([]);
    expect(errors.join('\n')).toContain('first.ts');
    expect(errors.join('\n')).toContain('second.ts');
    expect(markFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps a clean cycle report successful after the layer access check', async () => {
    const runLayerAccessCheck = jest.fn();
    const markFailure = jest.fn();
    const logged: string[] = [];

    await expect(
      runBoundaryChecks({
        runLayerAccessCheck,
        findCycles: async () => [],
        log: (message: string) => {
          logged.push(message);
        },
        markFailure
      })
    ).resolves.toEqual([]);

    expect(runLayerAccessCheck).toHaveBeenCalledTimes(1);
    expect(logged.join('\n')).toContain('No circular dependencies found');
    expect(markFailure).not.toHaveBeenCalled();
  });
});
