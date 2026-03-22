#!/usr/bin/env node
/**
 * Purpose: Run a repeatable Railway smoke check against the production app, worker, Postgres, and Redis services.
 * Inputs/Outputs: Reads Railway CLI output plus the public health endpoint, prints PASS/WARN/FAIL lines to stdout, and exits non-zero when any critical check fails.
 * Edge cases: Handles missing Railway CLI binaries, malformed JSON payloads, quiet service logs, and noisy platform log lines without silently reporting a healthy system.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const RESULT_STATUS = Object.freeze({
  PASS: 'PASS',
  WARN: 'WARN',
  FAIL: 'FAIL'
});

const DEFAULTS = Object.freeze({
  environment: 'production',
  appService: 'ARCANOS V2',
  workerService: 'ARCANOS Worker',
  databaseService: '',
  redisService: '',
  appUrl: '',
  healthPath: '/healthz',
  appLogLines: 300,
  workerLogLines: 300,
  databaseLogLines: 500,
  redisLogLines: 200,
  requestTimeoutMs: 15000
});

/**
 * Purpose: Parse CLI arguments for the smoke check.
 * Inputs/Outputs: `argv` string array -> normalized configuration object.
 * Edge cases: Invalid numeric flags fall back to defaults so a typo cannot silently disable checks.
 *
 * @param {string[]} argv - Raw process arguments after the script path.
 * @returns {typeof DEFAULTS} Parsed configuration.
 */
export function parseArgs(argv) {
  const config = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const argFlag = argv[index];
    const next = argv[index + 1];

    //audit assumption: only explicit, recognized flags should mutate smoke-check behavior; failure risk: mistyped arguments weaken coverage; expected invariant: unknown flags leave defaults intact; handling strategy: ignore tokens that do not match a known flag.
    if (argFlag === '--environment' && typeof next === 'string' && next.trim().length > 0) {
      config.environment = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--app-service' && typeof next === 'string' && next.trim().length > 0) {
      config.appService = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--worker-service' && typeof next === 'string' && next.trim().length > 0) {
      config.workerService = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--database-service' && typeof next === 'string' && next.trim().length > 0) {
      config.databaseService = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--redis-service' && typeof next === 'string' && next.trim().length > 0) {
      config.redisService = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--app-url' && typeof next === 'string' && next.trim().length > 0) {
      config.appUrl = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--health-path' && typeof next === 'string' && next.trim().length > 0) {
      config.healthPath = next.trim();
      index += 1;
      continue;
    }

    //audit assumption: line limits must stay positive integers to bound CLI output and preserve determinism; failure risk: zero/negative values hide recent logs; expected invariant: each line limit > 0; handling strategy: parse-or-default on invalid input.
    if (
      (argFlag === '--app-log-lines' || argFlag === '--worker-log-lines' || argFlag === '--database-log-lines' || argFlag === '--redis-log-lines') &&
      typeof next === 'string' &&
      next.trim().length > 0
    ) {
      const parsed = Number(next);
      const normalized = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;

      if (normalized !== null) {
        if (argFlag === '--app-log-lines') {
          config.appLogLines = normalized;
        } else if (argFlag === '--worker-log-lines') {
          config.workerLogLines = normalized;
        } else if (argFlag === '--database-log-lines') {
          config.databaseLogLines = normalized;
        } else {
          config.redisLogLines = normalized;
        }
      }

      index += 1;
      continue;
    }

    if (argFlag === '--request-timeout-ms' && typeof next === 'string' && next.trim().length > 0) {
      const parsed = Number(next);
      config.requestTimeoutMs = Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : DEFAULTS.requestTimeoutMs;
      index += 1;
    }
  }

  return config;
}

/**
 * Purpose: Create a normalized smoke-check result entry.
 * Inputs/Outputs: Check name + status + detail -> serializable result object.
 * Edge cases: Trims detail strings so multiline command output does not pollute summaries.
 *
 * @param {string} name - Human-readable check name.
 * @param {'PASS'|'WARN'|'FAIL'} status - Result status.
 * @param {string} detail - Short explanation.
 * @returns {{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }}
 */
export function createResult(name, status, detail) {
  return {
    name,
    status,
    detail: detail.trim()
  };
}

/**
 * Purpose: Parse newline-delimited JSON log output from the Railway CLI.
 * Inputs/Outputs: Raw CLI string -> array of parsed entry objects.
 * Edge cases: Malformed or non-object log lines are dropped instead of crashing the smoke check.
 *
 * @param {string} rawOutput - Raw stdout from a `railway logs --json` command.
 * @returns {Array<Record<string, unknown>>} Parsed log entry objects.
 */
export function parseJsonLines(rawOutput) {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  /** @type {Array<Record<string, unknown>>} */
  const parsedEntries = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);

      //audit assumption: Railway JSON output is one object per line; failure risk: arrays or scalar values break downstream field access; expected invariant: parsed entries are plain objects; handling strategy: retain only object payloads.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedEntries.push(parsed);
      }
    } catch {
      //audit assumption: intermittent non-JSON lines should not invalidate otherwise usable logs; failure risk: one malformed line aborts the whole smoke check; expected invariant: valid lines remain processable; handling strategy: skip malformed lines.
    }
  }

  return parsedEntries;
}

