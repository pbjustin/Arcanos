/**
 * Self-Reflection Repository for ARCANOS
 *
 * Persists AI reflection outputs for historical analysis and tooling reuse.
 */

import { isDatabaseConnected } from '../client.js';
import { query } from '../query.js';

export interface SelfReflectionInsert {
  priority: string;
  category: string;
  content: string;
  improvements: string[];
  metadata: unknown;
}

/**
 * Store a generated self-reflection in the database when connectivity is available.
 */
export async function saveSelfReflection({
  priority,
  category,
  content,
  improvements,
  metadata
}: SelfReflectionInsert): Promise<void> {
  if (!isDatabaseConnected()) {
    console.warn('[🧠 Reflections] Database not connected; skipping persistence for self-reflection');
    return;
  }

  const sanitizedImprovements = Array.isArray(improvements) ? improvements : [];
  const serializedMetadata = metadata ?? {};

  await query(
    `INSERT INTO self_reflections (priority, category, content, improvements, metadata)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      priority,
      category,
      content,
      JSON.stringify(sanitizedImprovements),
      JSON.stringify(serializedMetadata)
    ]
  );
}
