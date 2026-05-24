#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { redactCommand } from './railway-redaction.mjs';

export const RAILWAY_CONFIRM_TOKEN = 'I_UNDERSTAND_PRIVILEGED_RAILWAY_ACTION';

export const READONLY_ACTIONS = new Set([
  'railway.whoami',
  'railway.status',
  'railway.logs',
  'railway.variables.list',
  'railway.environment',
  'railway.service',
]);

export const PRIVILEGED_ACTIONS = new Set([
  'railway.restart',
  'railway.redeploy',
  'railway.up',
  'railway.variable.set',
  'railway.down',
  'railway.ssh',
  'railway.shell',
  'railway.delete',
  'railway.scale',
]);

const PRIVILEGED_COMMANDS = Object.freeze({
  'railway.restart': ['railway', 'restart'],
  'railway.redeploy': ['railway', 'redeploy'],
  'railway.up': ['railway', 'up'],
  'railway.variable.set': ['railway', 'variables', 'set'],
  'railway.down': ['railway', 'down'],
  'railway.ssh': ['railway', 'ssh'],
  'railway.shell': ['railway', 'shell'],
  'railway.delete': ['railway', 'delete'],
  'railway.scale': ['railway', 'scale'],
});

const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 500;

function basePolicy({ action, risk, requiresConfirmation, command, blockedByDefault = false }) {
  return {
    action,
    risk,
    requiresConfirmation,
    ...(blockedByDefault ? { blockedByDefault: true } : {}),
    command,
    trainingAllowedByDefault: false,
    redact: true,
  };
}

function validateScopedValue(value, field, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ code: `${field}_required`, field });
    return null;
  }

  const trimmed = value.trim();
  if (/[\0\r\n]/.test(trimmed) || trimmed.length > 200) {
    errors.push({ code: `${field}_invalid`, field });
    return null;
  }

  return trimmed;
}

function validateOptionalScopedValue(value, field, errors) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return validateScopedValue(value, field, errors);
}

function normalizeLimit(limit, errors) {
  if (limit === undefined || limit === null || limit === '') {
    return DEFAULT_LOG_LIMIT;
  }

  const numeric = Number(limit);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_LOG_LIMIT) {
    errors.push({ code: 'limit_invalid', min: 1, max: MAX_LOG_LIMIT });
    return null;
  }

  return numeric;
}

function buildReadonlyCommand({ action, service, environment, limit }, errors) {
  if (action === 'railway.whoami') {
    return ['railway', 'whoami', '--json'];
  }

  if (action === 'railway.environment') {
    const scopedEnvironment = validateScopedValue(environment, 'environment', errors);
    if (!scopedEnvironment) {
      return null;
    }
    return ['railway', 'environment', '--environment', scopedEnvironment, '--json'];
  }

  if (action === 'railway.service') {
    const scopedService = validateScopedValue(service, 'service', errors);
    if (!scopedService) {
      return null;
    }
    return ['railway', 'service', '--service', scopedService, '--json'];
  }

  if (action === 'railway.status') {
    validateOptionalScopedValue(service, 'service', errors);
    validateOptionalScopedValue(environment, 'environment', errors);
    if (errors.length > 0) {
      return null;
    }

    if (service || environment) {
      errors.push({ code: 'status_scope_unsupported' });
      return null;
    }

    return ['railway', 'status', '--json'];
  }

  const scopedService = validateScopedValue(service, 'service', errors);
  const scopedEnvironment = validateScopedValue(environment, 'environment', errors);
  if (!scopedService || !scopedEnvironment) {
    return null;
  }

  if (action === 'railway.variables.list') {
    return ['railway', 'variables', '--service', scopedService, '--environment', scopedEnvironment, '--json'];
  }

  if (limit !== undefined && limit !== null && limit !== '') {
    normalizeLimit(limit, errors);
  }
  if (errors.length > 0) {
    return null;
  }

  return ['railway', 'logs', '--service', scopedService, '--environment', scopedEnvironment, '--json'];
}

export function resolveRailwayPolicy({
  action,
  service,
  environment,
  limit,
  confirmToken,
} = {}) {
  const errors = [];
  const normalizedAction = typeof action === 'string' ? action.trim() : '';

  if (!normalizedAction) {
    return {
      ok: false,
      policy: null,
      errors: [{ code: 'action_required' }],
    };
  }

  if (PRIVILEGED_ACTIONS.has(normalizedAction)) {
    const policy = basePolicy({
      action: normalizedAction,
      risk: 'privileged',
      requiresConfirmation: true,
      blockedByDefault: true,
      command: PRIVILEGED_COMMANDS[normalizedAction] || ['railway'],
    });

    if (confirmToken !== RAILWAY_CONFIRM_TOKEN) {
      return {
        ok: false,
        policy,
        errors: [{ code: 'privileged_confirmation_required', action: normalizedAction }],
      };
    }

    return {
      ok: false,
      policy,
      errors: [{ code: 'privileged_action_blocked_by_default', action: normalizedAction }],
    };
  }

  if (!READONLY_ACTIONS.has(normalizedAction)) {
    return {
      ok: false,
      policy: null,
      errors: [{ code: 'unknown_action', action: normalizedAction }],
    };
  }

  const command = buildReadonlyCommand({
    action: normalizedAction,
    service,
    environment,
    limit,
  }, errors);

  if (errors.length > 0 || !command) {
    return {
      ok: false,
      policy: basePolicy({
        action: normalizedAction,
        risk: 'readonly',
        requiresConfirmation: false,
        command: command || ['railway'],
      }),
      errors,
    };
  }

  return {
    ok: true,
    policy: basePolicy({
      action: normalizedAction,
      risk: 'readonly',
      requiresConfirmation: false,
      command,
    }),
    errors: [],
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--action' && next) {
      options.action = next;
      index += 1;
    } else if (flag === '--service' && next) {
      options.service = next;
      index += 1;
    } else if (flag === '--environment' && next) {
      options.environment = next;
      index += 1;
    } else if (flag === '--limit' && next) {
      options.limit = next;
      index += 1;
    } else if (flag === '--confirm-token' && next) {
      options.confirmToken = next;
      index += 1;
    } else {
      options.action = options.action || flag;
    }
  }

  const result = resolveRailwayPolicy(options);
  const output = {
    ...result,
    policy: result.policy
      ? { ...result.policy, command: redactCommand(result.policy.command) }
      : null,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
