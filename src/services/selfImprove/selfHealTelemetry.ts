import fs from 'fs';
import path from 'path';
import { createClient } from 'redis';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getEnv } from '@platform/runtime/env.js';
import { resolveConfiguredRedisConnection } from '@platform/runtime/redis.js';
import { readJsonFileSafely } from '@shared/jsonFileUtils.js';

export type SelfHealEventKind =
  | 'trigger'
  | 'attempt'
  | 'success'
  | 'failure'
  | 'noop'
  | 'fallback'
  | 'AI_DIAGNOSIS_REQUEST'
  | 'AI_DIAGNOSIS_RESULT';

export interface SelfHealEvent {
  id: string;
  timestamp: string;
  kind: SelfHealEventKind;
  source: string;
  trigger: string | null;
  reason: string | null;
  actionTaken: string | null;
  healedComponent: string | null;
  details: Record<string, unknown> | null;
}

interface SelfHealTelemetryState {
  hydrated: boolean;
  nextSequence: number;
  recentEvents: SelfHealEvent[];
  lastTrigger: SelfHealEvent | null;
  lastAttempt: SelfHealEvent | null;
  lastSuccess: SelfHealEvent | null;
  lastFailure: SelfHealEvent | null;
  lastFallback: SelfHealEvent | null;
  persistence: SelfHealTelemetryPersistenceSnapshot;
}

export type SelfHealTelemetryPersistenceMode = 'redis' | 'explicit_file' | 'railway_volume' | 'local_memory_dir';

export interface SelfHealTelemetryPersistenceSnapshot {
  mode: SelfHealTelemetryPersistenceMode;
  durable: boolean;
  restoredFromDisk: boolean;
  lastLoadedAt: string | null;
  lastSavedAt: string | null;
  lastSaveError: string | null;
}

export interface SelfHealTelemetrySnapshot {
  enabled: boolean;
  active: boolean;
  lastTrigger: SelfHealEvent | null;
  lastAttempt: SelfHealEvent | null;
  lastSuccess: SelfHealEvent | null;
  lastFailure: SelfHealEvent | null;
  lastFallback: SelfHealEvent | null;
  triggerReason: string | null;
  actionTaken: string | null;
  healedComponent: string | null;
  recentEvents: SelfHealEvent[];
  persistence: SelfHealTelemetryPersistenceSnapshot;
}

export interface SelfHealCompactSummary {
  enabled: boolean;
  active: boolean;
  lastEventAt: string | null;
  lastEventKind: SelfHealEventKind | null;
  lastTriggerAt: string | null;
  lastAttemptAt: string | null;
  triggerReason: string | null;
  actionTaken: string | null;
  healedComponent: string | null;
  recentEventCount: number;
  detailsPath: '/status/safety/self-heal';
}

type SelfHealTelemetryGlobal = typeof globalThis & {
  __ARCANOS_SELF_HEAL_TELEMETRY__?: SelfHealTelemetryState;
};

const GLOBAL_KEY = '__ARCANOS_SELF_HEAL_TELEMETRY__';
const MAX_RECENT_EVENTS = 25;
const PERSISTENCE_VERSION = 1;
const PERSISTENCE_SAVE_DEBOUNCE_MS = 100;

interface SelfHealTelemetryPersistenceTarget {
  mode: SelfHealTelemetryPersistenceMode;
  durable: boolean;
  filePath?: string;
  redisKey?: string;
}

interface PersistedSelfHealTelemetryState {
  version: number;
  storedAt: string | null;
  nextSequence: number;
  recentEvents: SelfHealEvent[];
  lastTrigger: SelfHealEvent | null;
  lastAttempt: SelfHealEvent | null;
  lastSuccess: SelfHealEvent | null;
  lastFailure: SelfHealEvent | null;
  lastFallback: SelfHealEvent | null;
}

let pendingPersistenceTimeout: NodeJS.Timeout | null = null;
let redisClientPromise: Promise<SelfHealTelemetryRedisClient | null> | null = null;

type SelfHealTelemetryRedisClient = ReturnType<typeof createClient>;

