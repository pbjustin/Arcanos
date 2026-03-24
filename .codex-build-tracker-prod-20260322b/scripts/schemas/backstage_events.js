export default {
  tableName: 'backstage_events',
  definition: {
    data: 'JSONB NOT NULL',
    created_at: 'TIMESTAMPTZ DEFAULT NOW()'
  }
};
