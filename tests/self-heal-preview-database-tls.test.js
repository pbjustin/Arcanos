import fs from 'node:fs';
import { connect, createServer } from 'node:tls';
import { Client } from 'pg';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  buildSelfHealPreviewApplicationEnvironment, buildSelfHealPreviewDatabaseClientOptions,
  SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH, validateSelfHealPreviewDatabaseCertificate,
} from '../scripts/railway-self-heal-preview-profile.mjs';
import { selfHealPreviewCertificate } from './fixtures/self-heal-preview-certificates.mjs';

const NOW = Date.parse('2026-10-14T16:00:00.000Z');
let trusted;
let unrelated;
beforeAll(() => { trusted = selfHealPreviewCertificate(); unrelated = selfHealPreviewCertificate(); });
function profile(pem = trusted.pem) {
  const certificate = validateSelfHealPreviewDatabaseCertificate(pem, { now: () => NOW });
  return { databaseCertificatePem: certificate.pem, controlToken: 'b'.repeat(64),
    proofTarget: { processKind: 'worker', runId: 'tls-profile-1544',
      databaseUrl: 'postgresql://synthetic:synthetic@postgres.railway.internal:5432/railway' },
    ownership: { databaseCertificateSha256: certificate.sha256 } };
}
async function withServer(certificate, run) {
  const sockets = new Set();
  const server = createServer({ cert: certificate.pem,
    key: certificate.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, socket => socket.end());
  server.on('tlsClientError', () => undefined);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return await run(server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SELF_HEAL_PREVIEW_TLS_SERVER_CLOSE_TIMEOUT')), 1000);
      server.close(error => { clearTimeout(timeout); if (error) reject(error); else resolve(); });
    });
  }
}
function handshake(port, ssl, servername = 'postgres.railway.internal') {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername, ...ssl });
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('SELF_HEAL_PREVIEW_TLS_HANDSHAKE_TIMEOUT')); }, 1500);
    socket.once('secureConnect', () => { clearTimeout(timeout); const authorized = socket.authorized; socket.destroy(); resolve(authorized); });
    socket.once('error', error => { clearTimeout(timeout); socket.destroy(); reject(error); });
  });
}

describe('strict preview-owned PostgreSQL TLS configuration', () => {
  it.each([{ hostname: 'foreign.railway.internal' }, { expired: true }, { future: true }, { wildcard: true }])(
    'rejects invalid certificate identity/validity %# before any connection', options => {
      const certificate = selfHealPreviewCertificate(options);
      expect(() => validateSelfHealPreviewDatabaseCertificate(certificate.pem, { now: () => NOW }))
        .toThrow('SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_INVALID');
    },
  );
  it('requires the certificate to remain valid through the fixed lease and verifies its self-signature', () => {
    expect(() => validateSelfHealPreviewDatabaseCertificate(trusted.pem,
      { now: () => NOW, expiresAtMs: Date.parse('2049-01-01T00:00:00.000Z') }))
      .toThrow('SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_INVALID');
    const raw = Buffer.from(trusted.pem.replace(/-----[^-]+-----/gu, '').replace(/\s/gu, ''), 'base64');
    raw[raw.length - 1] ^= 1;
    const corrupt = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64')}\n-----END CERTIFICATE-----`;
    expect(() => validateSelfHealPreviewDatabaseCertificate(corrupt, { now: () => NOW }))
      .toThrow('SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_INVALID');
  });
  it('verifies a real loopback TLS handshake through the direct PostgreSQL-client CA options', async () => {
    const { ssl } = buildSelfHealPreviewDatabaseClientOptions(profile());
    expect(ssl.rejectUnauthorized).toBe(true);
    await withServer(trusted, async port => expect(await handshake(port, ssl)).toBe(true));
  });
  it('rejects a different self-signed peer despite matching private DNS identity', async () => {
    const { ssl } = buildSelfHealPreviewDatabaseClientOptions(profile());
    await withServer(unrelated, async port => expect(handshake(port, ssl)).rejects.toHaveProperty('code', 'DEPTH_ZERO_SELF_SIGNED_CERT'));
  });
  it('retains hostname verification and never changes process-wide TLS bypass variables', async () => {
    const before = { reject: process.env.NODE_TLS_REJECT_UNAUTHORIZED, extra: process.env.NODE_EXTRA_CA_CERTS };
    const { ssl } = buildSelfHealPreviewDatabaseClientOptions(profile());
    await withServer(trusted, async port => expect(handshake(port, ssl, 'foreign.railway.internal'))
      .rejects.toHaveProperty('code', 'ERR_TLS_CERT_ALTNAME_INVALID'));
    expect({ reject: process.env.NODE_TLS_REJECT_UNAUTHORIZED, extra: process.env.NODE_EXTRA_CA_CERTS }).toEqual(before);
  });
  it('proves the real pg parser replaces the ordinary pool legacy false object with the fixed verify-full CA URL', async () => {
    const p = profile(); const child = buildSelfHealPreviewApplicationEnvironment(p, {});
    const read = fs.readFileSync.bind(fs);
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) =>
      path === SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH ? Buffer.from(p.databaseCertificatePem) : read(path, ...args));
    try {
      const client = new Client({ connectionString: child.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const ssl = client.connectionParameters.ssl;
      expect(spy).toHaveBeenCalledWith(SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PATH);
      expect(ssl.ca).toBe(p.databaseCertificatePem); expect(ssl.rejectUnauthorized).not.toBe(false);
      expect(ssl).not.toHaveProperty('checkServerIdentity');
      await withServer(trusted, async port => expect(await handshake(port, ssl)).toBe(true));
      await withServer(unrelated, async port => expect(handshake(port, ssl)).rejects.toHaveProperty('code', 'DEPTH_ZERO_SELF_SIGNED_CERT'));
    } finally { spy.mockRestore(); }
  });
});
