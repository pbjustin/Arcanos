/** Fresh provider-free HTTP process reading the original real PostgreSQL job. */
import express from 'express';

const [schemaName, portText] = process.argv.slice(2);
const target = new URL(process.env.DATABASE_URL ?? 'invalid:');
if (target.protocol !== 'postgresql:' || target.hostname !== '127.0.0.1' || !target.port
    || target.pathname !== '/arcanos_audit_pg18_20260727' || target.search || target.hash
    || !/^daemon_pg_[0-9a-f]{32}$/u.test(schemaName) || !/^\d+$/u.test(portText)) {
  throw new Error('A dedicated loopback PostgreSQL target and owned schema are required.');
}
process.env.PGOPTIONS = `-c search_path=${schemaName} -c statement_timeout=3000`;
let providerCalls = 0;
globalThis.fetch = async () => {
  providerCalls += 1;
  throw new Error('Outbound HTTP is forbidden in the read-only PostgreSQL serving fixture.');
};
const database = await import('../../dist/core/db/client.js');
if (!await database.initializeDatabase('continuation-read-only-child')) throw new Error('Owned PostgreSQL initialization failed.');
const scope = await database.getPool().query('SELECT current_schema() AS schema');
if (scope.rows[0].schema !== schemaName) throw new Error('The owned PostgreSQL schema was not selected.');
const { createApp } = await import('../../dist/app.js');
const { verifyConfiguredJobReadCapability } = await import('../../dist/shared/jobs/jobReadCapability.js');
const application = express();
let generationRequests = 0;
let resultReads = 0;
application.use((req, res, next) => {
  if (req.method !== 'GET') {
    generationRequests += 1;
    res.sendStatus(405);
    return;
  }
  if (req.path.startsWith('/jobs/')) resultReads += 1;
  res.once('finish', () => process.send?.({ event: 'request', method: req.method, path: req.path, status: res.statusCode,
    ...(req.path.startsWith('/jobs/') ? {
      capabilityBound: verifyConfiguredJobReadCapability(req.path.split('/')[2], req.get('x-arcanos-job-read-token')).authorized
        && !req.get('x-arcanos-daemon-token') && req.originalUrl === req.path,
    } : {}),
  }));
  next();
});
application.use(createApp());
const server = application.listen(Number(portText), '127.0.0.1', () => process.send?.({ event: 'ready', pid: process.pid }));
server.once('error', () => { process.exitCode = 1; });
process.on('message', message => {
  if (message !== 'close') return;
  server.closeAllConnections();
  server.close(async () => {
    await database.close();
    process.send?.({ event: 'closed', generationRequests, providerCalls, resultReads });
    process.disconnect();
  });
});
