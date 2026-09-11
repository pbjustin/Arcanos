/** Invented mechanics and locations, never real gameplay guidance or copied guides. */
export const gamingClearCalibrationGames = [
  { game: 'The Legend of Zelda: Ocarina of Time', topic: 'copper gate', action: 'Open the copper gate with the carved key from the training alcove.', kind: 'static_adventure' },
  { game: 'Elden Ring', topic: 'quartz staff', action: 'Equip the quartz staff after checking the listed Intelligence prerequisite in the training alcove.', kind: 'patch_sensitive_action' },
  { game: 'Star Wars: The Old Republic', topic: 'silver console', action: 'Activate the silver console after collecting the training access badge in the hangar.', kind: 'live_service_systems' }
] as const;

export const gamingClearCalibrationCases = [
  { split: 'calibration', variant: 'supported', expected: 'accept' },
  { split: 'calibration', variant: 'wrong_game', expected: 'reject' },
  { split: 'calibration', variant: 'unknown', expected: 'withhold' },
  { split: 'held_out', variant: 'paraphrased', expected: 'accept' },
  { split: 'held_out', variant: 'wrong_patch', expected: 'reject' },
  { split: 'held_out', variant: 'missing_support', expected: 'withhold' }
] as const;

/** Gold semantic findings for mocked answer-judge contract tests, not a model evaluation. */
export const gamingClearAnswerLabels = [
  { split: 'calibration', variant: 'supported', code: null },
  { split: 'calibration', variant: 'invented_mechanic', code: 'UNSUPPORTED_MECHANIC' },
  { split: 'calibration', variant: 'audit_unavailable', code: 'AUDIT_UNAVAILABLE' },
  { split: 'held_out', variant: 'supported_qualified', code: null },
  { split: 'held_out', variant: 'wrong_citation_support', code: 'CITATION_CLAIM_UNSUPPORTED' },
  { split: 'held_out', variant: 'spoiler_violation', code: 'SPOILER_CONSTRAINT_VIOLATION' }
] as const;
