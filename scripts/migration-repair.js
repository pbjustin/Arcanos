import OpenAI from 'openai';
import { Client } from 'pg';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    return;
  }
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set');
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  const openai = new OpenAI({ apiKey });

  try {
    await client.connect();

    const issues = [];

    // Missing foreign key references
    const fkCheck = await client.query(`
      SELECT conname, conrelid::regclass AS table_name, confrelid::regclass AS foreign_table
      FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 0;
    `);
    if (fkCheck.rows.length) {
      issues.push({ type: 'missing_foreign_keys', data: fkCheck.rows });
    }

    // Duplicate index names
    const idxCheck = await client.query(`
      SELECT indexname, tablename
      FROM pg_indexes
      GROUP BY indexname, tablename
      HAVING COUNT(*) > 1;
    `);
    if (idxCheck.rows.length) {
      issues.push({ type: 'duplicate_indexes', data: idxCheck.rows });
    }

    // Constraints referencing non-existent columns
    const orphanCheck = await client.query(`
      SELECT c.conname, c.conrelid::regclass AS table_name
      FROM pg_constraint c
      LEFT JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conkey IS NOT NULL AND a.attname IS NULL;
    `);
    if (orphanCheck.rows.length) {
      issues.push({ type: 'orphaned_constraints', data: orphanCheck.rows });
    }

    if (!issues.length) {
      console.log('[]');
      return;
    }

    const response = await openai.chat.completions.create({
      model: 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You are a PostgreSQL schema repair assistant. Output a JSON array of objects with keys `issue` and `repair_sql`. Each `repair_sql` must be idempotent.'
        },
        {
          role: 'user',
          content: JSON.stringify(issues)
        }
      ]
    });

    console.log(response.choices[0].message.content);
  } catch (err) {
    console.error('Migration repair failed:', err);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