/**
 * Purpose: Normalize a Railway service/environment snapshot for one target environment.
 * Inputs/Outputs: Parsed `railway status --json` payload + environment name -> lightweight topology snapshot.
 * Edge cases: Missing environment nodes or unexpected payload shapes throw hard errors because all later checks depend on the topology.
 *
 * @param {Record<string, any>} statusPayload - Parsed Railway status payload.
 * @param {string} environmentName - Target environment name.
 * @returns {{ projectName: string; workspaceName: string; environmentName: string; serviceInstances: Array<{ serviceId: string; name: string; latestDeploymentStatus: string; latestDeploymentCreatedAt: string | null; activeDeploymentStatuses: string[]; serviceDomains: string[]; customDomains: string[] }> }}
 */
export function extractEnvironmentSnapshot(statusPayload, environmentName) {
  const serviceNameMap = new Map(
    Array.isArray(statusPayload?.services?.edges)
      ? statusPayload.services.edges.map((edge) => [String(edge?.node?.id ?? ''), String(edge?.node?.name ?? '')])
      : []
  );

  const environments = Array.isArray(statusPayload?.environments?.edges)
    ? statusPayload.environments.edges
    : [];

  const environmentNode = environments.find((edge) => edge?.node?.name === environmentName)?.node;

  //audit assumption: smoke checks must target one concrete environment node; failure risk: querying the wrong environment produces false health conclusions; expected invariant: requested environment exists in Railway status output; handling strategy: throw a descriptive error when absent.
  if (!environmentNode) {
    throw new Error(`Environment "${environmentName}" was not found in Railway status output.`);
  }

  const serviceInstances = Array.isArray(environmentNode?.serviceInstances?.edges)
    ? environmentNode.serviceInstances.edges.map((edge) => {
        const node = edge?.node ?? {};
        const normalizedName = typeof node.serviceName === 'string' && node.serviceName.length > 0
          ? node.serviceName
          : serviceNameMap.get(String(node.serviceId ?? '')) || 'unknown-service';

        return {
          serviceId: String(node.serviceId ?? ''),
          name: normalizedName,
          latestDeploymentStatus: String(node.latestDeployment?.status ?? 'UNKNOWN'),
          latestDeploymentCreatedAt: typeof node.latestDeployment?.createdAt === 'string'
            ? node.latestDeployment.createdAt
            : null,
          activeDeploymentStatuses: Array.isArray(node.activeDeployments)
            ? node.activeDeployments
              .map((deployment) => String(deployment?.status ?? 'UNKNOWN'))
              .filter((status) => status.length > 0)
            : [],
          serviceDomains: Array.isArray(node.domains?.serviceDomains)
            ? node.domains.serviceDomains
              .map((domain) => String(domain?.domain ?? ''))
              .filter((domain) => domain.length > 0)
            : [],
          customDomains: Array.isArray(node.domains?.customDomains)
            ? node.domains.customDomains
              .map((domain) => String(domain?.domain ?? ''))
              .filter((domain) => domain.length > 0)
            : []
        };
      })
    : [];

  return {
    projectName: String(statusPayload?.name ?? 'unknown-project'),
    workspaceName: String(statusPayload?.workspace?.name ?? 'unknown-workspace'),
    environmentName,
    serviceInstances
  };
}

/**
 * Purpose: Resolve the app, worker, Postgres, and Redis services from the normalized environment snapshot.
 * Inputs/Outputs: Service instance list + optional explicit service names -> named role map.
 * Edge cases: Ambiguous heuristic matches fail loudly so the operator can pin service names explicitly.
 *
 * @param {Array<{ name: string; latestDeploymentStatus: string; latestDeploymentCreatedAt: string | null; activeDeploymentStatuses: string[]; serviceDomains: string[]; customDomains: string[] }>} serviceInstances - Normalized environment service instances.
 * @param {typeof DEFAULTS} config - Smoke-check configuration.
 * @returns {{ app: any; worker: any; database: any; redis: any }}
 */
export function findRoleServices(serviceInstances, config) {
  /**
   * Purpose: Resolve one service role from explicit naming or a heuristic predicate.
   * Inputs/Outputs: Role label + optional explicit name + heuristic predicate -> one normalized service object.
   * Edge cases: Multiple heuristic candidates throw to prevent silently checking the wrong service.
   *
   * @param {string} roleLabel - Human-readable role label.
   * @param {string} explicitName - Optional exact service name.
   * @param {(service: any) => boolean} predicate - Heuristic candidate matcher.
   * @returns {any}
   */
  function resolveRole(roleLabel, explicitName, predicate) {
    if (explicitName.trim().length > 0) {
      const exactMatch = serviceInstances.find((service) => service.name === explicitName);

      //audit assumption: explicit service names should win over heuristics when provided; failure risk: renamed services go unchecked; expected invariant: exact match exists for explicit names; handling strategy: fail immediately when an explicit service cannot be found.
      if (!exactMatch) {
        throw new Error(`Expected ${roleLabel} service "${explicitName}" was not found in Railway status output.`);
      }

      return exactMatch;
    }

    const candidates = serviceInstances.filter(predicate);

    //audit assumption: heuristics are safe only when they resolve to a single service; failure risk: multiple similarly named services produce false checks; expected invariant: zero or one candidate per role; handling strategy: throw on ambiguity and ask the operator to pin the role explicitly.
    if (candidates.length !== 1) {
      const candidateNames = candidates.map((service) => service.name).join(', ') || 'none';
      throw new Error(`Unable to resolve ${roleLabel} service unambiguously. Candidates: ${candidateNames}.`);
    }

    return candidates[0];
  }

  return {
    app: resolveRole('app', config.appService, (service) => /arcanos/i.test(service.name) && !/worker/i.test(service.name)),
    worker: resolveRole('worker', config.workerService, (service) => /worker/i.test(service.name)),
    database: resolveRole('database', config.databaseService, (service) => /^postgres/i.test(service.name)),
    redis: resolveRole('redis', config.redisService, (service) => /^redis/i.test(service.name))
  };
}

