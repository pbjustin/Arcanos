import knexPkg from 'knex';
import 'pg';

const knex = knexPkg.default || knexPkg;

async function migrate() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const db = knex({
    client: 'pg',
    connection: connectionString,
    migrations: {
      directory: './migrations',
    },
  });

  try {
    await db.migrate.latest();
    console.log('✅ Migrations completed successfully');
    await db.destroy();
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err?.message || err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
}

migrate();

