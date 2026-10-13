import { beforeAll, describe, expect, it } from '@jest/globals';
import { generateKeyPairSync, sign } from 'node:crypto';
import { connect, createServer, getCACertificates } from 'node:tls';
import {
  PRODUCTION_INSPECTION_TARGET as TARGET,
  createProductionInspectionTlsOptions,
} from '../scripts/railway-production-readonly-inspection.mjs';

// Follow the in-memory certificate pattern in gaming-protected-transport.test.ts.
// Keys are disposable, and every physical socket remains on loopback.
/**
 * Build a disposable certificate with fixed validity dates and selected TLS extensions.
 * @param {object} [options] Certificate issuer, validity and extension overrides.
 * @returns {object} The certificate PEM, key pair and DER subject for issuing children.
 */
function certificateFixture({ issuer, expired = false, notYetValid = false,
  certificateAuthority = !issuer, keyUsage = issuer && certificateAuthority ? 0xf0 : undefined,
  extendedKeyUsage, serialNumber = issuer ? 2 : 1 } = {}) {
  const der = (tag, ...values) => {
    const body = Buffer.concat(values);
    const octets = [];
    for (let remaining = body.length; remaining > 0; remaining >>>= 8) octets.unshift(remaining & 255);
    const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([128 + octets.length, ...octets]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  const sequence = (...values) => der(0x30, ...values);
  const oid = hex => der(6, Buffer.from(hex, 'hex'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // DER named bit strings omit the trailing zero bits (the template's 0xf0 uses four unused bits).
  const keyUsageBits = keyUsage === undefined ? null : Buffer.from([Math.log2(keyUsage & -keyUsage), keyUsage]);
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5));
  const subject = sequence(der(0x31, sequence(oid('550403'), der(0x0c,
    Buffer.from(issuer ? 'Other Inspection Fixture' : 'Disposable Inspection Fixture')))));
  const tbs = sequence(
    der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([serialNumber])), algorithm,
    issuer?.subject ?? subject,
    sequence(der(0x17, Buffer.from(notYetValid ? '480101000000Z' : '000101000000Z')),
      der(0x17, Buffer.from(expired ? '010101000000Z' : '490101000000Z'))),
    subject, pair.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      sequence(oid('551d13'), der(1, Buffer.from([255])),
        der(4, certificateAuthority ? sequence(der(1, Buffer.from([255]))) : sequence())),
      ...(keyUsageBits ? [sequence(oid('551d0f'), der(4, der(3, keyUsageBits)))] : []),
      ...(extendedKeyUsage ? [sequence(oid('551d25'), der(4, sequence(
        ...extendedKeyUsage.map(usage => oid(usage === 'serverAuth' ? '2b06010505070301' : '2b06010505070302')),
      )))] : []),
      sequence(oid('551d11'), der(4, sequence(der(0x82, Buffer.from('fixture.invalid'))))),
    )),
  );
  const certificate = sequence(tbs, algorithm,
    der(3, Buffer.from([0]), sign('sha256', tbs, issuer?.privateKey ?? pair.privateKey)));
  return {
    subject, privateKey: pair.privateKey,
    key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}

/**
 * Exercise Node's real TLS verifier over loopback and close every socket on success or failure.
 * @param {object} fixture Disposable server key and certificate.
 * @param {object} ssl Client TLS options under test.
 * @param {string} [servername] Requested identity, independent of the loopback transport.
 * @param {object} [serverOptions] Server protocol overrides for downgrade regression cases.
 * @returns {Promise<object>} The authenticated client state after a successful handshake.
 */
