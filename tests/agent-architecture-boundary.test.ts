import { describe, expect, it } from '@jest/globals';
import {
  findLayerAccessViolations,
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
      'src/services/examplePlanner.ts',
      "import fs from 'fs';\nimport axios from 'axios';\n"
    );

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/services/examplePlanner.ts'
      })
    ]));
  });

  it('flags blocked capability imports deterministically', () => {
    const violations = scanFileForLayerAccessViolations(
      'src/services/exampleCapability.ts',
      "import { query } from '@core/db/query.js';\nimport { DatabaseBackedDagJobQueue } from '../src/jobs/jobQueue.js';\n"
    );

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/services/exampleCapability.ts'
      })
    ]));
  });
});
