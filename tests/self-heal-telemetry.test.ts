import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  buildCompactSelfHealSummary,
  buildSelfHealTelemetrySnapshot,
  recordSelfHealEvent,
  resetSelfHealTelemetryForTests,
  subscribeSelfHealEventEmissions
} from '../src/services/selfImprove/selfHealTelemetry.js';

describe('selfHealTelemetry', () => {
  afterEach(() => {
    process.env.NODE_ENV = 'test';
    resetSelfHealTelemetryForTests();
    delete process.env.SELF_HEAL_TELEMETRY_FILE;
  });

  it('observes all process emissions independently of the bounded persisted ring', () => {
    resetSelfHealTelemetryForTests();
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const observed: number[] = [];
    const subscription = subscribeSelfHealEventEmissions((_event, sequence) => { observed.push(sequence); });
    try {
      for (let index = 0; index < 150; index += 1) recordSelfHealEvent({ kind: 'trigger', source: 'test-emission' });
      expect(subscription.baselineSequence).toBe(0);
      expect(observed).toEqual(Array.from({ length: 150 }, (_, index) => index + 1));
      expect(subscription.getCurrentSequence()).toBe(150);
      expect(buildSelfHealTelemetrySnapshot({ enabled: true, active: false }).recentEvents).toHaveLength(100);
      subscription.unsubscribe();
      recordSelfHealEvent({ kind: 'trigger', source: 'test-after-unsubscribe' });
      expect(observed).toHaveLength(150);
      expect(subscription.getCurrentSequence()).toBe(151);
      const subsequent = subscribeSelfHealEventEmissions(() => undefined);
      expect(subsequent.baselineSequence).toBe(151);
      subsequent.unsubscribe();
    } finally { subscription.unsubscribe(); log.mockRestore(); }
  });

  it('isolates throwing or mutating observers from other observers, history, and the caller', () => {
    resetSelfHealTelemetryForTests();
    const throwing = subscribeSelfHealEventEmissions(event => {
      (event.details?.nested as Record<string, unknown>).value = 'changed';
      event.kind = 'ACTION_EXECUTED';
      throw new Error('test-observer-error');
    });
    const observed = jest.fn();
    const healthy = subscribeSelfHealEventEmissions(observed);
    try {
      const event = recordSelfHealEvent({ kind: 'trigger', source: 'test-isolation', details: { nested: { value: 'original' } } });
      expect(event).toMatchObject({ kind: 'trigger', details: { nested: { value: 'original' } } });
      expect(observed).toHaveBeenCalledWith(event, 1);
      expect(buildSelfHealTelemetrySnapshot({ enabled: true, active: false }).recentEvents).toEqual([event]);
      expect(healthy.getCurrentSequence()).toBe(1);
    } finally { throwing.unsubscribe(); healthy.unsubscribe(); }
  });

  it('emits an accepted event before a later logging failure', () => {
    resetSelfHealTelemetryForTests();
    const observed = jest.fn();
    const subscription = subscribeSelfHealEventEmissions(observed);
    const log = jest.spyOn(console, 'log').mockImplementationOnce(() => { throw new Error('test-log-failed'); });
    try {
      expect(() => recordSelfHealEvent({ kind: 'attempt', source: 'test-logging' })).toThrow('test-log-failed');
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'attempt' }), 1);
      expect(subscription.getCurrentSequence()).toBe(1);
    } finally { subscription.unsubscribe(); log.mockRestore(); }
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
