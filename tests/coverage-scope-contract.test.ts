import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  codecovCoverageScopeFiles,
  curatedCoverageScopeFiles,
  jestCoverageScopeFiles,
} from '../config/coverageScope.js';
import {
  backstageNotionCoverageScopeFiles,
} from '../config/backstageNotionCoverageScope.js';

const ROUTING_STATUS_PATHS = [
  'src/routes/_core/gptDispatch.ts',
  'src/routes/_core/legacyGptCompat.ts',
  'src/routes/dispatch.ts',
  'src/routes/gptRouter.ts',
  'src/services/backstage-booker.ts',
  'src/services/backstageBookerContracts.ts',
] as const;

function readProjectStatusPaths(statusName: string): string[] {
  const lines = readFileSync(join(process.cwd(), 'codecov.yml'), 'utf8')
    .split(/\r?\n/u);
  const statusStart = lines.findIndex(line => line === `      ${statusName}:`);
  if (statusStart < 0) {
    throw new Error(`Missing Codecov project status: ${statusName}`);
  }

  const nextStatus = lines.findIndex((line, index) => (
    index > statusStart && /^ {6}\S/u.test(line)
  ));
  const statusEnd = nextStatus < 0 ? lines.length : nextStatus;
  const pathsStart = lines.findIndex((line, index) => (
    index > statusStart && index < statusEnd && line === '        paths:'
  ));
  if (pathsStart < 0) {
    throw new Error(`Missing paths for Codecov project status: ${statusName}`);
  }

  const paths: string[] = [];
  for (let index = pathsStart + 1; index < statusEnd; index += 1) {
    const match = /^ {10}- "([^"]+)"$/u.exec(lines[index] ?? '');
    if (!match) break;
    paths.push(match[1] ?? '');
  }
  return paths;
}

describe('Jest and Codecov coverage scope contract', () => {
  it('keeps the strict 100% Codecov status identical to the legacy curated scope', () => {
    expect(readProjectStatusPaths('default')).toEqual(curatedCoverageScopeFiles);
    expect(codecovCoverageScopeFiles).toEqual(curatedCoverageScopeFiles);
  });

  it('partitions every feature-owned file into one explicit Codecov status', () => {
    const routingPaths = [...ROUTING_STATUS_PATHS];
    const protocolPaths = backstageNotionCoverageScopeFiles.filter(path => (
      path.startsWith('packages/protocol/src/')
    ));
    const corePaths = backstageNotionCoverageScopeFiles.filter(path => (
      !routingPaths.includes(path as typeof ROUTING_STATUS_PATHS[number])
      && !protocolPaths.includes(path)
    ));
    const statusPaths = [
      ...readProjectStatusPaths('backstage-notion-core'),
      ...readProjectStatusPaths('backstage-routing'),
      ...readProjectStatusPaths('backstage-protocol'),
    ];
    const combinedPaths = [...curatedCoverageScopeFiles, ...statusPaths];

    expect(readProjectStatusPaths('backstage-notion-core')).toEqual(corePaths);
    expect(readProjectStatusPaths('backstage-routing')).toEqual(routingPaths);
    expect(readProjectStatusPaths('backstage-protocol')).toEqual(protocolPaths);
    expect(statusPaths).toHaveLength(new Set(statusPaths).size);
    expect(combinedPaths).toHaveLength(new Set(combinedPaths).size);
    expect([...combinedPaths].sort()).toEqual(
      [...jestCoverageScopeFiles].sort()
    );
  });
});