/**
 * Purpose: Evaluate app and worker environment-variable wiring against the expected production topology.
 * Inputs/Outputs: Resolved app/worker variable maps + environment name -> result list.
 * Edge cases: Missing URLs or mismatched hosts are treated as failures because the runtime cannot safely recover from broken backend wiring.
 *
 * @param {Record<string, string>} appVariables - Parsed `railway variables --json` map for the app service.
 * @param {Record<string, string>} workerVariables - Parsed `railway variables --json` map for the worker service.
 * @param {string} environmentName - Expected runtime environment.
 * @returns {Array<{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }>}
 */
export function evaluateRuntimeWiring(appVariables, workerVariables, environmentName) {
  const results = [];
  const requiredSharedKeys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'REDISHOST', 'REDISPORT', 'DATABASE_URL', 'REDIS_URL', 'NODE_ENV'];
  const recognizedNodeEnvironments = new Set(['development', 'production', 'test']);

  const missingAppKeys = requiredSharedKeys.filter((key) => !isNonEmptyString(appVariables[key]));
  const missingWorkerKeys = requiredSharedKeys.filter((key) => !isNonEmptyString(workerVariables[key]));

  //audit assumption: app and worker must expose the same core backend variables to operate against the same topology; failure risk: split-brain app/worker behavior; expected invariant: all required keys are present in both services; handling strategy: fail when required keys are missing.
  if (missingAppKeys.length > 0 || missingWorkerKeys.length > 0) {
    results.push(
      createResult(
        'Runtime variable completeness',
        RESULT_STATUS.FAIL,
        `Missing app keys=[${missingAppKeys.join(', ') || 'none'}], missing worker keys=[${missingWorkerKeys.join(', ') || 'none'}].`
      )
    );
  } else {
    results.push(
      createResult(
        'Runtime variable completeness',
        RESULT_STATUS.PASS,
        'App and worker both expose the expected Postgres and Redis connection variables.'
      )
    );
  }

  const appNodeEnvironment = normalizeString(appVariables.NODE_ENV);
  const workerNodeEnvironment = normalizeString(workerVariables.NODE_ENV);

  //audit assumption: Railway preview environments may intentionally run the same production runtime settings as the primary deployment; failure risk: smoke checks report false failures whenever the Railway environment label differs from NODE_ENV; expected invariant: app and worker agree on one recognized NODE_ENV value; handling strategy: validate shared runtime identity independently from the Railway environment name.
  if (
    !recognizedNodeEnvironments.has(appNodeEnvironment)
    || !recognizedNodeEnvironments.has(workerNodeEnvironment)
  ) {
    results.push(
      createResult(
        'Runtime environment identity',
        RESULT_STATUS.FAIL,
        `Expected app and worker NODE_ENV to be one of development, production, or test but saw app=${String(appVariables.NODE_ENV ?? '')}, worker=${String(workerVariables.NODE_ENV ?? '')}.`
      )
    );
  } else if (appNodeEnvironment !== workerNodeEnvironment) {
    results.push(
      createResult(
        'Runtime environment identity',
        RESULT_STATUS.FAIL,
        `Expected app and worker NODE_ENV to match but saw app=${appNodeEnvironment}, worker=${workerNodeEnvironment}.`
      )
    );
  } else {
    results.push(
      createResult(
        'Runtime environment identity',
        RESULT_STATUS.PASS,
        `App and worker both report NODE_ENV=${appNodeEnvironment} while targeting Railway environment ${environmentName}.`
      )
    );
  }

  //audit assumption: app and worker must point at the same backing Postgres and Redis hosts to share state safely; failure risk: divergent data planes; expected invariant: PGHOST and REDISHOST match across services; handling strategy: fail on any mismatch.
  if (appVariables.PGHOST !== workerVariables.PGHOST || appVariables.REDISHOST !== workerVariables.REDISHOST) {
    results.push(
      createResult(
        'Shared backend wiring',
        RESULT_STATUS.FAIL,
        `App and worker backend hosts do not match (app PGHOST=${String(appVariables.PGHOST ?? '')}, worker PGHOST=${String(workerVariables.PGHOST ?? '')}, app REDISHOST=${String(appVariables.REDISHOST ?? '')}, worker REDISHOST=${String(workerVariables.REDISHOST ?? '')}).`
      )
    );
  } else {
    results.push(
      createResult(
        'Shared backend wiring',
        RESULT_STATUS.PASS,
        `App and worker share PGHOST=${appVariables.PGHOST} and REDISHOST=${appVariables.REDISHOST}.`
      )
    );
  }

  //audit assumption: Railway private-network hosts should use the internal domain suffix for in-platform service-to-service traffic; failure risk: production traffic routed over public ingress unexpectedly; expected invariant: internal hostnames end with .railway.internal; handling strategy: warn so the operator can decide whether a public host is intentional.
  if (!String(appVariables.PGHOST || '').endsWith('.railway.internal') || !String(appVariables.REDISHOST || '').endsWith('.railway.internal')) {
    results.push(
      createResult(
        'Private-network host naming',
        RESULT_STATUS.WARN,
        `Expected internal Railway hostnames but saw PGHOST=${String(appVariables.PGHOST ?? '')}, REDISHOST=${String(appVariables.REDISHOST ?? '')}.`
      )
    );
  } else {
    results.push(
      createResult(
        'Private-network host naming',
        RESULT_STATUS.PASS,
        'App backend hosts use Railway internal networking.'
      )
    );
  }

  return results;
}

