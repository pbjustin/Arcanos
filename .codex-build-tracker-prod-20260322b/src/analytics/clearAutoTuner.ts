import { logger } from "@platform/logging/structuredLogging.js";

const CLEAR_DEFAULT_THRESHOLD = 3.4;
const ESCALATION_RATE_UPPER_BOUND = 0.35;
const ESCALATION_RATE_LOWER_BOUND = 0.08;
const THRESHOLD_ADJUSTMENT_STEP = 0.1;
const CLEAR_THRESHOLD_MIN_CLAMP = 3.0;
const CLEAR_THRESHOLD_MAX_CLAMP = 3.8;

let CLEAR_MIN_THRESHOLD = CLEAR_DEFAULT_THRESHOLD;

const WINDOW_SIZE = 500;
let runCount = 0;
let escalationCount = 0;

export function getClearMinThreshold(): number {
  return CLEAR_MIN_THRESHOLD;
}

export function recordRun(wasEscalated: boolean): void {
  runCount++;
  if (wasEscalated) {
    escalationCount++;
  }

  if (runCount >= WINDOW_SIZE) {
    const escalationRate = escalationCount / runCount;
    const oldThreshold = CLEAR_MIN_THRESHOLD;

    if (escalationRate > ESCALATION_RATE_UPPER_BOUND) {
      CLEAR_MIN_THRESHOLD -= THRESHOLD_ADJUSTMENT_STEP;
    } else if (escalationRate < ESCALATION_RATE_LOWER_BOUND) {
      CLEAR_MIN_THRESHOLD += THRESHOLD_ADJUSTMENT_STEP;
    }

    // Clamp
    CLEAR_MIN_THRESHOLD = Math.max(
      CLEAR_THRESHOLD_MIN_CLAMP,
      Math.min(CLEAR_THRESHOLD_MAX_CLAMP, CLEAR_MIN_THRESHOLD)
    );

    if (oldThreshold !== CLEAR_MIN_THRESHOLD) {
      logger.info('CLEAR threshold adjusted', {
        module: 'analytics',
        operation: 'auto-tuning',
        oldThreshold,
        newThreshold: CLEAR_MIN_THRESHOLD,
        escalationRate
      });
    }

    // Reset window
    runCount = 0;
    escalationCount = 0;
  }
}
