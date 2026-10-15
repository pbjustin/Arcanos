/** Fixed child for the real-pg/socket component fixture; no jobs or real DB. */
const args = process.argv.slice(2);
if (args.length !== 2 || !/^\d{1,5}$/u.test(args[0]) || Number(args[0]) < 1 || Number(args[0]) > 65535
  || !['retain', 'close'].includes(args[1])) throw new Error('WORKER_PG_SOCKET_FIXTURE_ARGUMENT_INVALID');
const database = await import(new URL('../../dist/core/db/client.js', import.meta.url).href);
if (!await database.initializeDatabase('worker-pg-socket-fixture')) throw new Error('WORKER_PG_SOCKET_FIXTURE_INITIALIZATION_FAILED');
const pool = database.getPool();
if (!pool) throw new Error('WORKER_PG_SOCKET_FIXTURE_POOL_MISSING');
const first = await pool.connect();
const second = await pool.connect();
first.release(); second.release();
const evidence = { total: pool.totalCount, idle: pool.idleCount, minimum: pool.options.min,
  allowExitOnIdle: pool.options.allowExitOnIdle, idleTimeoutMillis: pool.options.idleTimeoutMillis };
if (args[1] === 'close') await database.close();
process.stdout.write(`WORKER_PG_SOCKET_READY ${JSON.stringify(evidence)}\n`);
