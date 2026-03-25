export interface PromptRouteMitigationState {
  active: boolean;
  mode: 'degraded_response' | null;
  route: '/api/openai/prompt';
  activatedAt: string | null;
  updatedAt: string | null;
  reason: string | null;
}

export interface PromptRouteMitigationResult {
  applied: boolean;
  rolledBack: boolean;
  state: PromptRouteMitigationState;
  reason: string;
}

const GLOBAL_KEY = '__ARCANOS_PROMPT_ROUTE_MITIGATION__';

type PromptRouteMitigationGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: PromptRouteMitigationState;
};

function createInitialState(): PromptRouteMitigationState {
  return {
    active: false,
    mode: null,
    route: '/api/openai/prompt',
    activatedAt: null,
    updatedAt: null,
    reason: null
  };
}

function getMutableState(): PromptRouteMitigationState {
  const runtime = globalThis as PromptRouteMitigationGlobal;
  if (!runtime[GLOBAL_KEY]) {
    runtime[GLOBAL_KEY] = createInitialState();
  }

  return runtime[GLOBAL_KEY];
}

export function getPromptRouteMitigationState(): PromptRouteMitigationState {
  return {
    ...getMutableState()
  };
}

export function activatePromptRouteDegradedMode(reason: string): PromptRouteMitigationResult {
  const state = getMutableState();
  if (state.active && state.mode === 'degraded_response') {
    return {
      applied: false,
      rolledBack: false,
      state: { ...state },
      reason: 'already_active'
    };
  }

  const now = new Date().toISOString();
  state.active = true;
  state.mode = 'degraded_response';
  state.activatedAt = state.activatedAt ?? now;
  state.updatedAt = now;
  state.reason = reason;

  return {
    applied: true,
    rolledBack: false,
    state: { ...state },
    reason: 'applied'
  };
}

export function rollbackPromptRouteDegradedMode(reason: string): PromptRouteMitigationResult {
  const state = getMutableState();
  if (!state.active) {
    return {
      applied: false,
      rolledBack: false,
      state: { ...state },
      reason: 'not_active'
    };
  }

  state.active = false;
  state.mode = null;
  state.activatedAt = null;
  state.updatedAt = new Date().toISOString();
  state.reason = reason;

  return {
    applied: false,
    rolledBack: true,
    state: { ...state },
    reason: 'rolled_back'
  };
}

export function resetPromptRouteMitigationStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }

  const runtime = globalThis as PromptRouteMitigationGlobal;
  runtime[GLOBAL_KEY] = createInitialState();
}
