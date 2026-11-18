/** Checked-in profile files shared by the controller and isolated runtime. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LIVE_VALIDATION_CONVERSATIONAL_CASE } from './live-validation-budget.mjs';
import { LIVE_PREVIEW_PRESENTATION_PROFILE } from './live-pr-preview-verifier.mjs';
import { LiveValidationBootstrapError, requireValidation } from './live-validation-bootstrap.mjs';

const PROFILE_FILES = Object.freeze({
  'gaming-guide': 'profiles.json',
  'gaming-gta-iv': 'gta-iv-profiles.json',
  'gaming-gta-iv-dual': 'gta-iv-dual-profiles.json'
});

export const LIVE_VALIDATION_PROFILE_NAMES = Object.freeze(Object.keys(PROFILE_FILES));

export const LIVE_VALIDATION_PAIRED_SUITE = 'paired-gta-iv-v1';
export const LIVE_VALIDATION_PAIRED_PROFILE = 'gaming-gta-iv-dual';
export const LIVE_VALIDATION_CONVERSATIONAL_CASE_ID = 'useful_conversational_guide';

export function isPairedLiveValidationSuite(suite) {
  return suite?.acceptanceProfile === LIVE_VALIDATION_PAIRED_SUITE;
}

/** Scope the paired admission to one conversational case followed by the existing grounded case. */
export function isLiveValidationProfileSuite(suite) {
  const paired = isPairedLiveValidationSuite(suite);
  const entries = suite?.profiles;
  if (suite?.version !== 2 || !paired && suite.acceptanceProfile !== LIVE_PREVIEW_PRESENTATION_PROFILE
    || !Array.isArray(entries) || entries.length !== 2
    || !entries.every(entry => entry?.moduleId === 'gaming' && entry.input?.query?.storagePolicy === 'transient_only')) return false;
  const [first, second] = entries;
  if (!paired) return first.id === 'gaming-guide-positive' && first.caseId === 'useful_grounded_guide'
    && second.id === 'gaming-guide-negative' && second.caseId === 'incompatible_source';
  return first.id === LIVE_VALIDATION_CONVERSATIONAL_CASE && first.caseId === LIVE_VALIDATION_CONVERSATIONAL_CASE_ID
    && Array.isArray(first.input.candidateUrls) && first.input.candidateUrls.length === 0
    && first.input.query.semanticAssistance?.version === 'gaming-semantic-v1'
    && !first.input.query.semanticAssistance.evidenceNeed && !first.input.query.semanticAssistance.requiredSourceUrl
    && first.input.clarificationReplies === undefined && second.input.clarificationReplies === undefined
    && first.expected?.outcome === 'accepted' && first.expected.semanticGap === 'NONE'
    && second.id === 'gaming-guide-positive' && second.caseId === 'useful_grounded_guide'
    && Array.isArray(second.input.candidateUrls) && second.input.candidateUrls.length === 1
    && second.expected?.outcome === 'accepted' && second.expected.semanticGap === 'NONE'
    && Array.isArray(second.expected.requiredModelStages) && second.expected.requiredModelStages.length === 3
    && ['intake', 'reasoning', 'final'].every(stage => second.expected.requiredModelStages.includes(stage));
}

export function readLiveValidationProfiles(root, name) {
  requireValidation(typeof name === 'string' && Object.hasOwn(PROFILE_FILES, name), 'LIVE_VALIDATION_PROFILE_INVALID');
  try {
    return JSON.parse(readFileSync(path.join(root, 'examples/live-validation', PROFILE_FILES[name]), 'utf8'));
  } catch {
    throw new LiveValidationBootstrapError('LIVE_VALIDATION_PROFILE_INVALID');
  }
}
