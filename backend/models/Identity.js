import db from "../db.js";

export async function findOrRegisterIdentity(gptId, gptVersion) {
  const now = new Date();

  const result = await db.query(
    `UPDATE identities
     SET call_count = call_count + 1, last_seen = $2, gpt_version = $3
     WHERE gpt_id = $1
     RETURNING *`,
    [gptId, now, gptVersion]
  );

  if (result.rows.length > 0) return result.rows[0];

  const insert = await db.query(
    `INSERT INTO identities (gpt_id, gpt_version, call_count, last_seen)
     VALUES ($1, $2, 1, $3)
     RETURNING *`,
    [gptId, gptVersion, now]
  );

  return insert.rows[0];
}