function isPathWithin(basePath: string, candidatePath: string): boolean {
  const resolvedBasePath = path.resolve(basePath);
  const resolvedCandidatePath = path.resolve(candidatePath);

  return (
    resolvedCandidatePath === resolvedBasePath ||
    resolvedCandidatePath.startsWith(`${resolvedBasePath}${path.sep}`)
  );
}

function resolvePersistenceTarget(): SelfHealTelemetryPersistenceTarget {
  const explicitFilePath = getEnv('SELF_HEAL_TELEMETRY_FILE')?.trim();
  const railwayVolumePath = getEnv('RAILWAY_VOLUME_MOUNT_PATH')?.trim();
  const redisConnection = resolveConfiguredRedisConnection();

  if (explicitFilePath) {
    const resolvedExplicitFilePath = path.resolve(explicitFilePath);
    return {
      mode: 'explicit_file',
      filePath: resolvedExplicitFilePath,
      durable: Boolean(railwayVolumePath && isPathWithin(railwayVolumePath, resolvedExplicitFilePath))
    };
  }

  if (redisConnection.configured && redisConnection.url) {
    return {
      mode: 'redis',
      redisKey: resolveRedisPersistenceKey(),
      durable: true
    };
  }

  if (railwayVolumePath) {
    return {
      mode: 'railway_volume',
      filePath: path.resolve(railwayVolumePath, 'telemetry', 'self-heal-telemetry.json'),
      durable: true
    };
  }

  return {
    mode: 'local_memory_dir',
    filePath: path.resolve(process.cwd(), 'memory', 'self-heal-telemetry.json'),
    durable: false
  };
}

function sanitizeRedisKeySegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-');
}

function resolveRedisPersistenceKey(): string {
  const serviceName = sanitizeRedisKeySegment(getEnv('RAILWAY_SERVICE_NAME') || 'local');
  const environmentName = sanitizeRedisKeySegment(
    getEnv('RAILWAY_ENVIRONMENT') ||
    getEnv('NODE_ENV') ||
    'unknown'
  );

  return `arcanos:self-heal:${serviceName}:${environmentName}:state`;
}

function createPersistenceSnapshot(): SelfHealTelemetryPersistenceSnapshot {
  const target = resolvePersistenceTarget();
  return {
    mode: target.mode,
    durable: target.durable,
    restoredFromDisk: false,
    lastLoadedAt: null,
    lastSavedAt: null,
    lastSaveError: null
  };
}

function createInitialState(): SelfHealTelemetryState {
  return {
    hydrated: false,
    nextSequence: 1,
    recentEvents: [],
    lastTrigger: null,
    lastAttempt: null,
    lastSuccess: null,
    lastFailure: null,
    lastFallback: null,
    persistence: createPersistenceSnapshot()
  };
}

function clonePersistenceSnapshot(
  snapshot: SelfHealTelemetryPersistenceSnapshot
): SelfHealTelemetryPersistenceSnapshot {
  return {
    ...snapshot
  };
}

function getMutableState(): SelfHealTelemetryState {
  const state = getOrCreateMutableState();
  hydrateStateFromPersistence(state);
  return state;
}

function getOrCreateMutableState(): SelfHealTelemetryState {
  const runtime = globalThis as SelfHealTelemetryGlobal;
  if (!runtime[GLOBAL_KEY]) {
    runtime[GLOBAL_KEY] = createInitialState();
  }
  return runtime[GLOBAL_KEY];
}

function normalizeEventKind(value: unknown): SelfHealEventKind | null {
  return value === 'trigger' ||
    value === 'attempt' ||
    value === 'success' ||
    value === 'failure' ||
    value === 'noop' ||
    value === 'fallback' ||
    value === 'AI_DIAGNOSIS_REQUEST' ||
    value === 'AI_DIAGNOSIS_RESULT'
    ? value
    : null;
}

function normalizePrimitive(value: unknown): string | number | boolean | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return undefined;
}

function normalizeDetailsValue(value: unknown): unknown {
  const primitive = normalizePrimitive(value);
  if (primitive !== undefined) {
    return primitive;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeDetailsValue(entry))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nextValue = normalizeDetailsValue((value as Record<string, unknown>)[key]);
    if (nextValue !== undefined) {
      normalized[key] = nextValue;
    }
  }

  return normalized;
}

function normalizeDetails(details: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!details) {
    return null;
  }

  const normalized = normalizeDetailsValue(details);
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : null;
}

