import { describe, expect, it } from '@jest/globals';
import { patchProposalTestUtils } from '@services/selfImprove/patchProposal.js';
import { findMissingPromptGuidanceSections } from '../src/shared/promptGuidance.js';

describe('patchProposalTestUtils.parseJsonObjectFromModelOutput', () => {
  it('parses strict JSON output', () => {
    const parsed = patchProposalTestUtils.parseJsonObjectFromModelOutput('{"ok":true}') as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it('parses fenced JSON output', () => {
    const parsed = patchProposalTestUtils.parseJsonObjectFromModelOutput('```json\n{"kind":"self_improve_patch"}\n```') as { kind: string };
    expect(parsed.kind).toBe('self_improve_patch');
  });

  it('parses JSON object wrapped in prose', () => {
    const parsed = patchProposalTestUtils.parseJsonObjectFromModelOutput('Model output follows:\n{"risk":"low","files":[]}\nDone.') as { risk: string };
    expect(parsed.risk).toBe('low');
  });

  it('throws when no valid JSON object exists', () => {
    expect(() => patchProposalTestUtils.parseJsonObjectFromModelOutput('not-json')).toThrow('Patch proposal is not valid JSON.');
  });
});

describe('patchProposalTestUtils.buildPatchProposalPrompt', () => {
  it('renders the OpenAI-guided prompt contract and evidence rules', () => {
    const prompt = patchProposalTestUtils.buildPatchProposalPrompt({
      trigger: 'test-trigger',
      component: 'ai-gateway',
      context: {
        file: 'src/example.ts'
      },
      prohibitedPaths: ['.env', 'secrets/']
    });

    expect(findMissingPromptGuidanceSections(prompt)).toEqual([]);
    expect(prompt).toContain('Output ONLY valid JSON');
    expect(prompt).toContain('Do not guess repo structure');
    expect(prompt).toContain('Never route protected backend diagnostics through /gpt/:gptId.');
    expect(prompt).toContain('test-trigger');
  });
});

describe('patchProposalTestUtils.validateUnifiedDiffShape', () => {
  it('rejects diffs with placeholder lines', () => {
    const result = patchProposalTestUtils.validateUnifiedDiffShape(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '...'
      ].join('\n')
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('placeholder');
  });

  it('rejects diffs missing hunk header', () => {
    const result = patchProposalTestUtils.validateUnifiedDiffShape(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '+const x = 1;'
      ].join('\n')
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('hunk');
  });

  it('accepts a minimal valid unified diff', () => {
    const result = patchProposalTestUtils.validateUnifiedDiffShape(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '-const oldValue = 1;',
        '+const oldValue = 2;'
      ].join('\n')
    );
    expect(result.valid).toBe(true);
  });
});
