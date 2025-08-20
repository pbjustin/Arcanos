import knexPkg from 'knex';
const knex = (knexPkg as any).default || knexPkg;

export async function dbConnectionCheck(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[❌ DB CHECK] DATABASE_URL not set');
    process.exit(1);
  }

  const db = knex({
    client: 'pg',
    connection: connectionString,
    pool: { min: 0, max: 1 }
  });

  try {
    await db.raw('select 1');
    console.log('[✅ DB CHECK] Database connection established');
  } catch (err: any) {
    console.error('[❌ DB CHECK] Database connection failed:', err?.message || err);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}