function normalizeEvent(raw: unknown): SelfHealEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const kind = normalizeEventKind(candidate.kind);
  if (
    kind === null ||
    typeof candidate.id !== 'string' ||
    typeof candidate.timestamp !== 'string' ||
    typeof candidate.source !== 'string'
  ) {
    return null;
  }

  return {
    id: candidate.id,
    timestamp: candidate.timestamp,
    kind,
    source: candidate.source,
    trigger: typeof candidate.trigger === 'string' ? candidate.trigger : null,
    reason: typeof candidate.reason === 'string' ? candidate.reason : null,
    actionTaken: typeof candidate.actionTaken === 'string' ? candidate.actionTaken : null,
    healedComponent: typeof candidate.healedComponent === 'string' ? candidate.healedComponent : null,
    details: normalizeDetails(
      candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
        ? (candidate.details as Record<string, unknown>)
        : null
    )
  };
}

function findLatestEventByKind(events: SelfHealEvent[], kind: SelfHealEventKind): SelfHealEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind === kind) {
      return events[index] ?? null;
    }
  }

  return null;
}

function buildPersistedState(state: SelfHealTelemetryState): PersistedSelfHealTelemetryState {
  return {
    version: PERSISTENCE_VERSION,
    storedAt: new Date().toISOString(),
    nextSequence: state.nextSequence,
    recentEvents: state.recentEvents.map((event) => cloneEvent(event)!),
    lastTrigger: cloneEvent(state.lastTrigger),
    lastAttempt: cloneEvent(state.lastAttempt),
    lastSuccess: cloneEvent(state.lastSuccess),
    lastFailure: cloneEvent(state.lastFailure),
    lastFallback: cloneEvent(state.lastFallback)
  };
}

function normalizePersistedState(raw: unknown): PersistedSelfHealTelemetryState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const persistedState = raw as PersistedSelfHealTelemetryState;
  const recentEvents = Array.isArray(persistedState.recentEvents)
    ? persistedState.recentEvents
      .map((event) => normalizeEvent(event))
      .filter((event): event is SelfHealEvent => Boolean(event))
      .slice(-MAX_RECENT_EVENTS)
    : [];
  const nextSequence = Number.isFinite(Number(persistedState.nextSequence))
    ? Math.max(Math.trunc(Number(persistedState.nextSequence)), recentEvents.length + 1)
    : recentEvents.length + 1;

  return {
    version: Number.isFinite(Number(persistedState.version)) ? Math.trunc(Number(persistedState.version)) : 0,
    storedAt: typeof persistedState.storedAt === 'string' ? persistedState.storedAt : null,
    nextSequence,
    recentEvents,
    lastTrigger: normalizeEvent(persistedState.lastTrigger) ?? findLatestEventByKind(recentEvents, 'trigger'),
    lastAttempt: normalizeEvent(persistedState.lastAttempt) ?? findLatestEventByKind(recentEvents, 'attempt'),
    lastSuccess: normalizeEvent(persistedState.lastSuccess) ?? findLatestEventByKind(recentEvents, 'success'),
    lastFailure: normalizeEvent(persistedState.lastFailure) ?? findLatestEventByKind(recentEvents, 'failure'),
    lastFallback: normalizeEvent(persistedState.lastFallback) ?? findLatestEventByKind(recentEvents, 'fallback')
  };
}

function loadPersistedStateFromFile(target: SelfHealTelemetryPersistenceTarget): PersistedSelfHealTelemetryState | null {
  if (!target.filePath) {
    return null;
  }

  return normalizePersistedState(readJsonFileSafely<PersistedSelfHealTelemetryState>(target.filePath));
}

function applyPersistedState(
  state: SelfHealTelemetryState,
  persistedState: PersistedSelfHealTelemetryState | null,
  loadedAt: string
): void {
  state.persistence.lastLoadedAt = loadedAt;
  state.persistence.lastSaveError = null;

  if (!persistedState) {
    return;
  }

  state.nextSequence = persistedState.nextSequence;
  state.recentEvents = persistedState.recentEvents;
  state.lastTrigger = persistedState.lastTrigger;
  state.lastAttempt = persistedState.lastAttempt;
  state.lastSuccess = persistedState.lastSuccess;
  state.lastFailure = persistedState.lastFailure;
  state.lastFallback = persistedState.lastFallback;
  state.persistence.restoredFromDisk = true;
  state.persistence.lastSavedAt = persistedState.storedAt ?? state.persistence.lastSavedAt;
}

