import { describe, expect, it } from '@jest/globals';
import { gamingAttributableClaimText } from '../src/shared/gaming/gamingRetrievalPolicy.js';

const game = 'Amber Pilgrim';
const scope = `in the game ${game}, `;

/** Count string inspection/copy work; this is independent of machine speed. */
function measuredClaims(text: string) {
  const slice = String.prototype.slice;
  const split = String.prototype.split;
  const charAt = String.prototype.charAt;
  const work = { sliceCodeUnits: 0, splitCodeUnits: 0, characterReads: 0 };
  let claims: string;
  try {
    String.prototype.slice = function (start?: number, end?: number) {
      const value = slice.call(this, start, end);
      work.sliceCodeUnits += value.length;
      return value;
    };
    String.prototype.split = function (separator: string | RegExp, limit?: number) {
      work.splitCodeUnits += String(this).length;
      return split.call(this, separator, limit);
    };
    String.prototype.charAt = function (index: number) {
      work.characterReads += 1;
      return charAt.call(this, index);
    };
    claims = gamingAttributableClaimText(text, game);
  } finally {
    String.prototype.slice = slice;
    String.prototype.split = split;
    String.prototype.charAt = charAt;
  }
  return { claims, work, totalCodeUnits: work.sliceCodeUnits + work.splitCodeUnits + work.characterReads };
}

describe('linear requested-game claim scope inspection', () => {
  it.each([512, 1024])('bounds inspected/copied string units for %i repeated acquired scopes', count => {
    const text = `In the game ${game}, use the lever to open the gate. `.repeat(count);
    const measured = measuredClaims(text);
    expect(measured.claims.split('\n')).toEqual(Array.from({ length: count }, () => 'use the lever to open the gate.'));
    expect(measured.totalCodeUnits).toBeLessThanOrEqual(text.length * 64);
  });

  it.each([
    [`Do not, ${scope}equip the copper shield.`, 'Do not,  equip the copper shield.'],
    [`DO\tNOT ${scope}equip the copper shield.`, 'DO\tNOT  equip the copper shield.'],
    [`Don’t ${scope}equip the copper shield.`, 'Don’t  equip the copper shield.'],
    [`Never\u00a0${scope}use the lever, preserve charge.`, 'Never\u00a0 use the lever, preserve charge.'],
    [`Unless ${scope}the gate opens the canal route.`, 'Unless  the gate opens the canal route.'],
    [`Only\r\tif ${scope}the gate opens the canal route.`, 'Only\r\tif  the gate opens the canal route.'],
    [`Do${' '.repeat(8192)}not ${scope}equip the copper shield.`, `Do${' '.repeat(8192)}not  equip the copper shield.`],
    [`Use the lever ${scope}then cross the bridge.`, 'Use the lever\nthen cross the bridge.'],
    [`Copper shield labels. Do not ${scope}equip the copper shield.`, 'Do not  equip the copper shield.'],
    [`Do not\n${scope}equip the copper shield.`, 'equip the copper shield.']
  ])('preserves the exact scope-delimiter projection %#', (input, expected) => {
    expect(gamingAttributableClaimText(input, game)).toBe(expected);
  });
});
