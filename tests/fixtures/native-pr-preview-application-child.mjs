// Fixed compiled-only Gaming fixture. No normal backend or active worker startup.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

if (!process.connected || typeof process.send !== 'function') {
  throw new Error('GAMING_COMPILED_CHILD_IPC_REQUIRED');
}
const allowedEnvironment = new Set(['NODE_ENV', 'TZ', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']);
const windowsRuntimeEnvironment = /^(?:HOMEDRIVE|HOMEPATH|LOGONSERVER|PATH|SYSTEMDRIVE|SYSTEMROOT|TEMP|TMP|USERDOMAIN|USERNAME|USERPROFILE|WINDIR)$/iu;
if (process.execArgv.length !== 0 || process.env.NODE_ENV !== 'test' || process.env.TZ !== 'UTC'
  || Object.keys(process.env).some(name => !allowedEnvironment.has(name)
    && (process.platform !== 'win32' || !windowsRuntimeEnvironment.test(name)))) {
  throw new Error('GAMING_COMPILED_CHILD_ENVIRONMENT_INVALID');
}
let outbound = 0;
let notion = 0;
const emit = message => { if (process.connected) process.send(message); };
const deny = () => {
  outbound += 1;
  process.exitCode = 1;
  emit({ type: 'outbound' });
  throw new Error('GAMING_COMPILED_CHILD_OUTBOUND_FORBIDDEN');
};
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();

const responses = new Set();
const servers = [];
let disposal;
async function close() {
  return disposal ??= (async () => {
    await Promise.all([...responses]);
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.filter(server => server.listening).map(server =>
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    process.removeAllListeners('message');
    if (process.connected) {
      await new Promise((resolve, reject) => process.send({
        type: 'closed', activeResponses: responses.size, outbound, notion,
      }, error => error ? reject(error) : resolve()));
      process.disconnect();
    }
  })();
}
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    const address = server.address();
    if (!address || typeof address === 'string') { reject(new Error('GAMING_COMPILED_CHILD_LISTENER_INVALID')); return; }
    resolve(address.port);
  });
});
process.once('disconnect', () => { void close().catch(() => { process.exitCode = 1; }); });
const assertConnected = () => {
  if (disposal || !process.connected) throw new Error('GAMING_COMPILED_CHILD_DISCONNECTED');
};

try {
  // The tripwires precede both imports. The owning test command builds dist first;
  // missing compiled output fails here without falling back to source imports.
  const { createNativePrPreviewApplication } = await import('../../dist/nativePrPreviewApplication.js');
  const { createPassivePrPreviewServer } = await import('../../scripts/start-railway-service.mjs');
  assertConnected();
  const identity = { prNumber: 1413, sourceCommit: 'a'.repeat(40) };
  const app = createNativePrPreviewApplication({ identity,
    readinessState: { applicationImported: true, fixturesSealed: true, ready: true, draining: false },
    notionConnectivityProbe: async () => {
      notion += 1;
      process.exitCode = 1;
      emit({ type: 'notion' });
      throw new Error('GAMING_COMPILED_CHILD_NOTION_FORBIDDEN');
    },
  });
  const web = http.createServer((incoming, outgoing) => {
    let complete;
    const response = new Promise(resolve => { complete = resolve; });
    responses.add(response);
    void response.then(() => responses.delete(response));
    const end = outgoing.end;
    outgoing.end = function(...parameters) {
      try { return end.apply(this, parameters); } finally { complete(); }
    };
    app(incoming, outgoing);
  });
  const worker = createPassivePrPreviewServer('worker', identity);
  servers.push(web, worker);
  const workerPort = await listen(worker);
  assertConnected();
  const webPort = await listen(web);
  assertConnected();
  process.on('message', message => {
    if (message?.type === 'stop') void close().catch(() => { process.exitCode = 1; emit({ type: 'failure' }); });
    else { process.exitCode = 1; emit({ type: 'failure' }); void close(); }
  });
  emit({ type: 'ready', webPort, workerPort });
} catch {
  process.exitCode = 1;
  emit({ type: 'failure' });
  await close();
}
