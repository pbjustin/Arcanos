import { validateGamingRequest } from './services/gamingModes.js';
import type { GamingSuccessEnvelope } from './services/gamingModes.js';
import type { GamingPipelineInput, GamingPipelineRuntime } from './services/gamingPipeline.js';
import { clearGamingRagCache, type GamingRagContext } from './services/gamingWebContext.js';
import { hasBoundGamingClearAnswer } from './shared/gaming/gamingClearAnswerBinding.js';
import { gamingClearHash, type GamingClearAssessment } from './shared/gaming/gamingClearPolicy.js';
import type { LivePreviewFailureCode } from '../scripts/live-pr-preview-verifier.mjs';
import type { LivePrPreviewModuleAdapter, LivePrPreviewAudit } from './livePrPreviewApplication.js';

export type LivePrPreviewGamingExecutor = (input: GamingPipelineInput, hooks: Pick<GamingPipelineRuntime,
  'onRetrieval' | 'onEvidenceAssessment' | 'onAnswerAuditStart' | 'onAnswerAudit'>) => Promise<GamingSuccessEnvelope>;
export const LIVE_PR_PREVIEW_GAMING_PATH = '/__preview/live/gaming';

/** Gaming owns its validation and mandatory audit binding; the private harness owns admission and limits. */
export function createLivePrPreviewGamingAdapter(execute: LivePrPreviewGamingExecutor): LivePrPreviewModuleAdapter {
  return {
    moduleId: 'gaming',
    validateInput(value) {
      const validated = validateGamingRequest(value);
      return validated.ok && validated.value.game && validated.value.mode === 'guide'
        && (validated.value.guideUrl || validated.value.guideUrls.length)
        ? { ok: true, input: validated.value } : { ok: false };
    },
    async execute(input, observer) {
      // A live acquisition assertion must acquire this request's document, including repeated URLs.
      clearGamingRagCache();
      let retrieval: GamingRagContext | undefined;
      let assessment: GamingClearAssessment | undefined;
      let auditAssessment: GamingClearAssessment | undefined;
      let failureCode: LivePreviewFailureCode | undefined;
      const fail = (code: LivePreviewFailureCode) => { failureCode = code; observer.onFailure(code); };
      let result: GamingSuccessEnvelope | undefined;
      try {
        result = await execute(input as GamingPipelineInput, {
          onRetrieval: value => {
            retrieval = value;
            observer.onSourceAcquisition(value.fetchedSuppliedSourceCount > 0 && !value.cacheHit ? 'passed' : 'failed');
            if (value.cacheHit) fail('ACQUISITION_FAILURE');
            if (value.sources.some(source => source.error === 'Source did not match the requested game or version.')) {
              observer.onSourceValidation('rejected'); fail('INCOMPATIBLE_SOURCE');
            }
          },
          onEvidenceAssessment: value => {
            assessment = value;
            observer.onSourceValidation(value.decision === 'accept' ? 'passed' : 'rejected');
            if (value.gates.compatibility === 'conflict' || value.gates.identity === 'conflict') fail('INCOMPATIBLE_SOURCE');
            else if (value.decision !== 'accept') fail('INSUFFICIENT_EVIDENCE');
          },
          onAnswerAuditStart: () => observer.onAnswerAuditStart(),
          onAnswerAudit: value => {
            auditAssessment = value.assessment;
            observer.onAudit({ assessmentStatus: value.assessment.assessmentStatus,
              decision: value.assessment.decision, boundToFinalAnswer: false });
            if (value.assessment.findings.some(finding => finding.code === 'AUDIT_TIMEOUT')) fail('AUDIT_TIMEOUT');
          },
        });
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (failureCode !== 'INCOMPATIBLE_SOURCE') {
          if (code === 'GAMING_SOURCE_UNAVAILABLE') fail('ACQUISITION_FAILURE');
          else if (code === 'GAMING_SOURCE_UNREADABLE') {
            observer.onSourceValidation('rejected'); fail('INSUFFICIENT_EVIDENCE');
          }
        }
      }
      const accepted = Boolean(result && !failureCode && !result.data.fallbackReason && hasBoundGamingClearAnswer(result.data)
        && assessment?.decision === 'accept' && retrieval && !retrieval.cacheHit
        && auditAssessment?.subjectHash === gamingClearHash(result.data.response));
      const audit: LivePrPreviewAudit | undefined = auditAssessment ? { assessmentStatus: auditAssessment.assessmentStatus,
        decision: auditAssessment.decision, boundToFinalAnswer: accepted } : undefined;
      return { result, accepted, audit, failureCode };
    },
  };
}
