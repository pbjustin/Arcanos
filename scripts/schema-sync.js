import fs from 'fs';
import path from 'path';
import db from '../backend/db.js';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load all schema definitions from the /schemas directory
const schemaDir = path.join(__dirname, 'schemas');
const schemaFiles = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.js'));

async function createTableIfMissing({ tableName, definition }) {
  const existsQuery = `
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = $1
    );
  `;
  const res = await db.query(existsQuery, [tableName]);

  if (!res.rows[0].exists) {
    const columns = Object.entries(definition)
      .map(([col, type]) => `"${col}" ${type}`)
      .join(',\n  ');

    const createQuery = `
      CREATE TABLE "${tableName}" (
        id SERIAL PRIMARY KEY,
        ${columns}
      );
    `;
    await db.query(createQuery);
    console.log(`[PATCH] Created missing table: ${tableName}`);
  }
}

async function runPatch() {
  for (const file of schemaFiles) {
    const modulePath = pathToFileURL(path.join(schemaDir, file));
    const schemaModule = await import(modulePath);
    const schema = schemaModule.default || schemaModule;
    await createTableIfMissing(schema);
  }
}

runPatch()
  .then(() => {
    console.log('[PATCH] Schema synchronization complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[PATCH] Error:', err);
    process.exit(1);
  });
