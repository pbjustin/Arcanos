// Native-process fixture only. Production child commands are replaced before
// importing the real launcher entry; no server, Python, provider or DB starts.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(import.meta.url);
const launcherPath = fileURLToPath(new URL('../../scripts/start-railway-service.mjs', import.meta.url));
const nativeSpawn = childProcess.spawn;
const mode = process.argv[2];

function runChild() {
  const role = process.argv[3];
  // Windows adds these OS defaults even when spawn receives env: {}.
  const osDefaults = process.platform === 'win32' ? new Set([
    'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT',
    'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
  ]) : new Set();
  assert.ok(Object.keys(process.env).every(name => osDefaults.has(name)),
    'native fixture child must have no application or provider environment');
  process.on('message', message => {
    if (message?.kind === 'exit') process.exit(message.code);
    if (message?.kind === 'windows-drain') setTimeout(() => process.exit(0), 120);
  });
  if (role === 'web') {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => setTimeout(() => process.exit(0), 120));
    }
  }
  process.send({ kind: 'ready', role, credentialEmpty: true });
}

function installLauncherFixture() {
  const scenario = process.env.ARCANOS_LAUNCHER_FIXTURE;
  assert.ok(['SIGTERM', 'SIGINT', 'unexpected-exit', 'spawn-failure', 'failed-forward'].includes(scenario));
  const children = new Map();
  const ready = new Set();
  const announceReady = () => {
    if (ready.has('daemon') && ready.has('web')) process.send({ kind: 'fixture-ready' });
  };
  childProcess.spawn = (command, args, options) => {
    const daemon = command === 'python3' && JSON.stringify(args) === JSON.stringify([
      '-m', 'arcanos.cli.local_bridge', '--host', '127.0.0.1', '--port', '8765'
    ]);
    const web = command === 'node' && JSON.stringify(args) === JSON.stringify([
      '--max-old-space-size=7168', '--import', './scripts/register-esm-loader.mjs', 'dist/start-server.js'
    ]);
    assert.ok(daemon || web, 'fixture refuses every unreviewed child command');
    const role = daemon ? 'daemon' : 'web';
    const missingExecutable = daemon && scenario === 'spawn-failure';
    const child = nativeSpawn(missingExecutable ? `${process.execPath}-missing-fixture` : process.execPath,
      [fixturePath, 'child', role], {
        ...options, cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {},
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      });
    children.set(role, child);
    child.once('spawn', () => process.send({ kind: 'fixture-spawn', role, pid: child.pid }));
    child.once('exit', (code, signal) => process.send({ kind: 'fixture-exit', role, pid: child.pid, code, signal }));
    child.once('error', () => {
      ready.add(role);
      announceReady();
    });
    child.on('message', message => {
      if (message?.kind !== 'ready') return;
      assert.equal(message.credentialEmpty, true);
      ready.add(role);
      announceReady();
    });
    const nativeKill = child.kill.bind(child);
    if (daemon && scenario === 'failed-forward') {
      child.kill = signal => {
        assert.equal(signal, 'SIGTERM');
        // Inject a failed forwarding result while the real child exits abnormally.
        child.send({ kind: 'exit', code: 18 });
        return false;
      };
    } else if (web && process.platform === 'win32') {
      // Windows cannot deliver catchable POSIX process signals. Retain actual
      // child exit/drain evidence, labeling this path as signal-event injection.
      child.kill = () => {
        child.send({ kind: 'windows-drain' });
        return true;
      };
    }
    child.fixtureNativeKill = nativeKill;
    return child;
  };
  syncBuiltinESMExports();
  process.on('message', message => {
    if (message?.kind === 'signal-event') process.emit(message.signal);
    if (message?.kind === 'daemon-exit') children.get('daemon').send({ kind: 'exit', code: 17 });
  });
  process.on('disconnect', () => {
    for (const child of children.values()) {
      if (child.exitCode === null && child.signalCode === null) child.fixtureNativeKill('SIGKILL');
    }
  });
}

