const { Pool } = require("pg");

// Always connect using DATABASE_URL (Railway connection string)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:BdaNYEBHVpyzlUOmBeBTiRvXwcbbpTYE@postgres-7rdb.railway.internal:5432/railway?sslmode=disable",
  ssl: process.env.DATABASE_URL?.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : false,
});

// Test connection
pool.connect()
  .then(() => console.log("✅ Connected to PostgreSQL"))
  .catch(err => {
    console.error("❌ Database connection failed:", err.message);
    process.exit(1);
  });

module.exports = pool;