function hydrateStateFromPersistence(state: SelfHealTelemetryState): void {
  if (state.hydrated) {
    return;
  }

  const target = resolvePersistenceTarget();
  if (target.mode === 'redis') {
    return;
  }

  state.hydrated = true;
  applyPersistedState(state, loadPersistedStateFromFile(target), new Date().toISOString());
}

async function getRedisClient(): Promise<SelfHealTelemetryRedisClient | null> {
  const redisConnection = resolveConfiguredRedisConnection();
  if (!redisConnection.configured || !redisConnection.url) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      try {
        const redisClient = createClient({ url: redisConnection.url });
        redisClient.on('error', (error) => {
          console.warn(`[SELF-HEAL][TELEMETRY] redis error: ${resolveErrorMessage(error)}`);
        });
        await redisClient.connect();
        return redisClient;
      } catch (error) {
        console.warn(`[SELF-HEAL][TELEMETRY] redis unavailable: ${resolveErrorMessage(error)}`);
        return null;
      }
    })();
  }

  return redisClientPromise;
}

async function loadPersistedStateFromRedis(
  target: SelfHealTelemetryPersistenceTarget
): Promise<PersistedSelfHealTelemetryState | null> {
  if (!target.redisKey) {
    return null;
  }

  const redisClient = await getRedisClient();
  if (!redisClient) {
    return null;
  }

  try {
    const persistedStateRaw = await redisClient.get(target.redisKey);
    if (!persistedStateRaw) {
      return null;
    }

    return normalizePersistedState(JSON.parse(persistedStateRaw));
  } catch (error) {
    console.warn(`[SELF-HEAL][TELEMETRY] redis read failed: ${resolveErrorMessage(error)}`);
    return null;
  }
}

function persistStateToFile(state: SelfHealTelemetryState, target: SelfHealTelemetryPersistenceTarget): void {
  if (!target.filePath) {
    return;
  }

  const persistedState = buildPersistedState(state);

  try {
    fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
    fs.writeFileSync(target.filePath, JSON.stringify(persistedState, null, 2), 'utf8');
    state.persistence.lastSavedAt = persistedState.storedAt;
    state.persistence.lastSaveError = null;
  } catch (error) {
    state.persistence.lastSaveError = resolveErrorMessage(error);
    console.warn(`[SELF-HEAL][TELEMETRY] persistence write failed: ${state.persistence.lastSaveError}`);
  }
}

async function persistStateToRedis(
  state: SelfHealTelemetryState,
  target: SelfHealTelemetryPersistenceTarget
): Promise<void> {
  if (!target.redisKey) {
    return;
  }

  const redisClient = await getRedisClient();
  if (!redisClient) {
    state.persistence.lastSaveError = 'Redis client unavailable';
    return;
  }

  const persistedState = buildPersistedState(state);
  try {
    await redisClient.set(target.redisKey, JSON.stringify(persistedState));
    state.persistence.lastSavedAt = persistedState.storedAt;
    state.persistence.lastSaveError = null;
  } catch (error) {
    state.persistence.lastSaveError = resolveErrorMessage(error);
    console.warn(`[SELF-HEAL][TELEMETRY] redis write failed: ${state.persistence.lastSaveError}`);
  }
}

function persistStateNow(state: SelfHealTelemetryState): void {
  const target = resolvePersistenceTarget();
  if (target.mode === 'redis') {
    void persistStateToRedis(state, target);
    return;
  }

  persistStateToFile(state, target);
}

function schedulePersistence(state: SelfHealTelemetryState, options: { immediate?: boolean } = {}): void {
  if (pendingPersistenceTimeout) {
    clearTimeout(pendingPersistenceTimeout);
    pendingPersistenceTimeout = null;
  }

  if (options.immediate || process.env.NODE_ENV === 'test') {
    persistStateNow(state);
    return;
  }

  pendingPersistenceTimeout = setTimeout(() => {
    pendingPersistenceTimeout = null;
    persistStateNow(state);
  }, PERSISTENCE_SAVE_DEBOUNCE_MS);

  if (typeof pendingPersistenceTimeout.unref === 'function') {
    pendingPersistenceTimeout.unref();
  }
}

