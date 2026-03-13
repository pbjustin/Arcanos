import { describe, expect, it } from '@jest/globals';
import {
  applyTrinityDirectAnswerOutputContract,
  buildTrinityDirectAnswerSystemInstruction,
  parseTrinityDirectAnswerOutputContract,
  resolveTrinityDirectAnswerTokenLimit
} from '../src/core/logic/trinityDirectAnswerMode.js';

describe('trinityDirectAnswerMode', () => {
  it('builds a strict core instruction with memory and bullet formatting constraints', () => {
    const instruction = buildTrinityDirectAnswerSystemInstruction(
      'Prior ticket: user prefers concrete implementation steps.',
      'Do not simulate. Answer directly in five short bullets.'
    );

    expect(instruction).toContain('ARCANOS core assistant');
    expect(instruction).toContain('Do not mention Trinity, routing stages, audit traces, or internal reasoning.');
    expect(instruction).toContain('Return only 5 top-level numbered bullets.');
    expect(instruction).toContain('Relevant memory context: Prior ticket: user prefers concrete implementation steps.');
  });

  it('normalizes list-shaped outputs to the requested bullet count and strips preambles', () => {
    const normalizedOutput = applyTrinityDirectAnswerOutputContract(
      [
        'Direct answer:',
        '1. First fix the dispatcher fallback so direct-answer prompts skip persona framing and return concise output immediately.',
        '2. Then clamp the token budget to reduce over-expansion and timeout pressure under live load.',
        '3. Finally add a smoke test against /ask and /api/arcanos/ask.',
        '4. Extra bullet that should be removed.'
      ].join('\n'),
      'Do not simulate. Answer directly in three short bullets.'
    );

    expect(normalizedOutput).toBe([
      '1. First fix the dispatcher fallback so direct-answer prompts skip persona framing and return concise output immediately.',
      '2. Then clamp the token budget to reduce over-expansion and timeout pressure under live load.',
      '3. Finally add a smoke test against /ask and /api/arcanos/ask.'
    ].join('\n'));
  });

  it('parses bullet contracts and reduces token budgets for compact direct-answer prompts', () => {
    expect(
      parseTrinityDirectAnswerOutputContract('Do not simulate. Answer directly in five short bullets.')
    ).toEqual({
      requestedBulletCount: 5,
      requiresShortBullets: true
    });

    expect(
      resolveTrinityDirectAnswerTokenLimit(
        'Do not simulate. Answer directly in five short bullets.',
        1200
      )
    ).toBe(240);
    expect(
      resolveTrinityDirectAnswerTokenLimit(
        'Do not simulate. Answer directly.',
        1200
      )
    ).toBe(500);
  });
});
