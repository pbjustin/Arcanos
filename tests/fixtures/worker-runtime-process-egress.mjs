// Test-only preload: the worker entrypoint and every application module remain real.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

const port = Number(process.env.WORKER_FIXTURE_PG_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WORKER_FIXTURE_PORT_INVALID');
function deny() {
  process.stderr.write('WORKER_PROCESS_EGRESS_DENIED\n');
  throw new Error('WORKER_PROCESS_EGRESS_DENIED');
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
  if (options?.host !== '127.0.0.1' || Number(options.port) !== port || options.path) return deny();
  return connect.apply(this, args);
};
tls.connect = deny;
dgram.createSocket = deny;
for (const api of [dns, dnsPromises]) {
  for (const name of Object.keys(api)) {
    if (name === 'lookup' || name === 'lookupService' || name === 'reverse' || name.startsWith('resolve')) api[name] = deny;
  }
}
globalThis.fetch = async () => deny();
syncBuiltinESMExports();