/**
 * Purpose: Evaluate recent application logs for positive health signals and unexpected runtime errors.
 * Inputs/Outputs: Parsed app log entries -> one result object.
 * Edge cases: Quiet but otherwise clean logs downgrade to WARN instead of FAIL because low traffic is not itself an outage.
 *
 * @param {Array<Record<string, unknown>>} entries - Parsed log entries.
 * @returns {{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }}
 */
export function evaluateAppLogEntries(entries) {
  if (entries.length === 0) {
    return createResult('App runtime logs', RESULT_STATUS.WARN, 'No recent app log entries were returned by Railway.');
  }

  const errorMessages = [];
  let hasHealthSignal = false;
  let hasTrafficSignal = false;

  for (const entry of entries) {
    const level = normalizeString(entry.level).toLowerCase();
    const message = normalizeString(entry.message);
    const event = normalizeString(entry.event);
    const path = normalizeString(entry.path);
    const statusCode = readStatusCode(entry);

    //audit assumption: app-level error logs should be rare during a healthy smoke-check window; failure risk: user-facing regressions go unnoticed; expected invariant: no recent `level=error` app entries; handling strategy: fail when explicit error logs are present.
    if (level === 'error') {
      errorMessages.push(message || `${event || 'event'} ${path || 'path'}`.trim());
    }

    if (message.includes('ARCANOS:HEALTH') || (event === 'request.completed' && path === '/healthz' && statusCode === 200)) {
      hasHealthSignal = true;
    }

    if (event === 'request.completed' && statusCode === 200) {
      hasTrafficSignal = true;
    }
  }

  if (errorMessages.length > 0) {
    return createResult(
      'App runtime logs',
      RESULT_STATUS.FAIL,
      `Detected recent app error logs. Example: ${errorMessages[0]}`
    );
  }

  if (hasHealthSignal || hasTrafficSignal) {
    return createResult(
      'App runtime logs',
      RESULT_STATUS.PASS,
      'Recent app logs contain healthy diagnostics and/or successful request completions.'
    );
  }

  return createResult(
    'App runtime logs',
    RESULT_STATUS.WARN,
    'App logs were readable but did not contain a recent health or request-completion signal.'
  );
}

/**
 * Purpose: Evaluate recent worker logs for successful activity and obvious runtime failures.
 * Inputs/Outputs: Parsed worker log entries -> one result object.
 * Edge cases: Quiet worker periods degrade to WARN instead of FAIL when no error signal is present.
 *
 * @param {Array<Record<string, unknown>>} entries - Parsed worker log entries.
 * @returns {{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }}
 */
export function evaluateWorkerLogEntries(entries) {
  if (entries.length === 0) {
    return createResult('Worker runtime logs', RESULT_STATUS.WARN, 'No recent worker log entries were returned by Railway.');
  }

  const errorMessages = [];
  let hasPositiveSignal = false;
  let hasDegradedBootstrap = false;

  for (const entry of entries) {
    const level = normalizeString(entry.level).toLowerCase();
    const message = normalizeString(entry.message);

    //audit assumption: explicit worker errors should fail the smoke check because job processing correctness is uncertain after an unhandled runtime fault; failure risk: queue work silently stalls; expected invariant: no recent worker `level=error` lines; handling strategy: fail immediately on error logs.
    if (level === 'error') {
      errorMessages.push(message || 'worker emitted an error log without a message');
    }

    if (/bootstrap status=degraded/i.test(message)) {
      hasDegradedBootstrap = true;
    }

    if (/query executed/i.test(message) || /bootstrap status=/i.test(message) || /jobrunner/i.test(message)) {
      hasPositiveSignal = true;
    }
  }

  if (errorMessages.length > 0) {
    return createResult(
      'Worker runtime logs',
      RESULT_STATUS.FAIL,
      `Detected recent worker error logs. Example: ${errorMessages[0]}`
    );
  }

  if (hasDegradedBootstrap) {
    return createResult(
      'Worker runtime logs',
      RESULT_STATUS.WARN,
      'Worker logs were readable but include a degraded bootstrap marker in the recent window.'
    );
  }

  if (hasPositiveSignal) {
    return createResult(
      'Worker runtime logs',
      RESULT_STATUS.PASS,
      'Recent worker logs show activity such as DB queries or bootstrap markers without explicit errors.'
    );
  }

  return createResult(
    'Worker runtime logs',
    RESULT_STATUS.WARN,
    'Worker logs were readable but did not contain a recent activity marker.'
  );
}

