import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureSchema() {
  console.log("🔍 Checking database schema...");

  // List of required tables and their creation SQL
  const requiredTables = {
    saves: `
      CREATE TABLE IF NOT EXISTS saves (
        id SERIAL PRIMARY KEY,
        module TEXT NOT NULL,
        data JSONB NOT NULL,
        timestamp BIGINT NOT NULL
      );
    `,
    audit_logs: `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        event TEXT NOT NULL,
        payload JSONB,
        timestamp BIGINT NOT NULL
      );
    `,
    backstage_events: `
      CREATE TABLE IF NOT EXISTS backstage_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
    backstage_wrestlers: `
      CREATE TABLE IF NOT EXISTS backstage_wrestlers (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        overall INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
    backstage_storylines: `
      CREATE TABLE IF NOT EXISTS backstage_storylines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        story_key TEXT UNIQUE NOT NULL,
        storyline TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
    backstage_story_beats: `
      CREATE TABLE IF NOT EXISTS backstage_story_beats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
    self_reflections: `
      CREATE TABLE IF NOT EXISTS self_reflections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        priority TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        improvements JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
    execution_logs: `
      CREATE TABLE IF NOT EXISTS execution_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id VARCHAR(255) NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        level VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'
      );
    `,
    job_data: `
      CREATE TABLE IF NOT EXISTS job_data (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id VARCHAR(255) NOT NULL,
        job_type VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        input JSONB NOT NULL,
        output JSONB,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
    `,
    idx_execution_logs_ts_wid: `CREATE INDEX IF NOT EXISTS idx_execution_logs_ts_wid ON execution_logs(timestamp DESC, worker_id);`,
    idx_job_data_created_at: `CREATE INDEX IF NOT EXISTS idx_job_data_created_at ON job_data(created_at DESC);`
    // add more tables here as needed
  };

  try {
    for (const [table, createSQL] of Object.entries(requiredTables)) {
      const res = await pool.query(
        `SELECT to_regclass($1) AS exists;`,
        [table]
      );

      if (!res.rows[0].exists) {
        console.log(`⚠️  Table "${table}" is missing. Creating...`);
        await pool.query(createSQL);
        console.log(`✅ Table "${table}" created successfully.`);
      } else {
        console.log(`✔️  Table "${table}" already exists.`);
      }
    }

    console.log("✅ Database schema verification complete.");
  } catch (err) {
    console.error("❌ Error ensuring schema:", err);
    process.exit(1); // exit if DB is unreachable
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureSchema()
    .catch(err => {
      console.error(err);
    })
    .finally(async () => {
      await pool.end();
      process.exit(0);
    });
}

export default ensureSchema;
