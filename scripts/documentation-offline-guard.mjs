/**
 * Preload for the fixed documentation validators inside the offline sandbox.
 * Deny transport calls before they receive a destination or credential. The
 * enclosing network namespace and read-only mounts provide OS-level isolation;
 * these hooks make accidental transport use fail with a stable diagnostic.
 */
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

export const DOCS_OFFLINE_NETWORK_BLOCKED = 'DOCS_OFFLINE_NETWORK_BLOCKED';
export const DOCS_OFFLINE_PROCESS_BLOCKED = 'DOCS_OFFLINE_PROCESS_BLOCKED';

const nativeSpawnSync = childProcess.spawnSync;
const repositoryRoot = realpathSync(process.cwd());
const GIT_EXECUTABLE = '/usr/bin/git';
let installed = false;

function denyNetwork() {
  throw Object.assign(new Error(DOCS_OFFLINE_NETWORK_BLOCKED), {
    code: DOCS_OFFLINE_NETWORK_BLOCKED,
  });
}

function denyProcess() {
  throw Object.assign(new Error(DOCS_OFFLINE_PROCESS_BLOCKED), {
    code: DOCS_OFFLINE_PROCESS_BLOCKED,
  });
}

function isAllowedGitArguments(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    return false;
  }
  if (args.length === 4) {
    return args[0] === 'ls-files' && args[1] === '-z'
      && args[2] === '--' && args[3] === '*.md';
  }
  return args.length === 8
    && args[0] === 'grep' && args[1] === '-n' && args[2] === '-F'
    && args[3] === '--'
    && args[4].length > 0 && args[4].length <= 512
    && !/[\0\r\n]/u.test(args[4])
    && args[5] === '--'
    && args[6] === ':!scripts/check-documentation.mjs'
    && args[7] === ':!docs/audits/**';
}

/**
 * Only the two read-only Git queries used by the validators may escape Node.
 * Rebuild options and environment rather than forwarding caller capabilities.
 */
function spawnReadOnlyGit(program, args, options = {}) {
  if ((program !== 'git' && program !== GIT_EXECUTABLE)
    || !isAllowedGitArguments(args)
    || !options || typeof options !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Object.keys(options).some((key) => key !== 'cwd' && key !== 'encoding')
    || options.encoding !== 'utf8'
    || options.cwd !== repositoryRoot) {
    return denyProcess();
  }

  return nativeSpawnSync(GIT_EXECUTABLE, [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    ...args,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_ALLOW_PROTOCOL: '',
    },
  });
}

function denyDnsQueries(target) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (name === 'lookup' || name === 'lookupService'
      || name === 'reverse' || name.startsWith('resolve')) {
      if (typeof target[name] === 'function') target[name] = denyNetwork;
    }
  }
}

/** Install before importing any validator or SDK; repeat calls are harmless. */
export function installDocumentationOfflineGuard() {
  if (installed) return;
  installed = true;

  globalThis.fetch = denyNetwork;
  globalThis.WebSocket = denyNetwork;

  for (const transport of [http, https]) {
    transport.request = denyNetwork;
    transport.get = denyNetwork;
    transport.Agent.prototype.createConnection = denyNetwork;
  }
  http2.connect = denyNetwork;
  net.connect = denyNetwork;
  net.createConnection = denyNetwork;
  net.Socket.prototype.connect = denyNetwork;
  net.Server.prototype.listen = denyNetwork;
  tls.connect = denyNetwork;

  dgram.createSocket = denyNetwork;
  for (const method of [
    'bind', 'connect', 'send', 'sendto',
    'addMembership', 'dropMembership',
    'addSourceSpecificMembership', 'dropSourceSpecificMembership',
  ]) {
    if (typeof dgram.Socket.prototype[method] === 'function') {
      dgram.Socket.prototype[method] = denyNetwork;
    }
  }

  for (const target of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
    denyDnsQueries(target);
  }

  for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    childProcess[method] = denyProcess;
  }
  childProcess.ChildProcess.prototype.spawn = denyProcess;
  childProcess.spawnSync = spawnReadOnlyGit;
  syncBuiltinESMExports();
}

installDocumentationOfflineGuard();