function cloneEvent(event: SelfHealEvent | null): SelfHealEvent | null {
  if (!event) {
    return null;
  }

  return {
    ...event,
    details: event.details ? normalizeDetails(event.details) : null
  };
}

function logSelfHealEvent(event: SelfHealEvent): void {
  console.log(
    `[SELF-HEAL][TELEMETRY] kind=${event.kind} source=${event.source} component=${event.healedComponent ?? 'unknown'} action=${event.actionTaken ?? 'none'} reason=${event.reason ?? 'none'}`
  );
}

function isMoreRecent(left: SelfHealEvent | null, right: SelfHealEvent | null): boolean {
  if (!left || !right) {
    return Boolean(left);
  }

  return Date.parse(left.timestamp) >= Date.parse(right.timestamp);
}

export function inferSelfHealComponentFromAction(actionTaken: string | null | undefined): string | null {
  if (!actionTaken) {
    return null;
  }

  if (actionTaken === 'enable_degraded_mode' || actionTaken === 'bypass_final_stage') {
    return 'trinity';
  }

  if (actionTaken === 'restart_service' || actionTaken === 'redeploy_service') {
    return 'service_runtime';
  }

  if (actionTaken.startsWith('recoverStaleJobs')) {
    return 'worker_queue';
  }

  if (actionTaken.startsWith('healWorkerRuntime')) {
    return 'worker_runtime';
  }

  if (
    actionTaken.startsWith('activatePromptRouteMitigation') ||
    actionTaken.startsWith('rollbackPromptRouteMitigation')
  ) {
    return 'prompt_route';
  }

  if (
    actionTaken.startsWith('activateTrinityMitigation:') ||
    actionTaken.startsWith('rollbackTrinityMitigation:')
  ) {
    const [, stage] = actionTaken.split(':');
    return stage ? `trinity.${stage}` : 'trinity';
  }

  return null;
}

export function inferSelfHealComponentFromRequest(params: {
  route: string;
  degradedModeReason?: string | null;
}): string {
  const route = params.route.trim();
  const reason = params.degradedModeReason?.trim().toLowerCase() ?? '';

  if (route === '/api/openai/prompt' || reason.includes('prompt_route')) {
    return 'prompt_route';
  }

  if (reason.includes('arcanos_core') || route === '/api/arcanos' || route.startsWith('/gpt')) {
    return 'arcanos_core';
  }

  if (route.startsWith('/worker-helper') || route.startsWith('/workers')) {
    return 'worker_runtime';
  }

  if (route.length === 0) {
    return 'request_route';
  }

  return `route:${route}`;
}

export function recordSelfHealEvent(input: {
  kind: SelfHealEventKind;
  source: string;
  trigger?: string | null;
  reason?: string | null;
  actionTaken?: string | null;
  healedComponent?: string | null;
  details?: Record<string, unknown> | null;
  timestamp?: string;
}): SelfHealEvent {
  const state = getMutableState();
  const timestamp = input.timestamp ?? new Date().toISOString();
  const actionTaken = input.actionTaken ?? null;
  const event: SelfHealEvent = {
    id: `self_heal_event_${state.nextSequence}`,
    timestamp,
    kind: input.kind,
    source: input.source,
    trigger: input.trigger ?? null,
    reason: input.reason ?? null,
    actionTaken,
    healedComponent: input.healedComponent ?? inferSelfHealComponentFromAction(actionTaken),
    details: normalizeDetails(input.details)
  };

  state.nextSequence += 1;
  state.recentEvents.push(event);
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents.splice(0, state.recentEvents.length - MAX_RECENT_EVENTS);
  }

  if (event.kind === 'trigger') {
    state.lastTrigger = event;
  } else if (event.kind === 'attempt') {
    state.lastAttempt = event;
  } else if (event.kind === 'success') {
    state.lastSuccess = event;
  } else if (event.kind === 'failure') {
    state.lastFailure = event;
  } else if (event.kind === 'fallback') {
    state.lastFallback = event;
  }

  schedulePersistence(state, {
    immediate:
      event.kind === 'success' ||
      event.kind === 'failure' ||
      event.kind === 'fallback' ||
      event.kind === 'noop' ||
      event.kind === 'AI_DIAGNOSIS_RESULT'
  });
  logSelfHealEvent(event);
  return cloneEvent(event)!;
}

