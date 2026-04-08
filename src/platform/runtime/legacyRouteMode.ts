import { getEnv } from '@platform/runtime/env.js';

export type LegacyGptRouteMode = 'enabled' | 'disabled';

function normalizeLegacyRouteMode(value: string | undefined): LegacyGptRouteMode {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'enabled';
  }

  return normalized === 'disabled' || normalized === 'false' || normalized === '0' || normalized === 'no'
    ? 'disabled'
    : 'enabled';
}

export function resolveLegacyGptRouteMode(): LegacyGptRouteMode {
  return normalizeLegacyRouteMode(getEnv('LEGACY_GPT_ROUTES'));
}

export function legacyGptRoutesEnabled(): boolean {
  return resolveLegacyGptRouteMode() === 'enabled';
}