async function runScenario(scenario) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'arcanos-launcher-native-'));
  mkdirSync(join(fixtureRoot, 'scripts'));
  copyFileSync(launcherPath, join(fixtureRoot, 'scripts/start-railway-service.mjs'));
  copyFileSync(fileURLToPath(new URL('../../scripts/production-build-identity.mjs', import.meta.url)),
    join(fixtureRoot, 'scripts/production-build-identity.mjs'));
  const launcher = nativeSpawn(process.execPath, ['--import', import.meta.url, join(fixtureRoot, 'scripts/start-railway-service.mjs')], {
    cwd: fixtureRoot,
    env: {
      NODE_ENV: 'test', ARCANOS_PROCESS_KIND: 'web', ARCANOS_CLI_BRIDGE_ENABLED: 'true',
      ARCANOS_CLI_BRIDGE_TOKEN: 'synthetic-launcher-fixture-token', ARCANOS_LAUNCHER_FIXTURE: scenario
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const exited = new Promise(resolveExit => launcher.once('exit', resolveExit));
  let stdout = '';
  let stderr = '';
  let ready = false;
  let exitCode;
  const livePids = new Set();
  const spawnedRoles = new Set();
  launcher.stdout.on('data', chunk => { stdout += chunk; });
  launcher.stderr.on('data', chunk => { stderr += chunk; });
  launcher.on('message', message => {
    if (message.kind === 'fixture-ready') ready = true;
    if (message.kind === 'fixture-spawn') {
      livePids.add(message.pid);
      spawnedRoles.add(message.role);
    }
    if (message.kind === 'fixture-exit') livePids.delete(message.pid);
  });
  launcher.once('exit', code => { exitCode = code; });
  const waitFor = async predicate => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `native fixture timed out: ${scenario}\n${stdout}\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await waitFor(() => ready);
    if (scenario === 'unexpected-exit') {
      launcher.send({ kind: 'daemon-exit' });
      await waitFor(() => stderr.includes('exit_17'));
    }
    if (scenario === 'spawn-failure') await waitFor(() => stderr.includes('spawn_error'));
    const signal = scenario === 'SIGINT' ? 'SIGINT' : 'SIGTERM';
    if (process.platform === 'win32') launcher.send({ kind: 'signal-event', signal });
    else assert.equal(launcher.kill(signal), true);
    await waitFor(() => exitCode !== undefined);
    assert.equal(exitCode, 0, stderr);
    if (scenario === 'SIGTERM' || scenario === 'SIGINT') {
      assert.match(stdout, /daemon\.stopped/u);
      assert.ok(stdout.includes(`signal_${signal}`) || stdout.includes('exit_0'));
      assert.doesNotMatch(stderr, /daemon\.unreachable/u);
    } else {
      assert.match(stderr, /daemon\.unreachable/u);
      assert.ok(stderr.includes(scenario === 'spawn-failure' ? 'spawn_error' : scenario === 'failed-forward' ? 'exit_18' : 'exit_17'));
      assert.doesNotMatch(stdout, /daemon\.stopped/u);
    }
    assert.doesNotMatch(stdout + stderr, /synthetic-launcher-fixture-token/u);
    assert.equal(livePids.size, 0, 'native fixture children must exit before the launcher');
    return { scenario, platform: process.platform,
      signalDelivery: process.platform === 'win32' ? 'signal_event_injection_and_ipc_web_drain' : 'native_os_signal',
      forwardingFaultInjected: scenario === 'failed-forward', nativeChildren: spawnedRoles.size,
      launcherExitCode: exitCode, daemonSeverity: scenario.startsWith('SIG') ? 'info' : 'error',
      childEnvironments: process.platform === 'win32' ? 'credential_empty_os_defaults_only' : 'empty',
      remainingFixtureChildren: livePids.size };
  } finally {
    if (launcher.connected) launcher.disconnect();
    if (exitCode === undefined) launcher.kill('SIGKILL');
    for (const pid of livePids) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') console.error('[railway-launcher-fixture] cleanup.kill.failed', JSON.stringify({ code: error.code ?? 'unknown' }));
      }
    }
    await exited;
    // Verify the unique, absolute owned target before recursive fixture cleanup.
    assert.equal(dirname(resolve(fixtureRoot)), resolve(tmpdir()));
    assert.ok(basename(fixtureRoot).startsWith('arcanos-launcher-native-'));
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (mode === 'child') runChild();
else if (mode === 'run') {
  for (const scenario of ['SIGTERM', 'SIGINT', 'unexpected-exit', 'spawn-failure', 'failed-forward']) {
    console.log(JSON.stringify(await runScenario(scenario)));
  }
} else installLauncherFixture();
