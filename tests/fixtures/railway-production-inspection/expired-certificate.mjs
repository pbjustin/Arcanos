// Disposable, self-signed certificate using the reviewed DER fixture pattern in
// tests/railway-production-inspection-tls.test.js. Invalid dates are fixed in UTC.
import { generateKeyPairSync, sign } from 'node:crypto';

/** Generate a disposable expired or not-yet-valid certificate without changing the clock. */
export function generateExpiredCertificate({ future = false } = {}) {
  /** Encode one DER tag and length around the supplied byte buffers. */
  const der = (tag, ...values) => {
    const body = Buffer.concat(values);
    const octets = [];
    for (let remaining = body.length; remaining > 0; remaining >>>= 8) octets.unshift(remaining & 255);
    const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([128 + octets.length, ...octets]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  /** Wrap encoded child values in an ASN.1 SEQUENCE. */
  const sequence = (...values) => der(0x30, ...values);
  /** Encode an object identifier from its pre-encoded hexadecimal bytes. */
  const oid = hex => der(6, Buffer.from(hex, 'hex'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5));
  const subject = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Invalid Validity Inspection Fixture')))));
  const tbs = sequence(
    der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, subject,
    sequence(der(future ? 0x18 : 0x17, Buffer.from(future ? '21000101000000Z' : '000101000000Z')),
      der(future ? 0x18 : 0x17, Buffer.from(future ? '21010101000000Z' : '010101000000Z'))),
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
