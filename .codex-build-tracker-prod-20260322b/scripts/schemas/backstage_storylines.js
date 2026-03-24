export default {
  tableName: 'backstage_storylines',
  definition: {
    story_key: 'TEXT UNIQUE NOT NULL',
    storyline: 'TEXT NOT NULL',
    created_at: 'TIMESTAMPTZ DEFAULT NOW()',
    updated_at: 'TIMESTAMPTZ DEFAULT NOW()'
  }
};
