import {
  CLEAN_PRIVATE_SERVING_SAFETY,
  buildUnsafeSafetyResponse,
} from './private-serving-deny.mjs';

const EFFECTIVE_SOURCES = new Set(['model', 'policy', 'spec_facts', 'postprocessor']);

export function validateCleanSafetyFlags(safety = {}) {
  const failures = [];
  for (const [key, expected] of Object.entries(CLEAN_PRIVATE_SERVING_SAFETY)) {
    if (safety[key] !== expected) {
      failures.push(key);
    }
  }
  if (safety.allowedForTraining !== undefined && safety.allowedForTraining !== false) {
    failures.push('allowedForTraining');
  }
  return {
    ok: failures.length === 0,
    reason: failures.length === 0 ? null : 'dirty_safety_flags',
    failures,
  };
}

function normalizeEffective(effective = {}) {
  const sources = Array.isArray(effective.sources)
    ? effective.sources.filter((source) => EFFECTIVE_SOURCES.has(source))
    : [];
  return {
    plane: String(effective.plane || ''),
    action: String(effective.action || ''),
    risk: String(effective.risk || ''),
    requiresConfirmation: effective.requiresConfirmation === true,
    allowedForTraining: false,
    sources: sources.length > 0 ? sources : ['postprocessor'],
  };
}

export function shapePrivateServingResponse(runtimeOutput = {}, options = {}) {
  const requestId = options.requestId || runtimeOutput.requestId || 'private-serving-response';
  const safety = runtimeOutput.safety || {};
  const safetyCheck = validateCleanSafetyFlags(safety);
  if (!safetyCheck.ok || runtimeOutput.effective?.allowedForTraining !== false) {
    return buildUnsafeSafetyResponse({
      requestId,
      reason: 'dirty_safety_flags',
    });
  }

  return {
    requestId,
    effective: normalizeEffective(runtimeOutput.effective),
    safety: CLEAN_PRIVATE_SERVING_SAFETY,
  };
}