async function handshake(fixture, ssl, servername = TARGET.proxyHost, serverOptions = {}) {
  const sockets = new Set();
  const server = createServer({ key: fixture.key, cert: fixture.cert, ...serverOptions }, socket => socket.end());
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  let client;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return await new Promise((resolve, reject) => {
      client = connect({ host: '127.0.0.1', port: server.address().port, servername, ...ssl });
      client.once('secureConnect', () => resolve({ authorized: client.authorized }));
      client.once('error', reject);
      client.setTimeout(2000, () => client.destroy(new Error('LOCAL_TLS_FIXTURE_TIMEOUT')));
    });
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

describe('production inspection authenticated TLS', () => {
  let pinned;
  let alternative;
  let expired;
  let signedAuthority;
  let signedExpired;
  let signedFuture;
  let sibling;
  beforeAll(() => {
    pinned = certificateFixture();
    alternative = certificateFixture({ issuer: pinned });
    expired = certificateFixture({ expired: true });
    signedAuthority = certificateFixture({ issuer: pinned, certificateAuthority: true });
    signedExpired = certificateFixture({ issuer: pinned, expired: true, certificateAuthority: true });
    signedFuture = certificateFixture({ issuer: pinned, notYetValid: true, certificateAuthority: true });
    sibling = certificateFixture({ issuer: pinned, serialNumber: 3 });
  });

  it.each([undefined, ''])('keeps ordinary certificate verification when the pin is %s', value => {
    expect(createProductionInspectionTlsOptions(value)).toEqual({ rejectUnauthorized: true });
  });

  it('rejects an untrusted self-signed peer before completing the handshake', async () => {
    await expect(handshake(pinned, createProductionInspectionTlsOptions())).rejects.toMatchObject({
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
  });

  it('accepts the exact pinned certificate despite its unrelated hostname', async () => {
    const ssl = createProductionInspectionTlsOptions(pinned.cert);
    expect(ssl.rejectUnauthorized).toBe(true);
    await expect(handshake(pinned, ssl)).resolves.toEqual({ authorized: true });
  });

  it.each(['ordinary leaf', 'Railway-template signed authority'])('accepts the exact pinned %s without its issuer', async shape => {
    const fixture = shape === 'ordinary leaf' ? alternative : signedAuthority;
    const ssl = createProductionInspectionTlsOptions(fixture.cert);
    expect(ssl.rejectUnauthorized).toBe(true);
    await expect(handshake(fixture, ssl)).resolves.toEqual({ authorized: true });
  });

  it.each(['ordinary leaf', 'Railway-template signed authority'])('reproduces the pre-fix rejection for the exact pinned %s', async shape => {
    const fixture = shape === 'ordinary leaf' ? alternative : signedAuthority;
    // This is the only production option changed by the issuer-signed certificate fix.
    const beforeFix = createProductionInspectionTlsOptions(fixture.cert);
    delete beforeFix.allowPartialTrustChain;
    await expect(handshake(fixture, beforeFix)).rejects.toMatchObject({
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    await expect(handshake(fixture, createProductionInspectionTlsOptions(fixture.cert)))
      .resolves.toEqual({ authorized: true });
  });

  it('rejects an expired issuer-signed certificate even when the exact peer is pinned', async () => {
    await expect(handshake(signedExpired, createProductionInspectionTlsOptions(signedExpired.cert))).rejects.toMatchObject({
      code: 'CERT_HAS_EXPIRED',
    });
  });

  it('rejects a not-yet-valid issuer-signed certificate even when the exact peer is pinned', async () => {
    await expect(handshake(signedFuture, createProductionInspectionTlsOptions(signedFuture.cert))).rejects.toMatchObject({
      code: 'CERT_NOT_YET_VALID',
    });
  });

  it.each([
    ['serverAuth', ['serverAuth']],
    ['serverAuth and clientAuth', ['serverAuth', 'clientAuth']],
  ])('accepts a pinned server certificate with %s extended key usage', async (_label, extendedKeyUsage) => {
    const fixture = certificateFixture({ issuer: pinned, extendedKeyUsage });
    await expect(handshake(fixture, createProductionInspectionTlsOptions(fixture.cert)))
      .resolves.toEqual({ authorized: true });
  });

  it('rejects a pinned certificate restricted to clientAuth', async () => {
    const fixture = certificateFixture({ issuer: pinned, extendedKeyUsage: ['clientAuth'] });
    await expect(handshake(fixture, createProductionInspectionTlsOptions(fixture.cert)))
      .rejects.toMatchObject({ code: 'INVALID_PURPOSE' });
  });

  it('accepts a pinned server certificate restricted to digitalSignature key usage', async () => {
    const fixture = certificateFixture({ issuer: pinned, keyUsage: 0x80 });
    await expect(handshake(fixture, createProductionInspectionTlsOptions(fixture.cert)))
      .resolves.toEqual({ authorized: true });
  });

  it('rejects a pinned certificate restricted to keyCertSign key usage', async () => {
    const fixture = certificateFixture({ issuer: pinned, certificateAuthority: true, keyUsage: 0x04 });
    await expect(handshake(fixture, createProductionInspectionTlsOptions(fixture.cert)))
      .rejects.toMatchObject({ code: 'INVALID_PURPOSE' });
  });

  it('rejects another certificate even when its chain is trusted by the pin', async () => {
    // Prove the alternate leaf is chain-valid before exercising the real identity check.
    await expect(handshake(alternative, { rejectUnauthorized: true, ca: pinned.cert,
      checkServerIdentity: () => undefined })).resolves.toEqual({ authorized: true });
    await expect(handshake(alternative, createProductionInspectionTlsOptions(pinned.cert)))
      .rejects.toThrow('DATABASE_CERTIFICATE_MISMATCH');
  });

  it('rejects a different certificate from the same issuer as the pin', async () => {
    await expect(handshake(sibling, { rejectUnauthorized: true, ca: pinned.cert,
      checkServerIdentity: () => undefined })).resolves.toEqual({ authorized: true });
    await expect(handshake(sibling, createProductionInspectionTlsOptions(alternative.cert)))
      .rejects.toMatchObject({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
  });

  it.each(['other.invalid', `${TARGET.proxyHost}.`, TARGET.proxyHost.toUpperCase(),
    `other.${TARGET.proxyHost}`, `${TARGET.proxyHost}.other.invalid`, ''])('rejects the pinned peer for requested hostname %j', async hostname => {
    await expect(handshake(pinned, createProductionInspectionTlsOptions(pinned.cert), hostname))
      .rejects.toThrow('DATABASE_CERTIFICATE_MISMATCH');
  });

  it('rejects a certificate with another certificate\'s private key', async () => {
    await expect(handshake({ ...alternative, key: sibling.key }, createProductionInspectionTlsOptions(alternative.cert)))
      .rejects.toMatchObject({ code: 'ERR_OSSL_X509_KEY_VALUES_MISMATCH' });
  });

  it('does not downgrade TLS to a legacy protocol for an exact pinned peer', async () => {
    await expect(handshake(pinned, createProductionInspectionTlsOptions(pinned.cert), TARGET.proxyHost,
      { minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT:@SECLEVEL=0' }))
      .rejects.toMatchObject({ code: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION' });
  });

  it('keeps certificate trust local to the pinned connection', async () => {
    const defaultAuthorities = getCACertificates('default');
    const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await expect(handshake(pinned, createProductionInspectionTlsOptions(pinned.cert)))
      .resolves.toEqual({ authorized: true });
    expect(getCACertificates('default')).toEqual(defaultAuthorities);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(rejectUnauthorized);
    await expect(handshake(pinned, createProductionInspectionTlsOptions()))
      .rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  it('still rejects an expired certificate whose fingerprint is pinned', async () => {
    await expect(handshake(expired, createProductionInspectionTlsOptions(expired.cert))).rejects.toMatchObject({
      code: 'CERT_HAS_EXPIRED',
    });
  });

  it('rejects malformed certificates, bundles, extra content and oversized input', () => {
    for (const pem of [
      'invalid certificate',
      '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\nMAMCAQE=\n-----END CERTIFICATE-----',
      pinned.cert.replace(/[A-Za-z0-9+/=]+\n-----END CERTIFICATE-----/u, '-----END CERTIFICATE-----'),
      pinned.cert + alternative.cert,
      `unexpected-prefix\n${pinned.cert}`,
      `${pinned.cert}unexpected-suffix`,
      'x'.repeat(64 * 1024 + 1),
      {},
    ]) {
      expect(() => createProductionInspectionTlsOptions(pem)).toThrow('DATABASE_CERTIFICATE_INVALID');
    }
  });
});
