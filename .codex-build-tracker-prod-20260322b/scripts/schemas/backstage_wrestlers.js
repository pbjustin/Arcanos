export default {
  tableName: 'backstage_wrestlers',
  definition: {
    name: 'TEXT UNIQUE NOT NULL',
    overall: 'INTEGER NOT NULL',
    created_at: 'TIMESTAMPTZ DEFAULT NOW()',
    updated_at: 'TIMESTAMPTZ DEFAULT NOW()'
  }
};
