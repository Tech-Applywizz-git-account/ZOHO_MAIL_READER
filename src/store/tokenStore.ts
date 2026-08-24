import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { getPool } from "../db/pool";
import { TokenRecord } from "../types/zoho.types";
import { logger } from "../utils/logger";
import { resolveMailApiDomain } from "../utils/zohoDomain";

const TOKEN_KIND = "admin";
const LEGACY_TOKEN_FILE = path.resolve(process.cwd(), ".data", "tokens.json");

type TokenRow = {
  access_token: string | null;
  refresh_token: string;
  expires_at: Date | null;
  api_domain: string | null;
  mail_api_domain: string | null;
  accounts_url: string | null;
  scope: string | null;
  token_type: string | null;
  zoid: string | null;
  updated_at: Date;
};

/**
 * Admin/org OAuth token in Postgres (zoho_oauth_tokens).
 * Memory cache for sync reads; persist writes are async.
 */
export class TokenStore {
  private memory: TokenRecord | null = null;
  private ready = false;

  async init(): Promise<void> {
    if (!env.databaseUrl) {
      this.memory = this.seedFromEnv();
      this.ready = true;
      logger.warn("DATABASE_URL missing — admin tokens only in memory/env");
      return;
    }

    const fromDb = await this.readFromDb();
    if (fromDb) {
      this.memory = this.normalizeRecord(fromDb);
      this.ready = true;
      logger.info("Admin OAuth token loaded from Postgres");
      return;
    }

    const legacy = this.readLegacyFile();
    if (legacy?.refreshToken) {
      const migrated = this.normalizeRecord(legacy);
      if (migrated) {
        this.memory = migrated;
        await this.persist(migrated);
        logger.info("Migrated admin OAuth token from .data/tokens.json to Postgres");
      }
      this.ready = true;
      return;
    }

    const seeded = this.seedFromEnv();
    if (seeded?.refreshToken || seeded?.accessToken) {
      const next = this.normalizeRecord(seeded);
      if (next) {
        this.memory = next;
        await this.persist(next);
        logger.info("Seeded admin OAuth token from env into Postgres");
      }
    }

    this.ready = true;
  }

  private normalizeRecord(record: TokenRecord | null): TokenRecord | null {
    if (!record) {
      return null;
    }

    const mailApiDomain = resolveMailApiDomain({
      accountsUrl: record.accountsUrl,
      apiDomain: record.apiDomain,
      fallback: record.mailApiDomain || env.zohoApiDomain,
    });

    if (mailApiDomain !== record.mailApiDomain) {
      return {
        ...record,
        mailApiDomain,
        updatedAt: new Date().toISOString(),
      };
    }

    return record;
  }

