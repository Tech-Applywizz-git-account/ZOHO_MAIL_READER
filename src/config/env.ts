import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export type OAuthMode = "org" | "server";

const rawMode = optional("ZOHO_OAUTH_MODE", "server").toLowerCase();
const oauthMode: OAuthMode = rawMode === "org" ? "org" : "server";

/** Practical scopes for org user listing + mailbox read testing. */
const DEFAULT_SCOPES =
  "ZohoMail.organization.accounts.ALL,ZohoMail.accounts.ALL,ZohoMail.folders.ALL,ZohoMail.messages.ALL";

export const env = {
  port: Number(optional("PORT", "5000")),
  zohoClientId: optional("ZOHO_CLIENT_ID"),
  zohoClientSecret: optional("ZOHO_CLIENT_SECRET"),
  zohoRedirectUri: optional(
    "ZOHO_REDIRECT_URI",
    "http://localhost:5000/api/zoho/callback"
  ),
  zohoAccountsUrl: optional("ZOHO_ACCOUNTS_URL", "https://accounts.zoho.com").replace(
    /\/$/,
    ""
  ),
  zohoApiDomain: optional("ZOHO_API_DOMAIN", "https://mail.zoho.com").replace(
    /\/$/,
    ""
  ),
  zohoAccessToken: optional("ZOHO_ACCESS_TOKEN"),
  zohoRefreshToken: optional("ZOHO_REFRESH_TOKEN"),
  zohoZoid: optional("ZOHO_ZOID"),
  zohoScopes: optional("ZOHO_SCOPES", DEFAULT_SCOPES),
  zohoOauthMode: oauthMode,
  zohoConcurrency: Math.max(1, Number(optional("ZOHO_CONCURRENCY", "2"))),
  zohoRequestTimeoutMs: Math.max(
    1000,
    Number(optional("ZOHO_REQUEST_TIMEOUT_MS", "30000"))
  ),
  databaseUrl: optional("DATABASE_URL"),
};

export function assertOAuthConfig(): void {
  required("ZOHO_CLIENT_ID", env.zohoClientId || undefined);
  required("ZOHO_CLIENT_SECRET", env.zohoClientSecret || undefined);
  required("ZOHO_REDIRECT_URI", env.zohoRedirectUri || undefined);
  required("ZOHO_ACCOUNTS_URL", env.zohoAccountsUrl || undefined);
}
