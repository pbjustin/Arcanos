import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';
import {
  consumeGptAccessPairingWithClient, rotateGptAccessDeviceWithClient
} from '../../src/core/db/repositories/gptAccessDeviceRepository.js';
import { hashGptAccessDeviceSecret } from '../../src/services/gptAccessDeviceCredentials.js';
import {
  GPT_ACCESS_DEVICE_AUDIENCE, type GptAccessDeviceGrant, type GptAccessDeviceRecord
} from '../../src/shared/security/gptAccessDevice.js';
import { assertDisposablePostgresTestDatabaseUrl, resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const envName = 'GPT_ACCESS_DEVICE_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(envName);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, envName);
const describePg = connectionString ? describe : describe.skip;
const schema = `gpt_access_device_${randomUUID().replaceAll('-', '')}`;
const origin = 'https://gateway.example.test';
const migration = readFileSync('migrations/20260911_gpt_access_devices_v1.sql', 'utf8');

describePg('paired-device PostgreSQL transactions', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 3 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(migration);
      await client.query(migration);
    } finally { client.release(); }
  });
  afterAll(async () => {
    if (!pool) return;
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end(); }
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE "${schema}".gpt_access_device_pairings, "${schema}".gpt_access_devices`);
  });

  async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async function seedPairing(ttlMs = 300_000) {
    const now = new Date();
    const hash = hashGptAccessDeviceSecret(randomUUID());
    await pool.query(`INSERT INTO "${schema}".gpt_access_device_pairings
      (pairing_hash,principal_id,workspace_id,origin,scopes,capability_actions,issued_at,expires_at)
      VALUES ($1,'operator:test','workspace:test',$2,$3,$4,$5,$6)`, [
      hash, origin, ['jobs.create', 'jobs.result'], ['git.status'], now, new Date(now.getTime() + ttlMs)
    ]);
    return { hash, now: now.toISOString() };
  }
  function newDevice(now: string): Omit<GptAccessDeviceRecord, keyof GptAccessDeviceGrant> {
    return {
      deviceId: randomUUID(), localIdentityHash: hashGptAccessDeviceSecret(randomUUID()),
      credentialHash: hashGptAccessDeviceSecret(randomUUID()), audience: GPT_ACCESS_DEVICE_AUDIENCE,
      pairedAt: now, issuedAt: now, expiresAt: new Date(Date.parse(now) + 3600_000).toISOString(),
      renewalExpiresAt: new Date(Date.parse(now) + 30 * 86400_000).toISOString(), revokedAt: null, gptIds: ['arcanos-core']
    };
  }

  test('one concurrent pairing wins, another observes consumed challenge, one device persists', async () => {
    const pair = await seedPairing();
    const results = await Promise.allSettled([1, 2].map(() => withTransaction(client =>
      consumeGptAccessPairingWithClient(client, pair.hash, newDevice(pair.now), pair.now, origin))));
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'PAIRING_USED' } });
    expect((await pool.query(`SELECT COUNT(*) AS count FROM "${schema}".gpt_access_devices`)).rows[0].count).toBe('1');
  });

  test('wrong-origin attempt rolls back without consuming challenge', async () => {
    const pair = await seedPairing();
    await expect(withTransaction(client => consumeGptAccessPairingWithClient(client, pair.hash, newDevice(pair.now), pair.now, 'https://wrong.test')))
      .rejects.toMatchObject({ code: 'DEVICE_ORIGIN_DENIED' });
    await expect(withTransaction(client => consumeGptAccessPairingWithClient(client, pair.hash, newDevice(pair.now), pair.now, origin)))
      .resolves.toMatchObject({ principalId: 'operator:test', workspaceId: 'workspace:test' });
  });

  test('pairing expiry while waiting on a row lock rolls back registration', async () => {
    const pair = await seedPairing(150);
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query(`SELECT * FROM "${schema}".gpt_access_device_pairings WHERE pairing_hash=$1 FOR UPDATE`, [pair.hash]);
    const completion = withTransaction(client => consumeGptAccessPairingWithClient(client, pair.hash, newDevice(pair.now), pair.now, origin));
    const asserted = expect(completion).rejects.toMatchObject({ code: 'PAIRING_EXPIRED' });
    try {
      await lock.query('SELECT pg_sleep(0.2)');
      await lock.query('COMMIT');
    } finally { lock.release(); }
    await asserted;
    expect((await pool.query(`SELECT COUNT(*) AS count FROM "${schema}".gpt_access_devices`)).rows[0].count).toBe('0');
  });

  test('concurrent rotation permits one replacement and invalidates the old digest', async () => {
    const pair = await seedPairing();
    const device = await withTransaction(client => consumeGptAccessPairingWithClient(client, pair.hash, newDevice(pair.now), pair.now, origin));
    const results = await Promise.allSettled([1, 2].map(() => withTransaction(client => rotateGptAccessDeviceWithClient(
      client, device.credentialHash, hashGptAccessDeviceSecret(randomUUID()), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()
    ))));
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'DEVICE_AUTH_INVALID' } });
    expect((await pool.query(`SELECT COUNT(*) AS count FROM "${schema}".gpt_access_devices WHERE credential_hash=$1`, [device.credentialHash])).rows[0].count).toBe('0');
  });

  test('revocation that wins the row lock prevents credential rotation', async () => {
    const pair = await seedPairing();
    const device = await withTransaction(client => consumeGptAccessPairingWithClient(client, pair.hash, newDevice(pair.now), pair.now, origin));
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query(`UPDATE "${schema}".gpt_access_devices SET revoked_at=clock_timestamp() WHERE device_id=$1`, [device.deviceId]);
    const rotation = withTransaction(client => rotateGptAccessDeviceWithClient(client, device.credentialHash, hashGptAccessDeviceSecret(randomUUID()), new Date().toISOString(), device.expiresAt));
    const asserted = expect(rotation).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    try { await lock.query('COMMIT'); } finally { lock.release(); }
    await asserted;
  });

  test('credential expiry while waiting on a row lock prevents rotation', async () => {
    const pair = await seedPairing();
    const device = await withTransaction(client => consumeGptAccessPairingWithClient(client, pair.hash, newDevice(pair.now), pair.now, origin));
    const now = new Date().toISOString();
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query(`UPDATE "${schema}".gpt_access_devices SET expires_at=clock_timestamp() + INTERVAL '150 milliseconds' WHERE device_id=$1`, [device.deviceId]);
    const rotation = withTransaction(client => rotateGptAccessDeviceWithClient(client, device.credentialHash, hashGptAccessDeviceSecret(randomUUID()), now, device.expiresAt));
    const asserted = expect(rotation).rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_EXPIRED' });
    try {
      await lock.query('SELECT pg_sleep(0.2)');
      await lock.query('COMMIT');
    } finally { lock.release(); }
    await asserted;
    expect((await pool.query(`SELECT credential_hash FROM "${schema}".gpt_access_devices WHERE device_id=$1`, [device.deviceId])).rows[0].credential_hash).toBe(device.credentialHash);
  });

  test('database constraints reject wildcard grant and wrong audience', async () => {
    const pair = await seedPairing();
    await expect(pool.query(`UPDATE "${schema}".gpt_access_device_pairings SET scopes=ARRAY['workers.recover'] WHERE pairing_hash=$1`, [pair.hash]))
      .rejects.toMatchObject({ code: '23514' });
    const device = newDevice(pair.now);
    Object.assign(device, { audience: 'local-agent-protocol' });
    await expect(withTransaction(client => consumeGptAccessPairingWithClient(client, pair.hash, device, pair.now, origin)))
      .rejects.toMatchObject({ code: '23514' });
    expect((await pool.query(`SELECT consumed_at FROM "${schema}".gpt_access_device_pairings WHERE pairing_hash=$1`, [pair.hash])).rows[0].consumed_at).toBeNull();
  });

  test('rollback removes the new tables and forward migration can recreate them', async () => {
    await withTransaction(async client => {
      await client.query(readFileSync('migrations/20260911_gpt_access_devices_v1.rollback.sql', 'utf8'));
      expect((await client.query("SELECT to_regclass('gpt_access_devices') AS table_name")).rows[0].table_name).toBeNull();
      await client.query(migration);
    });
  });
});
