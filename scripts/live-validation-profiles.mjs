/** Checked-in profile files shared by the controller and isolated runtime. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LiveValidationBootstrapError, requireValidation } from './live-validation-bootstrap.mjs';

const PROFILE_FILES = Object.freeze({
  'gaming-guide': 'profiles.json',
  'gaming-gta-iv': 'gta-iv-profiles.json'
});

export const LIVE_VALIDATION_PROFILE_NAMES = Object.freeze(Object.keys(PROFILE_FILES));

export function readLiveValidationProfiles(root, name) {
  requireValidation(typeof name === 'string' && Object.hasOwn(PROFILE_FILES, name), 'LIVE_VALIDATION_PROFILE_INVALID');
  try {
    return JSON.parse(readFileSync(path.join(root, 'examples/live-validation', PROFILE_FILES[name]), 'utf8'));
  } catch {
    throw new LiveValidationBootstrapError('LIVE_VALIDATION_PROFILE_INVALID');
  }
}
