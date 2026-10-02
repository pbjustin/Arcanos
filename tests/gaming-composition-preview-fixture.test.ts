import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { InstructionSection, TransformedInstructionSection } from '../scripts/skill-composition-core.mjs';

const actual = await import('../scripts/skill-composition-core.mjs');
const sectionMap = jest.fn(actual.instructionSectionMap);
const transform = jest.fn(actual.transformInstructionSections);
jest.unstable_mockModule('../scripts/skill-composition-core.mjs', () => ({
  instructionSectionMap: sectionMap, transformInstructionSections: transform,
}));
const { assertGamingCompositionPreviewFixture } = await import('../src/shared/chatgpt/gamingCompositionPreviewFixture.js');
const failure = 'GAMING_COMPOSITION_PREVIEW_ASSERTION_FAILED';
beforeEach(() => {
  sectionMap.mockReset().mockImplementation(actual.instructionSectionMap);
  transform.mockReset().mockImplementation(actual.transformInstructionSections);
});

describe('sealed shared section composition with synthetic Gaming substitutions', () => {
  it('executes the actual core for UTF-8 LF/CRLF mapping, deterministic trace and the 512/513 boundary', () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
    try {
      expect(assertGamingCompositionPreviewFixture).not.toThrow();
      expect(assertGamingCompositionPreviewFixture).not.toThrow();
      expect(sectionMap).toHaveBeenCalledTimes(8);
      expect(transform).toHaveBeenCalledTimes(12);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it.each([
    ['source start', (section: InstructionSection) => { section.sourceStartByte += 1; }],
    ['source end', (section: InstructionSection) => { section.sourceEndByte -= 1; }],
    ['output start', (section: InstructionSection) => { section.outputStartByte -= 1; }],
    ['output end', (section: InstructionSection) => { section.outputEndByte += 1; }],
    ['source digest', (section: InstructionSection) => { section.sha256 = '0'.repeat(64); }],
    ['Tutor target identity', (section: InstructionSection) => { section.targetId = 'wrong-section'; }],
  ] as const)('rejects a broken source mapper: %s', (_name, mutate) => {
    sectionMap.mockImplementation((...args) => {
      const result = actual.instructionSectionMap(...args);
      mutate(result[0]);
      return result;
    });
    expect(assertGamingCompositionPreviewFixture).toThrow(failure);
  });

  it.each([
    ['source start', (section: TransformedInstructionSection) => { section.sourceStartByte += 1; }],
    ['source end', (section: TransformedInstructionSection) => { section.sourceEndByte -= 1; }],
    ['output start', (section: TransformedInstructionSection) => { section.outputStartByte -= 1; }],
    ['output end', (section: TransformedInstructionSection) => { section.outputEndByte += 1; }],
    ['source digest', (section: TransformedInstructionSection) => { section.sha256 = '0'.repeat(64); }],
    ['output digest', (section: TransformedInstructionSection) => { section.outputSha256 = '0'.repeat(64); }],
    ['source text', (section: TransformedInstructionSection) => { section.sourceText += 'changed'; }],
    ['output text', (section: TransformedInstructionSection) => { section.transformedText = section.sourceText; }],
    ['occurrence count', (section: TransformedInstructionSection) => { section.transformations[0].count = 1; }],
    ['trace identity', (section: TransformedInstructionSection) => { section.transformations[0].mcpOperation = 'modules.invoke'; }],
    ['disposition', (section: TransformedInstructionSection) => { section.disposition = 'PRESERVED'; }],
    ['Gaming target identity', (section: TransformedInstructionSection) => { section.targetId = 'wrong-section'; }],
  ] as const)('rejects a broken transformer: %s', (_name, mutate) => {
    transform.mockImplementation((...args) => {
      const result = actual.transformInstructionSections(...args);
      mutate(result.sections[0]);
      return result;
    });
    expect(assertGamingCompositionPreviewFixture).toThrow(failure);
  });

  it('rejects unchanged output even if the returned trace is correct', () => {
    transform.mockImplementation((...args) => ({ ...actual.transformInstructionSections(...args), content: args[0] }));
    expect(assertGamingCompositionPreviewFixture).toThrow(failure);
  });

  it('rejects lost preserved sections', () => {
    transform.mockImplementation((...args) => {
      const result = actual.transformInstructionSections(...args);
      result.sections.pop();
      return result;
    });
    expect(assertGamingCompositionPreviewFixture).toThrow(failure);
  });

  it('rejects a transformer that changes its result on a repeated invocation', () => {
    transform.mockImplementationOnce(actual.transformInstructionSections).mockImplementationOnce((...args) => ({
      ...actual.transformInstructionSections(...args), content: 'Nondeterministic synthetic output.',
    }));
    expect(assertGamingCompositionPreviewFixture).toThrow(failure);
  });

  it.each(['source mapper', 'transformer'] as const)('rejects a %s that accepts 513 sections', selected => {
    if (selected === 'source mapper') sectionMap.mockImplementation((...args) => {
      try { return actual.instructionSectionMap(...args); } catch { return []; }
    });
    else transform.mockImplementation((...args) => {
      try { return actual.transformInstructionSections(...args); } catch { return { content: args[0], sections: [] }; }
    });
    expect(assertGamingCompositionPreviewFixture).toThrow(failure);
  });

  it.each(['source mapper', 'transformer'] as const)('rejects a %s that fails at the admitted 512-section boundary', selected => {
    if (selected === 'source mapper') sectionMap.mockImplementation((...args) => {
      const result = actual.instructionSectionMap(...args);
      return result.length === 512 ? [] : result;
    });
    else transform.mockImplementation((...args) => {
      const result = actual.transformInstructionSections(...args);
      return result.sections.length === 512 ? { ...result, sections: [] } : result;
    });
    expect(assertGamingCompositionPreviewFixture).toThrow(failure);
  });

  it.each(['source mapper', 'transformer'] as const)('fails closed when the %s throws', selected => {
    const broken = () => { throw new Error('Unexpected synthetic core failure.'); };
    if (selected === 'source mapper') sectionMap.mockImplementation(broken);
    else transform.mockImplementation(broken);
    expect(assertGamingCompositionPreviewFixture).toThrow(failure);
  });
});
