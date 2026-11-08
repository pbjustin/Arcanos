import { describe, expect, it } from '@jest/globals';
import { sameGamingSourceAuthoritySnapshot, type GamingSourceAuthoritySnapshot }
  from '../src/shared/gaming/gamingSourceAuthority.js';

const unconfigured: GamingSourceAuthoritySnapshot = { status: 'unconfigured' };
const available: GamingSourceAuthoritySnapshot = {
  status: 'available',
  restrictedRevisionCount: 0,
  requiresReassessment: false,
  stateFingerprint: '0'.repeat(32)
};

describe('shared Gaming source authority snapshot equality', () => {
  it('allows stable explicitly unconfigured operation without treating it as configured authority', () => {
    expect(sameGamingSourceAuthoritySnapshot(unconfigured, { ...unconfigured })).toBe(true);
    expect(sameGamingSourceAuthoritySnapshot(unconfigured, available)).toBe(false);
    expect(sameGamingSourceAuthoritySnapshot(available, unconfigured)).toBe(false);
  });

  it('accepts only identical available observations', () => {
    expect(sameGamingSourceAuthoritySnapshot(available, { ...available })).toBe(true);
  });

  it('invalidates added or removed durable restrictions', () => {
    expect(sameGamingSourceAuthoritySnapshot(available, { ...available, restrictedRevisionCount: 1 })).toBe(false);
    expect(sameGamingSourceAuthoritySnapshot({ ...available, restrictedRevisionCount: 1 }, available)).toBe(false);
  });

  it('invalidates a reassessment-state transition even with an unchanged restriction count', () => {
    expect(sameGamingSourceAuthoritySnapshot(available, { ...available, requiresReassessment: true })).toBe(false);
    expect(sameGamingSourceAuthoritySnapshot({ ...available, requiresReassessment: true }, available)).toBe(false);
  });

  it('invalidates source epoch changes without an authority-count change', () => {
    expect(sameGamingSourceAuthoritySnapshot(available, { ...available, stateFingerprint: 'a'.repeat(32) })).toBe(false);
    expect(sameGamingSourceAuthoritySnapshot({ ...available, stateFingerprint: 'a'.repeat(32) }, available)).toBe(false);
  });
});
