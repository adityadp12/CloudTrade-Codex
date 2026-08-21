import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(98127411)");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  // Baseline databases created by the first development prototype before
  // schema_migrations was populated.
  const legacy = await client.query("SELECT to_regclass('public.users') AS users, to_regclass('public.terminal_telemetry_latest') AS telemetry");
  if (legacy.rows[0].users) await client.query("INSERT INTO schema_migrations(version) VALUES('001_initial.sql') ON CONFLICT DO NOTHING");
  if (legacy.rows[0].telemetry) await client.query("INSERT INTO schema_migrations(version) VALUES('002_telemetry.sql') ON CONFLICT DO NOTHING");
  const applied = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const files = (await fs.readdir(path.resolve("migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.resolve("migrations", file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [file]);
      await client.query("COMMIT");
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(98127411)").catch(() => {});
  client.release();
  await pool.end();
}
