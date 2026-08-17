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

  it('preserves an inline honesty caveat with the first item and retains all requested bullets', () => {
    const normalizedOutput = applyTrinityDirectAnswerOutputContract(
      [
        "I can't verify current external state here without live access. **1. Overall verdict remains grounded in the supplied card.**",
        '**2. Match results stay distinct.**',
        '**3. Promo feedback stays distinct.**',
        '**4. Pacing feedback stays distinct.**',
        '**5. Continuity feedback stays distinct.**',
        '**6. Remaining-match guidance stays distinct.**'
      ].join('\n'),
      'Answer directly in six numbered bullets.'
    );

    expect(normalizedOutput).toBe([
      "1. I can't verify current external state here without live access. Overall verdict remains grounded in the supplied card.",
      '2. Match results stay distinct.',
      '3. Promo feedback stays distinct.',
      '4. Pacing feedback stays distinct.',
      '5. Continuity feedback stays distinct.',
      '6. Remaining-match guidance stays distinct.'
    ].join('\n'));
  });

  it('attaches a standalone honesty caveat to the first item and retains all requested bullets', () => {
    const normalizedOutput = applyTrinityDirectAnswerOutputContract(
      [
        "I can't verify current external state here without live access.",
        '1. Overall verdict remains grounded in the supplied card.',
        '2. Match results stay distinct.',
        '3. Promo feedback stays distinct.',
        '4. Pacing feedback stays distinct.',
        '5. Continuity feedback stays distinct.',
        '6. Remaining-match guidance stays distinct.'
      ].join('\n'),
      'Answer directly in six numbered bullets.'
    );

    expect(normalizedOutput).toBe([
      "1. I can't verify current external state here without live access. Overall verdict remains grounded in the supplied card.",
      '2. Match results stay distinct.',
      '3. Promo feedback stays distinct.',
      '4. Pacing feedback stays distinct.',
      '5. Continuity feedback stays distinct.',
      '6. Remaining-match guidance stays distinct.'
    ].join('\n'));
  });

  it('restores collapsed bullets when honesty replaces the original first item', () => {
    const normalizedOutput = applyTrinityDirectAnswerOutputContract(
      "I can't verify current external state here without live access. 2. Match results stay distinct. 3. Promo feedback stays distinct. 4. Pacing feedback stays distinct. 5. Continuity feedback stays distinct. 6. Remaining-match guidance stays distinct.",
      'Answer directly in six numbered bullets.'
    );

    expect(normalizedOutput).toBe([
      "1. I can't verify current external state here without live access.",
      '2. Match results stay distinct.',
      '3. Promo feedback stays distinct.',
      '4. Pacing feedback stays distinct.',
      '5. Continuity feedback stays distinct.',
      '6. Remaining-match guidance stays distinct.'
    ].join('\n'));
  });

  it('does not split sequential references inside a single requested bullet', () => {
    expect(applyTrinityDirectAnswerOutputContract(
      '1. Compare step 2. Configure it and 3. Verify it.',
      'Answer directly in one numbered bullet.'
    )).toBe('1. Compare step 2. Configure it and 3. Verify it.');
  });

  it('drops a benign inline preamble while retaining parenthesized numbered items', () => {
    const normalizedOutput = applyTrinityDirectAnswerOutputContract(
      [
        'Quick gut check: 1) Strong card spine.',
        '2) Tighten the middle segment.'
      ].join('\n'),
      'Answer directly in two numbered bullets.'
    );

    expect(normalizedOutput).toBe([
      '1. Strong card spine.',
      '2. Tighten the middle segment.'
    ].join('\n'));
  });

  it('keeps SWTOR numbered guide answers top-level and sequential when the model adds nested detail', () => {
    const normalizedOutput = applyTrinityDirectAnswerOutputContract(
      [
        'Here is the direct answer:',
        '1. Start with class-story quests on the starter planet.',
        '   - Treat exploration missions as optional XP padding, not required progression.',
        '2. Move to fleet once the story sends you there.',
        '   - Pick up crew skill trainers only if you actually plan to craft.',
        '3. Keep your companion in healing stance while soloing heroics.',
        '4. Replace gear at major level brackets instead of after every drop.',
        '5. Use quick travel and stronghold travel to cut planet downtime.',
        '6. Extra note that should not leak into a five-step answer.'
      ].join('\n'),
      'SWTOR leveling guide for a returning solo player. Answer directly in five short numbered bullets.'
    );

    const lines = normalizedOutput.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.map((line) => line.match(/^\d+\./)?.[0])).toEqual([
      '1.',
      '2.',
      '3.',
      '4.',
      '5.'
    ]);
    expect(normalizedOutput).toContain('optional XP padding');
    expect(normalizedOutput).not.toContain('6. Extra note');
    expect(normalizedOutput).not.toMatch(/^\s+[-*]/m);
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