/**
 * Purpose: Evaluate recent Postgres logs for active fatal conditions while ignoring routine checkpoint noise.
 * Inputs/Outputs: Parsed database log entries -> one result object.
 * Edge cases: Railway may map Postgres `LOG:` lines to higher-severity shells, so message content is used instead of the wrapper severity field.
 *
 * @param {Array<Record<string, unknown>>} entries - Parsed Postgres log entries.
 * @returns {{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }}
 */
export function evaluateDatabaseLogEntries(entries) {
  if (entries.length === 0) {
    return createResult('Database runtime logs', RESULT_STATUS.WARN, 'No recent Postgres log entries were returned by Railway.');
  }

  const fatalMessages = [];
  let hasRoutineSignal = false;

  for (const entry of entries) {
    const message = normalizeString(entry.message);

    //audit assumption: schema-mismatch or fatal database messages represent active production risk even if the service process is still alive; failure risk: the app appears healthy while queries fail; expected invariant: no recent FATAL/PANIC/schema-missing markers; handling strategy: fail when those markers appear.
    if (/\sFATAL:/i.test(message) || /\sPANIC:/i.test(message) || /relation "User" does not exist/i.test(message)) {
      fatalMessages.push(message);
    }

    if (/checkpoint complete/i.test(message) || /database system is ready to accept connections/i.test(message) || /\sLOG:/i.test(message)) {
      hasRoutineSignal = true;
    }
  }

  if (fatalMessages.length > 0) {
    return createResult(
      'Database runtime logs',
      RESULT_STATUS.FAIL,
      `Detected recent Postgres failure markers. Example: ${fatalMessages[0]}`
    );
  }

  if (hasRoutineSignal) {
    return createResult(
      'Database runtime logs',
      RESULT_STATUS.PASS,
      'Recent Postgres logs show routine activity without fatal or schema-mismatch markers.'
    );
  }

  return createResult(
    'Database runtime logs',
    RESULT_STATUS.WARN,
    'Postgres logs were readable but did not contain a routine checkpoint or readiness signal.'
  );
}

/**
 * Purpose: Evaluate recent Redis logs for readiness and actionable warnings.
 * Inputs/Outputs: Parsed Redis log entries -> one result object.
 * Edge cases: The standard kernel overcommit warning remains visible, but a ready Redis instance is treated as healthy because Railway does not expose host-level sysctl tuning for service containers.
 *
 * @param {Array<Record<string, unknown>>} entries - Parsed Redis log entries.
 * @returns {{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }}
 */
export function evaluateRedisLogEntries(entries) {
  if (entries.length === 0) {
    return createResult('Redis runtime logs', RESULT_STATUS.WARN, 'No recent Redis log entries were returned by Railway.');
  }

  let hasReadySignal = false;
  let hasOvercommitWarning = false;
  const fatalMessages = [];

  for (const entry of entries) {
    const message = normalizeString(entry.message);

    //audit assumption: Redis fatal startup or persistence failures invalidate queue/cache health even if the deployment record says SUCCESS; failure risk: app can connect intermittently to a broken cache; expected invariant: no fatal Redis messages in the scanned window; handling strategy: fail on known fatal markers.
    if (/fatal/i.test(message) || /oom command not allowed/i.test(message) || /background save may fail/i.test(message) && !/Memory overcommit must be enabled/i.test(message)) {
      fatalMessages.push(message);
    }

    if (/Memory overcommit must be enabled/i.test(message)) {
      hasOvercommitWarning = true;
    }

    if (/Ready to accept connections/i.test(message)) {
      hasReadySignal = true;
    }
  }

  if (fatalMessages.length > 0) {
    return createResult(
      'Redis runtime logs',
      RESULT_STATUS.FAIL,
      `Detected recent Redis failure markers. Example: ${fatalMessages[0]}`
    );
  }

  //audit assumption: Railway-managed Redis can emit the vm.overcommit_memory advisory even when the instance is healthy and persisting successfully; failure risk: host-level noise degrades the smoke-check summary and obscures real failures; expected invariant: a recent readiness marker is sufficient to treat the Redis role as healthy unless fatal markers are also present; handling strategy: return PASS while keeping the advisory text in the detail.
  if (hasReadySignal && hasOvercommitWarning) {
    return createResult(
      'Redis runtime logs',
      RESULT_STATUS.PASS,
      'Redis reports ready-to-accept-connections; the standard vm.overcommit_memory advisory remains visible in Railway startup logs but is treated as non-actionable host-level noise.'
    );
  }

  if (hasReadySignal) {
    return createResult(
      'Redis runtime logs',
      RESULT_STATUS.PASS,
      'Redis reports ready-to-accept-connections in the scanned window.'
    );
  }

  if (hasOvercommitWarning) {
    return createResult(
      'Redis runtime logs',
      RESULT_STATUS.WARN,
      'Redis logs are readable but only the vm.overcommit_memory advisory was found in the scanned window.'
    );
  }

  return createResult(
    'Redis runtime logs',
    RESULT_STATUS.WARN,
    'Redis logs were readable but did not contain a recent readiness marker.'
  );
}

