import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../config.js";
import { runMigrations } from "./migrate.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  console.log(await runMigrations(pool, migrationsDir));
} finally {
  await pool.end();
}
