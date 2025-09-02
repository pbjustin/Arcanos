export default {
  tableName: 'saves',
  definition: {
    module: 'TEXT NOT NULL',
    data: 'JSONB NOT NULL',
    timestamp: 'BIGINT NOT NULL'
  }
};