/**
 * Purpose: Execute the end-to-end smoke check workflow.
 * Inputs/Outputs: Normalized configuration -> ordered result list.
 * Edge cases: Critical Railway CLI failures are captured as FAIL results and short-circuit dependent checks.
 *
 * @param {typeof DEFAULTS} config - Smoke-check configuration.
 * @returns {Promise<Array<{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }>>}
 */
export async function runSmokeCheck(config) {
  /** @type {Array<{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }>} */
  const results = [];

  try {
    const railwayVersion = executeRailwayCommand(['--version']).trim();
    results.push(createResult('Railway CLI', RESULT_STATUS.PASS, railwayVersion));
  } catch (error) {
    results.push(createResult('Railway CLI', RESULT_STATUS.FAIL, formatCommandError(error)));
    return results;
  }

  try {
    const activationMessage = executeRailwayCommand(['environment', config.environment]).trim();
    results.push(createResult('Railway environment activation', RESULT_STATUS.PASS, activationMessage || `Activated ${config.environment}.`));
  } catch (error) {
    results.push(createResult('Railway environment activation', RESULT_STATUS.FAIL, formatCommandError(error)));
    return results;
  }

  let environmentSnapshot;
  let roleServices;
  try {
    const statusPayload = readJsonCommand(['status', '--json']);
    environmentSnapshot = extractEnvironmentSnapshot(statusPayload, config.environment);
    roleServices = findRoleServices(environmentSnapshot.serviceInstances, config);
    results.push(
      createResult(
        'Topology discovery',
        RESULT_STATUS.PASS,
        `Project=${environmentSnapshot.projectName}, workspace=${environmentSnapshot.workspaceName}, app=${roleServices.app.name}, worker=${roleServices.worker.name}, database=${roleServices.database.name}, redis=${roleServices.redis.name}.`
      )
    );
  } catch (error) {
    results.push(createResult('Topology discovery', RESULT_STATUS.FAIL, formatCommandError(error)));
    return results;
  }

  for (const [roleLabel, service] of Object.entries(roleServices)) {
    //audit assumption: successful latest deployments are the minimum baseline for a healthy smoke-check role; failure risk: stale or failed deploys hide broken services; expected invariant: latest deployment status is SUCCESS; handling strategy: fail role checks when the latest deployment is not successful.
    if (service.latestDeploymentStatus !== 'SUCCESS') {
      results.push(
        createResult(
          `${capitalize(roleLabel)} deployment state`,
          RESULT_STATUS.FAIL,
          `${service.name} latest deployment status is ${service.latestDeploymentStatus}.`
        )
      );
    } else {
      results.push(
        createResult(
          `${capitalize(roleLabel)} deployment state`,
          RESULT_STATUS.PASS,
          `${service.name} latest deployment is SUCCESS${service.latestDeploymentCreatedAt ? ` at ${service.latestDeploymentCreatedAt}` : ''}.`
        )
      );
    }
  }

  let appVariables;
  let workerVariables;
  try {
    appVariables = readJsonCommand(['variables', '--service', roleServices.app.name, '--json']);
    workerVariables = readJsonCommand(['variables', '--service', roleServices.worker.name, '--json']);
    results.push(...evaluateRuntimeWiring(appVariables, workerVariables, config.environment));
  } catch (error) {
    results.push(createResult('Runtime wiring', RESULT_STATUS.FAIL, formatCommandError(error)));
    return results;
  }

  try {
    const healthUrl = resolveHealthUrl(appVariables, roleServices.app, config);
    const healthResult = await requestHealthCheck(
      healthUrl,
      config,
      normalizeString(appVariables.NODE_ENV)
    );
    results.push(healthResult);
  } catch (error) {
    results.push(createResult('App public health endpoint', RESULT_STATUS.FAIL, formatCommandError(error)));
  }

  results.push(readAndEvaluateLogs(roleServices.app.name, config.environment, config.appLogLines, evaluateAppLogEntries));
  results.push(readAndEvaluateLogs(roleServices.worker.name, config.environment, config.workerLogLines, evaluateWorkerLogEntries));
  results.push(readAndEvaluateLogs(roleServices.database.name, config.environment, config.databaseLogLines, evaluateDatabaseLogEntries));
  results.push(readAndEvaluateLogs(roleServices.redis.name, config.environment, config.redisLogLines, evaluateRedisLogEntries));

  return results;
}

/**
 * Purpose: Print the ordered result list in a compact operator-friendly format.
 * Inputs/Outputs: Result array -> stdout lines.
 * Edge cases: Long details remain on one line so copy/paste into incident notes stays simple.
 *
 * @param {Array<{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }>} results - Smoke-check result list.
 * @returns {void}
 */
export function printResults(results) {
  for (const result of results) {
    process.stdout.write(`[${result.status}] ${result.name}: ${result.detail}\n`);
  }

  const failCount = results.filter((result) => result.status === RESULT_STATUS.FAIL).length;
  const warnCount = results.filter((result) => result.status === RESULT_STATUS.WARN).length;
  const passCount = results.filter((result) => result.status === RESULT_STATUS.PASS).length;
  const overall = failCount > 0 ? RESULT_STATUS.FAIL : warnCount > 0 ? RESULT_STATUS.WARN : RESULT_STATUS.PASS;

  process.stdout.write(`Summary: overall=${overall} pass=${passCount} warn=${warnCount} fail=${failCount}\n`);
}