export function buildSelfHealTelemetrySnapshot(params: {
  enabled: boolean;
  active: boolean;
  currentActionTaken?: string | null;
  currentHealedComponent?: string | null;
}): SelfHealTelemetrySnapshot {
  const state = getMutableState();
  const lastTrigger = cloneEvent(state.lastTrigger);
  const lastAttempt = cloneEvent(state.lastAttempt);
  const lastSuccess = cloneEvent(state.lastSuccess);
  const lastFailure = cloneEvent(state.lastFailure);
  const lastFallback = cloneEvent(state.lastFallback);
  const actionTaken =
    lastSuccess?.actionTaken ??
    lastAttempt?.actionTaken ??
    lastFailure?.actionTaken ??
    lastFallback?.actionTaken ??
    params.currentActionTaken ??
    null;
  const healedComponent =
    lastSuccess?.healedComponent ??
    lastAttempt?.healedComponent ??
    lastFailure?.healedComponent ??
    lastFallback?.healedComponent ??
    params.currentHealedComponent ??
    inferSelfHealComponentFromAction(params.currentActionTaken) ??
    null;

  return {
    enabled: params.enabled,
    active: params.active,
    lastTrigger,
    lastAttempt,
    lastSuccess,
    lastFailure,
    lastFallback,
    triggerReason: lastTrigger?.reason ?? lastFallback?.reason ?? null,
    actionTaken,
    healedComponent,
    recentEvents: state.recentEvents.map((event) => cloneEvent(event)!),
    persistence: clonePersistenceSnapshot(state.persistence)
  };
}

export function buildCompactSelfHealSummary(snapshot: SelfHealTelemetrySnapshot): SelfHealCompactSummary {
  const lastRecentEvent = snapshot.recentEvents.length > 0
    ? snapshot.recentEvents[snapshot.recentEvents.length - 1]
    : null;
  const lastOutcomeEvent = [snapshot.lastSuccess, snapshot.lastFailure, snapshot.lastFallback]
    .filter((event): event is SelfHealEvent => Boolean(event))
    .reduce<SelfHealEvent | null>((latest, event) => (isMoreRecent(event, latest) ? event : latest), null);

  return {
    enabled: snapshot.enabled,
    active: snapshot.active,
    lastEventAt: lastRecentEvent?.timestamp ?? null,
    lastEventKind: lastRecentEvent?.kind ?? lastOutcomeEvent?.kind ?? null,
    lastTriggerAt: snapshot.lastTrigger?.timestamp ?? null,
    lastAttemptAt: snapshot.lastAttempt?.timestamp ?? null,
    triggerReason: snapshot.triggerReason,
    actionTaken: snapshot.actionTaken,
    healedComponent: snapshot.healedComponent,
    recentEventCount: snapshot.recentEvents.length,
    detailsPath: '/status/safety/self-heal'
  };
}

export async function primeSelfHealTelemetryPersistence(): Promise<void> {
  const state = getOrCreateMutableState();
  if (state.hydrated) {
    return;
  }

  const target = resolvePersistenceTarget();
  state.hydrated = true;

  if (target.mode === 'redis') {
    applyPersistedState(state, await loadPersistedStateFromRedis(target), new Date().toISOString());
    return;
  }

  applyPersistedState(state, loadPersistedStateFromFile(target), new Date().toISOString());
}

export function resetSelfHealTelemetryForTests(options: { clearPersistence?: boolean } = {}): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }

  if (pendingPersistenceTimeout) {
    clearTimeout(pendingPersistenceTimeout);
    pendingPersistenceTimeout = null;
  }

  const runtime = globalThis as SelfHealTelemetryGlobal;
  runtime[GLOBAL_KEY] = createInitialState();

  const clearPersistence = options.clearPersistence !== false;
  const target = resolvePersistenceTarget();
  if (clearPersistence && target.filePath) {
    if (fs.existsSync(target.filePath)) {
      fs.unlinkSync(target.filePath);
    }
  }
}
