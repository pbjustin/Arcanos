import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertTrustedGamingPreviewConfiguration, resolveTrustedGamingPreviewConfiguration,
  validateGamingPreviewPolicy,
} from './gaming-scoped-preview-policy.mjs';

test('selects only the fixed reviewed Gaming scope, with hosted activation disabled', () => {
  const policy = resolveTrustedGamingPreviewConfiguration();
  assert.equal(policy.scope, 'gaming-synthetic-v1');
  assert.equal(policy.hostedEnabled, false);
  assert.equal(Object.isFrozen(policy), true);
  assert.doesNotThrow(() => assertTrustedGamingPreviewConfiguration(policy));
});

test('caller configuration, candidate paths and scope overrides cannot select the scope', () => {
  const policy = resolveTrustedGamingPreviewConfiguration();
  for (const value of [{ ...policy }, {}, null, 'full']) {
    assert.throws(() => assertTrustedGamingPreviewConfiguration(value), /TRUSTED_POLICY_INVALID/);
  }
  for (const value of ['full', { scope: 'full' }, '../candidate/config.json']) {
    assert.throws(() => resolveTrustedGamingPreviewConfiguration(value), /TRUSTED_POLICY_INVALID/);
  }
});

test('unknown fields, scope changes and self-activation fail closed', () => {
  const policy = resolveTrustedGamingPreviewConfiguration();
  for (const mutation of [{ scope: 'full' }, { scope: 'stacked-draft-gaming-synthetic' },
    { version: 2 }, { hostedEnabled: true }, { statusContext: 'Railway PR Preview E2E' },
    { candidateScope: 'gaming-synthetic-v1' }]) {
    assert.throws(() => validateGamingPreviewPolicy({ ...policy, ...mutation }), /TRUSTED_POLICY_INVALID/);
  }
});