/**
 * Purpose: Read one Railway log stream and evaluate it with a role-specific analyzer.
 * Inputs/Outputs: Service name + environment + line limit + evaluator -> result object.
 * Edge cases: CLI failures are converted into FAIL results so the smoke check does not silently skip a role.
 *
 * @param {string} serviceName - Railway service name.
 * @param {string} environmentName - Railway environment name.
 * @param {number} lineLimit - Maximum number of log lines to request.
 * @param {(entries: Array<Record<string, unknown>>) => { name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }} evaluator - Role-specific log evaluator.
 * @returns {{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }}
 */
function readAndEvaluateLogs(serviceName, environmentName, lineLimit, evaluator) {
  try {
    const rawLogs = executeRailwayCommand([
      'logs',
      '--deployment',
      '--json',
      '--lines',
      String(lineLimit),
      '--service',
      serviceName,
      '--environment',
      environmentName
    ]);

    return evaluator(parseJsonLines(rawLogs));
  } catch (error) {
    return createResult(`${serviceName} logs`, RESULT_STATUS.FAIL, formatCommandError(error));
  }
}

/**
 * Purpose: Resolve the public health-check URL for the app service.
 * Inputs/Outputs: App variable map + normalized app service object + config -> absolute URL string.
 * Edge cases: Missing public domains throw because the smoke check cannot validate app ingress without one.
 *
 * @param {Record<string, string>} appVariables - Parsed app variables.
 * @param {{ serviceDomains: string[]; customDomains: string[] }} appService - Normalized app service.
 * @param {typeof DEFAULTS} config - Smoke-check configuration.
 * @returns {string}
 */
function resolveHealthUrl(appVariables, appService, config) {
  const rawDomain = config.appUrl
    || normalizeString(appVariables.RAILWAY_STATIC_URL)
    || appService.customDomains[0]
    || appService.serviceDomains[0];

  //audit assumption: the public ingress check requires one resolvable app domain; failure risk: smoke check validates only private wiring and misses ingress breakage; expected invariant: app URL or domain is configured; handling strategy: throw when no public target can be derived.
  if (!isNonEmptyString(rawDomain)) {
    throw new Error('Unable to resolve a public app URL for the health check.');
  }

  const normalizedBase = /^https?:\/\//i.test(rawDomain) ? rawDomain : `https://${rawDomain}`;
  return `${normalizedBase.replace(/\/+$/, '')}${config.healthPath.startsWith('/') ? config.healthPath : `/${config.healthPath}`}`;
}

/**
 * Purpose: Fetch and validate the app health endpoint.
 * Inputs/Outputs: Health URL + config -> one result object.
 * Edge cases: Non-JSON bodies or mismatched environments fail because the endpoint contract is part of the smoke check.
 *
 * @param {string} healthUrl - Absolute health endpoint URL.
 * @param {typeof DEFAULTS} config - Smoke-check configuration.
 * @param {string} expectedNodeEnvironment - Expected `NODE_ENV` reported by the app service.
 * @returns {Promise<{ name: string; status: 'PASS'|'WARN'|'FAIL'; detail: string }>}
 */
export async function requestHealthCheck(healthUrl, config, expectedNodeEnvironment) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(healthUrl, {
      headers: {
        'user-agent': 'arcanos-railway-production-smoke-check/1.0'
      },
      signal: abortController.signal
    });

    const bodyText = await response.text();
    let parsedBody = null;

    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      //audit assumption: ARCANOS health endpoint should return JSON, but parse failures should still report the HTTP status; failure risk: endpoint regressions are hidden behind generic request failures; expected invariant: JSON body when healthy; handling strategy: continue with null parsedBody and fail with body preview if needed.
    }

    const usesLegacyHealthContract =
      Boolean(parsedBody)
      && parsedBody.ok === true
      && parsedBody.env === expectedNodeEnvironment;
    const usesCurrentHealthContract =
      Boolean(parsedBody)
      && normalizeString(parsedBody.status).toLowerCase() === 'ok'
      && isNonEmptyString(parsedBody.service);

    //audit assumption: the public health endpoint can legitimately expose either the legacy `{ ok, env }` contract or the current `{ status, service, ... }` contract during rollout windows; failure risk: a healthy ingress check fails solely because the payload shape evolved; expected invariant: status 200 with one recognized JSON health schema; handling strategy: accept both known contracts and fail only when neither shape matches.
    if (!response.ok || !parsedBody || (!usesLegacyHealthContract && !usesCurrentHealthContract)) {
      return createResult(
        'App public health endpoint',
        RESULT_STATUS.FAIL,
        `Health check failed for ${healthUrl} with status=${response.status}, body=${truncate(bodyText, 220)}`
      );
    }

    if (usesLegacyHealthContract) {
      return createResult(
        'App public health endpoint',
        RESULT_STATUS.PASS,
        `GET ${healthUrl} returned ${response.status} with ok=true and env=${parsedBody.env}.`
      );
    }

    return createResult(
      'App public health endpoint',
      RESULT_STATUS.PASS,
      `GET ${healthUrl} returned ${response.status} with status=${parsedBody.status} and service=${parsedBody.service}.`
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Purpose: Execute one Railway CLI command with Windows-friendly fallbacks.
 * Inputs/Outputs: Railway argument vector -> raw stdout string.
 * Edge cases: Retries with `.exe`, shell mode, and the PowerShell shim to tolerate Windows PATH aliasing.
 *
 * @param {string[]} args - Railway CLI argument vector.
 * @returns {string}
 */
function executeRailwayCommand(args) {
  const execOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  };

  const candidates = process.platform === 'win32'
    ? [
        { file: 'railway', args, options: execOptions },
        { file: 'railway.exe', args, options: execOptions }
      ]
    : [{ file: 'railway', args, options: execOptions }];

  let lastError = null;

  for (const candidate of candidates) {
    try {
      return execFileSync(candidate.file, candidate.args, candidate.options);
    } catch (error) {
      lastError = error;

      //audit assumption: ENOENT on Windows can mean the shell alias path was not resolved rather than a truly missing CLI; failure risk: false-negative tool detection; expected invariant: non-ENOENT execution failures should surface immediately; handling strategy: continue only for ENOENT candidates.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const railwayShimPath = join(appData, 'npm', 'railway.ps1');

    //audit assumption: npm global installs place the PowerShell shim under %APPDATA%\npm; failure risk: the CLI exists but direct spawn misses it; expected invariant: shim path exists when Railway was installed through npm; handling strategy: invoke the shim with PowerShell bypass as a final fallback.
    if (existsSync(railwayShimPath)) {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', railwayShimPath, ...args],
        execOptions
      );
    }
  }

  throw lastError || new Error('Failed to execute the Railway CLI.');
}

