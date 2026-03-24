export default {
  tableName: 'backstage_story_beats',
  definition: {
    data: 'JSONB NOT NULL',
    created_at: 'TIMESTAMPTZ DEFAULT NOW()'
  }
};
