import { readFile } from 'fs/promises';
import knexPkg from 'knex';
import 'pg';

const knex = knexPkg.default || knexPkg;

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const db = knex({ client: 'pg', connection: connectionString });
  try {
    const sqlPath = new URL('../migrations/init_db.sql', import.meta.url);
    const sql = await readFile(sqlPath, 'utf-8');
    await db.raw(sql);
    console.log('✅ Database migrations applied');
  } catch (err) {
    console.error('❌ Migration failed:', err?.message || err);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

runMigrations();