/**
 * Purpose: Execute a Railway command that returns one JSON document.
 * Inputs/Outputs: Railway argument vector -> parsed JSON object.
 * Edge cases: Invalid JSON throws a descriptive error instead of returning partial data.
 *
 * @param {string[]} args - Railway CLI argument vector.
 * @returns {Record<string, any>}
 */
function readJsonCommand(args) {
  const rawOutput = executeRailwayCommand(args).trim();

  //audit assumption: the targeted Railway commands return one complete JSON payload when `--json` is supplied; failure risk: malformed payloads lead to partial health conclusions; expected invariant: JSON.parse succeeds for the full payload; handling strategy: throw with command context on parse failure.
  try {
    return JSON.parse(rawOutput);
  } catch (error) {
    throw new Error(`Failed to parse JSON from Railway command "${args.join(' ')}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Purpose: Read a normalized HTTP status code from a parsed log entry.
 * Inputs/Outputs: Log entry object -> number or null.
 * Edge cases: String status codes are parsed numerically; missing values return null.
 *
 * @param {Record<string, unknown>} entry - Parsed log entry.
 * @returns {number | null}
 */
function readStatusCode(entry) {
  const rawData = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
    ? entry.data
    : {};
  const statusCodeCandidate = rawData.statusCode;

  if (typeof statusCodeCandidate === 'number') {
    return statusCodeCandidate;
  }

  const parsed = Number(statusCodeCandidate);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Purpose: Normalize unknown input values into safe strings.
 * Inputs/Outputs: unknown value -> trimmed string.
 * Edge cases: Nullish values normalize to the empty string.
 *
 * @param {unknown} value - Any runtime value.
 * @returns {string}
 */
function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Purpose: Check whether a value is a non-empty string after trimming.
 * Inputs/Outputs: unknown value -> boolean.
 * Edge cases: Nullish values always return false.
 *
 * @param {unknown} value - Any runtime value.
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return normalizeString(value).length > 0;
}

/**
 * Purpose: Convert command failures into compact operator-facing error text.
 * Inputs/Outputs: thrown command error -> short string.
 * Edge cases: Prefers stderr when present because Railway CLI failures often hide the useful message there.
 *
 * @param {unknown} error - Thrown error.
 * @returns {string}
 */
function formatCommandError(error) {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim().length > 0) {
    return truncate(error.stderr.trim(), 240);
  }

  if (error instanceof Error) {
    return truncate(error.message, 240);
  }

  return truncate(String(error), 240);
}

/**
 * Purpose: Truncate long strings for one-line console output.
 * Inputs/Outputs: raw string + limit -> truncated string.
 * Edge cases: Values shorter than the limit are returned unchanged.
 *
 * @param {string} value - Raw string.
 * @param {number} limit - Maximum output length.
 * @returns {string}
 */
function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

/**
 * Purpose: Capitalize the first letter of a role label for console output.
 * Inputs/Outputs: lower-case label -> title-cased label.
 * Edge cases: Empty strings return unchanged.
 *
 * @param {string} value - Raw label.
 * @returns {string}
 */
function capitalize(value) {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

/**
 * Purpose: Main CLI entrypoint.
 * Inputs/Outputs: process args -> stdout summary and exit code.
 * Edge cases: Unexpected promise rejections are converted into one failure line rather than a stack trace wall.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const config = parseArgs(process.argv.slice(2));
  const results = await runSmokeCheck(config);
  printResults(results);

  const hasFailures = results.some((result) => result.status === RESULT_STATUS.FAIL);
  process.exitCode = hasFailures ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failure = createResult('Smoke-check execution', RESULT_STATUS.FAIL, formatCommandError(error));
    printResults([failure]);
    process.exitCode = 1;
  });
}
