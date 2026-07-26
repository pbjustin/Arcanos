import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  shouldInspectRuntimePrompt as compatibilityShouldInspectRuntimePrompt,
} from '../src/services/promptDebugTraceService.js';
import {
  classifyRuntimeInspectionPrompt as compatibilityClassifyRuntimeInspectionPrompt,
} from '../src/services/runtimeInspectionRoutingService.js';
import {
  classifyRuntimeInspectionPrompt,
  shouldInspectRuntimePrompt,
} from '../src/shared/runtimeInspectionPrompt.js';

describe('runtime inspection prompt detection', () => {
  it('preserves the service exports while keeping writing-plane classification on the shared leaf', () => {
    expect(compatibilityShouldInspectRuntimePrompt).toBe(shouldInspectRuntimePrompt);
    expect(compatibilityClassifyRuntimeInspectionPrompt).toBe(classifyRuntimeInspectionPrompt);

    const writingPlaneSource = fs.readFileSync(
      path.resolve('src/platform/runtime/writingPlaneContract.ts'),
      'utf8'
    );
    const classifierSource = fs.readFileSync(
      path.resolve('src/shared/runtimeInspectionPrompt.ts'),
      'utf8'
    );

    expect(writingPlaneSource).toContain(
      "from '@shared/runtimeInspectionPrompt.js'"
    );
    expect(writingPlaneSource).not.toContain('runtimeInspectionRoutingService');
    expect(classifierSource).not.toMatch(
      /(?:@core\/|@platform\/|@routes\/|@services\/|\/core\/|\/platform\/|\/routes\/|\/services\/)/u
    );
  });

  it.each([
    'Generate a strong, reusable prompt template for the Codex IDE Agent CLI',
    'Revise the Codex IDE Agent CLI prompt by incorporating this follow-up scope',
    'Generate a prompt that debugs and tests PR #1279 using this Railway URL',
    'Write a concise prompt to audit transport capability behavior',
    'Create a prompt for Codex to inspect the repo and suggest fixes',
    'Write a prompt that also runs diagnostics now against the live Railway deployment',
    'Write instructions for another agent to verify the live API deployment and update docs',
    'Draft a spec for Codex to inspect runtime logs and summarize findings',
    'Help me make Codex fix my repo',
    'Generate something that lets another AI update docs',
    'Show the DAG lineage, nodes, metrics, and verification for the latest run.',
    'Get the DAG lineage, nodes, metrics, and verification summary.',
  ])('keeps non-runtime request "%s" on the standard generation path', (prompt) => {
    expect(shouldInspectRuntimePrompt(prompt)).toBe(false);
    expect(classifyRuntimeInspectionPrompt(prompt)).toMatchObject({
      detectedIntent: 'STANDARD',
    });
  });

  it.each([
    'Reach my backend and run diagnostics',
    'Run a live transport-capability audit against this instance',
    'Inspect current worker health and self-heal events',
    'Check runtime status of the current backend instance',
    'Run diagnostics on the live Railway deployment',
  ])('keeps runtime inspection request "%s" on runtime-inspection routing', (prompt) => {
    expect(shouldInspectRuntimePrompt(prompt)).toBe(true);
    expect(classifyRuntimeInspectionPrompt(prompt)).toMatchObject({
      detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
    });
  });
});
