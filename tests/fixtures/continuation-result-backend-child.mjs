/** Fresh provider-free process serving only persisted synthetic job reads. */
import express from 'express';
import { readFileSync } from 'node:fs';
import { createGenericJobsRouter } from '../../dist/routes/genericJobsRouter.js';
import { verifyConfiguredJobReadCapability } from '../../dist/shared/jobs/jobReadCapability.js';

const [storagePath, portText] = process.argv.slice(2);
const persisted = JSON.parse(readFileSync(storagePath, 'utf8'));
const app = express();
let generationRequests = 0;
let resultReads = 0;
app.use((req, res, next) => {
  if (req.method !== 'GET') generationRequests += 1;
  res.once('finish', () => process.send?.({
    event: 'request', method: req.method, path: req.path, status: res.statusCode,
    ...(req.path.startsWith('/jobs/') ? {
      capabilityBound: verifyConfiguredJobReadCapability(persisted.job.id, req.get('x-arcanos-job-read-token')).authorized
        && req.originalUrl === `/jobs/${persisted.job.id}/result` && !req.get('x-arcanos-daemon-token'),
    } : {}),
  }));
  next();
});
for (const [route, payload] of [['/api/daemon/registry', persisted.registry], ['/system-state', persisted.systemState]]) {
  app.get(route, (req, res) => {
    const authorized = route === '/api/daemon/registry'
      ? req.get('x-arcanos-daemon-token') === process.env.ARCANOS_DAEMON_ACCESS_TOKEN
      : req.get('authorization') === `Bearer ${process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN}`;
    if (!authorized) {
      res.sendStatus(401);
      return;
    }
    res.json(payload);
  });
}
app.use(createGenericJobsRouter({
  getJobById: async id => {
    resultReads += 1;
    return id === persisted.job.id ? structuredClone(persisted.job) : null;
  },
  isJobRepositoryUnavailable: () => false,
  requestJobCancellation: async () => { throw new Error('Cancellation is outside the read-only fixture'); },
  confirmCancellation: (_req, res) => res.sendStatus(405),
  getRequestActorKey: () => 'fixture-read-only', getRequestEstablishedActorKey: () => null,
  recordJobLookup: () => {}, sleep: async () => {},
  validateBridgeCredential: () => ({ ok: false, statusCode: 401, reason: 'invalid' }),
  verifyJobReadCapability: verifyConfiguredJobReadCapability,
}));
app.use((_req, res) => res.sendStatus(405));
const server = app.listen(Number(portText), '127.0.0.1', () => process.send?.({ event: 'ready', pid: process.pid }));
server.once('error', () => process.exitCode = 1);
process.on('message', message => {
  if (message !== 'close') return;
  server.closeAllConnections();
  server.close(() => {
    process.send?.({ event: 'closed', generationRequests, resultReads, providerCalls: 0 });
    process.disconnect();
  });
});