  private mapRow(row: TokenRow): TokenRecord {
    return {
      accessToken: row.access_token || "",
      refreshToken: row.refresh_token,
      apiDomain: row.api_domain || env.zohoApiDomain,
      mailApiDomain: row.mail_api_domain || env.zohoApiDomain,
      accountsUrl: row.accounts_url || env.zohoAccountsUrl,
      expiresAt: row.expires_at ? row.expires_at.getTime() : 0,
      scope: row.scope || undefined,
      tokenType: row.token_type || undefined,
      zoid: row.zoid || env.zohoZoid || undefined,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async readFromDb(): Promise<TokenRecord | null> {
    const result = await getPool().query<TokenRow>(
      `SELECT access_token, refresh_token, expires_at, api_domain,
              mail_api_domain, accounts_url, scope, token_type, zoid, updated_at
       FROM zoho_oauth_tokens
       WHERE token_kind = $1
       LIMIT 1`,
      [TOKEN_KIND]
    );
    if (!result.rows[0]) {
      return null;
    }
    return this.mapRow(result.rows[0]);
  }

  private readLegacyFile(): TokenRecord | null {
    try {
      if (!fs.existsSync(LEGACY_TOKEN_FILE)) {
        return null;
      }
      const raw = fs.readFileSync(LEGACY_TOKEN_FILE, "utf8").replace(/^\uFEFF/, "");
      return JSON.parse(raw) as TokenRecord;
    } catch {
      return null;
    }
  }

  private seedFromEnv(): TokenRecord | null {
    if (!env.zohoRefreshToken && !env.zohoAccessToken) {
      return null;
    }
    const now = Date.now();
    return {
      accessToken: env.zohoAccessToken || "",
      refreshToken: env.zohoRefreshToken || "",
      apiDomain: env.zohoApiDomain,
      mailApiDomain: env.zohoApiDomain,
      accountsUrl: env.zohoAccountsUrl,
      expiresAt: env.zohoAccessToken ? now + 50 * 60 * 1000 : 0,
      zoid: env.zohoZoid || undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  private async persist(record: TokenRecord): Promise<void> {
    if (!env.databaseUrl) {
      return;
    }

    await getPool().query(
      `INSERT INTO zoho_oauth_tokens (
         token_kind, access_token, refresh_token, expires_at,
         api_domain, mail_api_domain, accounts_url, scope, token_type, zoid, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (token_kind) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         api_domain = EXCLUDED.api_domain,
         mail_api_domain = EXCLUDED.mail_api_domain,
         accounts_url = EXCLUDED.accounts_url,
         scope = EXCLUDED.scope,
         token_type = EXCLUDED.token_type,
         zoid = COALESCE(EXCLUDED.zoid, zoho_oauth_tokens.zoid),
         updated_at = NOW()`,
      [
        TOKEN_KIND,
        record.accessToken || null,
        record.refreshToken,
        record.expiresAt ? new Date(record.expiresAt) : null,
        record.apiDomain || null,
        record.mailApiDomain || null,
        record.accountsUrl || null,
        record.scope || null,
        record.tokenType || null,
        record.zoid || env.zohoZoid || null,
      ]
    );
  }

  get(): TokenRecord | null {
    return this.memory;
  }

  async save(
    partial: Partial<TokenRecord> &
      Pick<TokenRecord, "accessToken" | "refreshToken">
  ): Promise<TokenRecord> {
    const current = this.memory;
    const next: TokenRecord = {
      accessToken: partial.accessToken,
      refreshToken: partial.refreshToken || current?.refreshToken || "",
      apiDomain: partial.apiDomain || current?.apiDomain || env.zohoApiDomain,
      mailApiDomain:
        partial.mailApiDomain || current?.mailApiDomain || env.zohoApiDomain,
      accountsUrl:
        partial.accountsUrl || current?.accountsUrl || env.zohoAccountsUrl,
      expiresAt: partial.expiresAt ?? current?.expiresAt ?? 0,
      scope: partial.scope ?? current?.scope,
      tokenType: partial.tokenType ?? current?.tokenType,
      zoid: partial.zoid ?? current?.zoid ?? (env.zohoZoid || undefined),
      updatedAt: new Date().toISOString(),
    };
    this.memory = next;
    await this.persist(next);
    return next;
  }

  async setZoid(zoid: string): Promise<void> {
    const current = this.get();
    if (!current) {
      const next: TokenRecord = {
        accessToken: env.zohoAccessToken || "",
        refreshToken: env.zohoRefreshToken || "",
        apiDomain: env.zohoApiDomain,
        mailApiDomain: env.zohoApiDomain,
        accountsUrl: env.zohoAccountsUrl,
        expiresAt: 0,
        zoid,
        updatedAt: new Date().toISOString(),
      };
      this.memory = next;
      await this.persist(next);
      return;
    }
    const next = { ...current, zoid, updatedAt: new Date().toISOString() };
    this.memory = next;
    await this.persist(next);
  }

  getPublicStatus(): {
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    expiresAt: number | null;
    apiDomain: string | null;
    mailApiDomain: string | null;
    accountsUrl: string | null;
    zoid: string | null;
    scope: string | null;
    updatedAt: string | null;
  } {
    const t = this.get();
    return {
      hasAccessToken: Boolean(t?.accessToken),
      hasRefreshToken: Boolean(t?.refreshToken),
      expiresAt: t?.expiresAt ?? null,
      apiDomain: t?.apiDomain ?? null,
      mailApiDomain: t?.mailApiDomain ?? null,
      accountsUrl: t?.accountsUrl ?? null,
      zoid: t?.zoid ?? (env.zohoZoid || null),
      scope: t?.scope ?? null,
      updatedAt: t?.updatedAt ?? null,
    };
  }

  async clear(): Promise<void> {
    this.memory = null;
    if (!env.databaseUrl) {
      return;
    }
    await getPool().query(
      `DELETE FROM zoho_oauth_tokens WHERE token_kind = $1`,
      [TOKEN_KIND]
    );
  }
}

export const tokenStore = new TokenStore();
