import { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../utils/logger";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!env.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Add your Supabase Postgres connection string to .env"
    );
  }

  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });

    pool.on("error", (err) => {
      logger.error("Unexpected Postgres pool error", {
        error: err.message,
      });
    });
  }

  return pool;
}

export async function assertDbConnection(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT 1");
    logger.info("Postgres connection OK");
  } finally {
    client.release();
  }
}
