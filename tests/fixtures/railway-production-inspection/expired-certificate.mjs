// Disposable, self-signed certificate using the reviewed DER fixture pattern in
// tests/railway-production-inspection-tls.test.js. It expired in January 2001.
import { generateKeyPairSync, sign } from 'node:crypto';

export function generateExpiredCertificate() {
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
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5));
  const subject = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Expired Inspection Fixture')))));
  const tbs = sequence(
    der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, subject,
    sequence(der(0x17, Buffer.from('000101000000Z')), der(0x17, Buffer.from('010101000000Z'))),
    subject, pair.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      sequence(oid('551d13'), der(1, Buffer.from([255])), der(4, sequence(der(1, Buffer.from([255]))))),
      sequence(oid('551d11'), der(4, sequence(der(0x82, Buffer.from('fixture.invalid'))))),
    )),
  );
  const certificate = sequence(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, pair.privateKey)));
  return {
    key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}
