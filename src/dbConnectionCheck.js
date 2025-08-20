import knexPkg from 'knex';
import 'pg';

// Handle both ESM and CJS default exports
const knex = knexPkg.default || knexPkg;

/**
 * Verifies a PostgreSQL connection using knex.
 *
 * Throws an error if DATABASE_URL is missing or the connection fails.
 */
export async function dbConnectionCheck() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL not set');
  }

  const db = knex({
    client: 'pg',
    connection: connectionString,
    pool: { min: 0, max: 1 }
  });

  try {
    await db.raw('select 1');
    console.log('✅ DB connection established');
  } finally {
    await db.destroy();
  }
}
