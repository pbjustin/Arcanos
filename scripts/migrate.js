import knex from "knex";

const db = knex({
  client: "pg",
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: "./migrations",
  },
});

(async () => {
  try {
    console.log("🚀 Running database migrations...");
    await db.migrate.latest();
    console.log("✅ Migrations complete");
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
})();

