import dns from "dns";
import { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../utils/logger";

// Render (and many PaaS hosts) are IPv4-only. Supabase pooler hostnames often
// resolve to IPv6 first, which causes: connect ENETUNREACH ... :6543
dns.setDefaultResultOrder("ipv4first");

let pool: Pool | null = null;

function ipv4Lookup(
  hostname: string,
  _options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number
  ) => void
): void {
  dns.lookup(hostname, { family: 4 }, callback);
}

export function getPool(): Pool {
  if (!env.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Add your Supabase Postgres connection string to .env"
    );
  }

  if (!pool) {
    // `lookup` is supported by Node net.connect / pg but missing from older @types/pg
    pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      lookup: ipv4Lookup,
    } as ConstructorParameters<typeof Pool>[0]);

    pool.on("error", (err) => {
      logger.error("Unexpected Postgres pool error", {
        error: err.message,
      });
    });
  }

  return pool;
}

export async function assertDbConnection(): Promise<void> {
  try {
    const client = await getPool().connect();
    try {
      await client.query("SELECT 1");
      logger.info("Postgres connection OK");
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENETUNREACH") || message.includes("ECONNREFUSED")) {
      throw new Error(
        `${message}. Tip: Render is IPv4-only — use the Supabase Session pooler connection string (Dashboard → Connect). Redeploy after this IPv4 DNS fix.`
      );
    }
    throw error;
  }
}
