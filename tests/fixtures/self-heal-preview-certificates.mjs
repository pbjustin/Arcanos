import { generateKeyPairSync, sign } from 'node:crypto';

/** Disposable in-memory keys; only the public certificate may be persisted. */
export function selfHealPreviewCertificate({ hostname = 'postgres.railway.internal', expired = false,
  future = false, wildcard = false } = {}) {
  const der = (tag, ...values) => {
    const body = Buffer.concat(values); const octets = [];
    for (let length = body.length; length > 0; length >>>= 8) octets.unshift(length & 255);
    return Buffer.concat([Buffer.from([tag]), body.length < 128 ? Buffer.from([body.length])
      : Buffer.from([128 + octets.length, ...octets]), body]);
  };
  const sequence = (...values) => der(0x30, ...values);
  const oid = value => der(6, Buffer.from(value, 'hex'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5));
  const subject = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Preview-only test certificate')))));
  const tbs = sequence(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, subject,
    sequence(der(0x17, Buffer.from(future ? '480101000000Z' : '200101000000Z')),
      der(0x17, Buffer.from(expired ? '210101000000Z' : '490101000000Z'))),
    subject, pair.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      sequence(oid('551d13'), der(1, Buffer.from([255])), der(4, sequence(der(1, Buffer.from([255]))))),
      sequence(oid('551d11'), der(4, sequence(der(0x82, Buffer.from(wildcard ? '*.railway.internal' : hostname))))),
    )));
  const bytes = sequence(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, pair.privateKey)));
  const pem = `-----BEGIN CERTIFICATE-----\n${bytes.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { pem, privateKey: pair.privateKey };
}
