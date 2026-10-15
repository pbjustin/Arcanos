// Loaded before trusted workflow fixture code. No registry/provider command has
// a native fallback: a missing or changed interception fails before execution.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';

const mode = process.env.OFFLINE_PROCESS_FIXTURE;
assert.ok(['publisher', 'build-context', 'deny'].includes(mode), 'OFFLINE_FIXTURE_MODE_REQUIRED');
assert.ok(process.env.MOCK_COMMAND_LOG, 'OFFLINE_FIXTURE_LOG_REQUIRED');
const log = event => appendFileSync(process.env.MOCK_COMMAND_LOG, JSON.stringify(event) + '\n');
const deny = () => { throw new Error('OFFLINE_FIXTURE_EXTERNAL_EFFECT_BLOCKED'); };
const nativeSpawnSync = childProcess.spawnSync;
for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) childProcess[key] = deny;
childProcess.ChildProcess.prototype.spawn = deny;
for (const object of [net, tls]) object.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
for (const object of [http, https]) { object.request = deny; object.get = deny; }
dgram.createSocket = deny;
globalThis.fetch = deny;

if (mode === 'publisher') {
  childProcess.execFileSync = (program, args, options = {}) => {
    assert.equal(program, 'docker', 'OFFLINE_FIXTURE_UNEXPECTED_PROGRAM');
    const tag = 'ghcr.io/pbjustin/arcanos-stacked-preview:run-1234-1';
    const imageId = `sha256:${'b'.repeat(64)}`;
    const allowed = [
      ['login', 'ghcr.io', '--username', 'pbjustin', '--password-stdin'],
      ['tag', imageId, tag], ['push', tag], ['logout', 'ghcr.io'],
      ['image', 'inspect', '--format', '{{.Id}}', tag],
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', tag],
    ];
    assert.ok(allowed.some(value => JSON.stringify(value) === JSON.stringify(args)), 'OFFLINE_FIXTURE_UNEXPECTED_COMMAND');
    log({ program, args });
    if (args[0] === 'login') {
      assert.equal(options.input, 'test-only-token-sentinel');
      if (process.env.MOCK_LOGIN_FAIL === 'true') throw new Error('OFFLINE_FIXTURE_LOGIN_REJECTED');
    }
    const output = args.includes('{{.Id}}') ? process.env.MOCK_IMAGE_ID
      : args.includes('{{json .RepoDigests}}') ? JSON.stringify([process.env.MOCK_DIGEST]) : '';
    return options.encoding ? output : Buffer.from(output);
  };
}
if (mode === 'build-context') {
  childProcess.spawnSync = (program, args, options) => {
    if (program === 'docker') {
      assert.equal(args[0], '--host=unix:///var/run/docker.sock');
      assert.deepEqual(args.slice(1, 3), ['buildx', 'create']);
      log({ program, args });
      return { status: 1, stdout: '', stderr: 'OFFLINE_FIXTURE_DOCKER_REJECTED' };
    }
    // Only local archive inspection/extraction needed by this fixture may run.
    assert.ok((program === 'git' && ((args[0] === 'archive' && args[1] === '--format=tar'
      && args.length === 3 && /^[0-9a-f]{40}$/u.test(args[2]))
      || (args[0] === 'ls-tree' && args[1] === '-r' && args[2] === '-z'
        && args.length === 4 && /^[0-9a-f]{40}$/u.test(args[3]))))
      || (program === 'tar' && args.length === 4 && args[0] === '-xf' && args[1] === '-'
        && args[2] === '-C' && typeof args[3] === 'string'), 'OFFLINE_FIXTURE_UNEXPECTED_COMMAND');
    return nativeSpawnSync(program, args, options);
  };
}
syncBuiltinESMExports();
log({ guard: 'installed', mode });
