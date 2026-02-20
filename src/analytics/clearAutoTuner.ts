import { logger } from "@platform/logging/structuredLogging.js";

let CLEAR_MIN_THRESHOLD = 3.4;

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

    if (escalationRate > 0.35) {
      CLEAR_MIN_THRESHOLD -= 0.1;
    } else if (escalationRate < 0.08) {
      CLEAR_MIN_THRESHOLD += 0.1;
    }

    // Clamp
    CLEAR_MIN_THRESHOLD = Math.max(3.0, Math.min(3.8, CLEAR_MIN_THRESHOLD));

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
