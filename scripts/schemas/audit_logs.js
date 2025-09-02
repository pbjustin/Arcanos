export default {
  tableName: 'audit_logs',
  definition: {
    event: 'TEXT NOT NULL',
    payload: 'JSONB NOT NULL',
    timestamp: 'BIGINT NOT NULL'
  }
};
