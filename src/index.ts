import { createApp } from "./app";
import { env } from "./config/env";
import { assertDbConnection } from "./db/pool";
import { tokenStore } from "./store/tokenStore";
import { logger } from "./utils/logger";

async function main(): Promise<void> {
  if (env.databaseUrl) {
    await assertDbConnection();
    await tokenStore.init();
  } else {
    logger.warn(
      "DATABASE_URL not set — mailbox/admin DB storage will fail until configured"
    );
    await tokenStore.init();
  }

  const app = createApp();
  const host = process.env.HOST || "0.0.0.0";
  app.listen(env.port, host, () => {
    logger.info("Zoho mail reader listening", {
      host,
      port: env.port,
      health: `/health`,
      authorize: `/api/zoho/authorize`,
      callback: env.zohoRedirectUri,
      accountsUrl: env.zohoAccountsUrl,
      mailApiDomain: env.zohoApiDomain,
      databaseConfigured: Boolean(env.databaseUrl),
    });
  });
}

main().catch((error) => {
  logger.error("Failed to start server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
