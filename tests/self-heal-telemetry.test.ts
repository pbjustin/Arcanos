import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  buildCompactSelfHealSummary,
  buildSelfHealTelemetrySnapshot,
  recordSelfHealEvent,
  resetSelfHealTelemetryForTests
} from '../src/services/selfImprove/selfHealTelemetry.js';

describe('selfHealTelemetry', () => {
  afterEach(() => {
    process.env.NODE_ENV = 'test';
    resetSelfHealTelemetryForTests();
    delete process.env.SELF_HEAL_TELEMETRY_FILE;
  });

  it('tracks trigger, attempt, success, failure, and fallback events in one snapshot', () => {
    process.env.NODE_ENV = 'test';
    resetSelfHealTelemetryForTests();

    recordSelfHealEvent({
      kind: 'trigger',
      source: 'self_heal_loop',
      trigger: 'interval',
      reason: 'worker stall detected',
      healedComponent: 'worker_queue'
    });
    recordSelfHealEvent({
      kind: 'attempt',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: 'worker stall detected',
      actionTaken: 'recoverStaleJobs',
      healedComponent: 'worker_queue'
    });
    recordSelfHealEvent({
      kind: 'success',
      source: 'self_heal_loop',
      trigger: 'action',
      reason: 'recovered one stalled job',
      actionTaken: 'recoverStaleJobs:recovered=1:failed=0',
      healedComponent: 'worker_queue'
    });
    recordSelfHealEvent({
      kind: 'failure',
      source: 'self_heal_loop',
      trigger: 'verification',
      reason: 'latency remained elevated',
      actionTaken: 'activatePromptRouteMitigation:reduced_latency',
      healedComponent: 'prompt_route'
    });
    recordSelfHealEvent({
      kind: 'fallback',
      source: 'request_context',
      trigger: 'request.completed',
      reason: 'prompt_route_degraded_mode',
      actionTaken: 'serve_degraded_response',
      healedComponent: 'prompt_route'
    });

    const snapshot = buildSelfHealTelemetrySnapshot({
      enabled: true,
      active: true,
      currentActionTaken: 'activatePromptRouteMitigation:reduced_latency',
      currentHealedComponent: 'prompt_route'
    });
    const compact = buildCompactSelfHealSummary(snapshot);

    expect(snapshot).toEqual(expect.objectContaining({
      enabled: true,
      active: true,
      triggerReason: 'worker stall detected',
      actionTaken: 'recoverStaleJobs:recovered=1:failed=0',
      healedComponent: 'worker_queue',
      lastTrigger: expect.objectContaining({
        kind: 'trigger',
        reason: 'worker stall detected'
      }),
      lastAttempt: expect.objectContaining({
        kind: 'attempt',
        actionTaken: 'recoverStaleJobs'
      }),
      lastSuccess: expect.objectContaining({
        kind: 'success',
        actionTaken: 'recoverStaleJobs:recovered=1:failed=0'
      }),
      lastFailure: expect.objectContaining({
        kind: 'failure',
        actionTaken: 'activatePromptRouteMitigation:reduced_latency'
      }),
      lastFallback: expect.objectContaining({
        kind: 'fallback',
        actionTaken: 'serve_degraded_response'
      })
    }));
    expect(snapshot.recentEvents).toHaveLength(5);
    expect(compact).toEqual(expect.objectContaining({
      enabled: true,
      active: true,
      triggerReason: 'worker stall detected',
      actionTaken: 'recoverStaleJobs:recovered=1:failed=0',
      healedComponent: 'worker_queue',
      recentEventCount: 5,
      detailsPath: '/status/safety/self-heal'
    }));
  });

  it('restores persisted telemetry after an in-process reset when a persistence file is configured', () => {
    process.env.NODE_ENV = 'test';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcanos-self-heal-'));
    process.env.SELF_HEAL_TELEMETRY_FILE = path.join(tempDir, 'self-heal-telemetry.json');
    resetSelfHealTelemetryForTests();

    recordSelfHealEvent({
      kind: 'fallback',
      source: 'request_context',
      trigger: 'request.completed',
      reason: 'fallback_handler_test',
      actionTaken: 'serve_degraded_response',
      healedComponent: 'route:/api/fallback/test'
    });

    resetSelfHealTelemetryForTests({ clearPersistence: false });

    const restoredSnapshot = buildSelfHealTelemetrySnapshot({
      enabled: true,
      active: false
    });

    expect(restoredSnapshot.lastFallback).toEqual(expect.objectContaining({
      kind: 'fallback',
      reason: 'fallback_handler_test',
      actionTaken: 'serve_degraded_response'
    }));
    expect(restoredSnapshot.recentEvents).toHaveLength(1);
    expect(restoredSnapshot.persistence).toEqual(expect.objectContaining({
      mode: 'explicit_file',
      restoredFromDisk: true,
      lastLoadedAt: expect.any(String),
      lastSavedAt: expect.any(String)
    }));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
