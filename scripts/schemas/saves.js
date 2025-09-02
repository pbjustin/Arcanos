export default {
  tableName: 'saves',
  definition: {
    user_id: 'TEXT NOT NULL',
    content: 'JSONB NOT NULL',
    created_at: 'TIMESTAMP DEFAULT NOW()'
  }
};
