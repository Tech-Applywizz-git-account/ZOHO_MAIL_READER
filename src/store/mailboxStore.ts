import { env } from "../config/env";
import { getPool } from "../db/pool";
import { TokenRecord } from "../types/zoho.types";
import { logger } from "../utils/logger";
import { resolveMailApiDomain } from "../utils/zohoDomain";

export type MailboxTokenRecord = TokenRecord & {
  email: string;
  accountId?: string;
  zuid?: string;
  status?: "active" | "revoked" | "error";
  lastError?: string | null;
};

type MailboxRow = {
  email: string;
  zuid: string | null;
  account_id: string | null;
  refresh_token: string;
  access_token: string | null;
  expires_at: Date | null;
  api_domain: string | null;
  mail_api_domain: string | null;
  accounts_url: string | null;
  scope: string | null;
  token_type: string | null;
  status: string;
  last_error: string | null;
  connected_at: Date;
  updated_at: Date;
};

function mapRow(row: MailboxRow): MailboxTokenRecord {
  return {
    email: row.email,
    zuid: row.zuid || undefined,
    accountId: row.account_id || undefined,
    refreshToken: row.refresh_token,
    accessToken: row.access_token || "",
    expiresAt: row.expires_at ? row.expires_at.getTime() : 0,
    apiDomain: row.api_domain || env.zohoApiDomain,
    mailApiDomain: row.mail_api_domain || env.zohoApiDomain,
    accountsUrl: row.accounts_url || env.zohoAccountsUrl,
    scope: row.scope || undefined,
    tokenType: row.token_type || undefined,
    status: (row.status as MailboxTokenRecord["status"]) || "active",
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Per-user mailbox OAuth tokens in Postgres.
 * Zoho Mail message APIs only accept the mailbox owner's token.
 */
export class MailboxStore {
  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async list(): Promise<
    Array<{
      email: string;
      accountId?: string;
      zuid?: string;
      hasRefreshToken: boolean;
      expiresAt: number;
      status: string;
      updatedAt: string;
    }>
  > {
    const result = await getPool().query<MailboxRow>(
      `SELECT *
       FROM zoho_mailboxes
       ORDER BY email ASC`
    );

    return result.rows.map((row) => ({
      email: row.email,
      accountId: row.account_id || undefined,
      zuid: row.zuid || undefined,
      hasRefreshToken: Boolean(row.refresh_token),
      expiresAt: row.expires_at ? row.expires_at.getTime() : 0,
      status: row.status,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async get(email: string): Promise<MailboxTokenRecord | null> {
    const result = await getPool().query<MailboxRow>(
      `SELECT *
       FROM zoho_mailboxes
       WHERE email = $1
       LIMIT 1`,
      [this.normalizeEmail(email)]
    );
    if (!result.rows[0]) {
      return null;
    }
    return mapRow(result.rows[0]);
  }

  async save(record: MailboxTokenRecord): Promise<MailboxTokenRecord> {
    const email = this.normalizeEmail(record.email);
    const mailApiDomain = resolveMailApiDomain({
      accountsUrl: record.accountsUrl,
      apiDomain: record.apiDomain,
      fallback: record.mailApiDomain || env.zohoApiDomain,
    });

    if (!record.refreshToken) {
      throw new Error(`Cannot save mailbox ${email} without refresh_token`);
    }

    const expiresAt =
      record.expiresAt && record.expiresAt > 0
        ? new Date(record.expiresAt)
        : null;

    const result = await getPool().query<MailboxRow>(
      `INSERT INTO zoho_mailboxes (
          email, zuid, account_id, refresh_token, access_token, expires_at,
          api_domain, mail_api_domain, accounts_url, scope, token_type,
          status, last_error, connected_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          COALESCE($12, 'active'), $13, NOW(), NOW()
        )
        ON CONFLICT (email) DO UPDATE SET
          zuid = COALESCE(EXCLUDED.zuid, zoho_mailboxes.zuid),
          account_id = COALESCE(EXCLUDED.account_id, zoho_mailboxes.account_id),
          refresh_token = EXCLUDED.refresh_token,
          access_token = EXCLUDED.access_token,
          expires_at = EXCLUDED.expires_at,
          api_domain = EXCLUDED.api_domain,
          mail_api_domain = EXCLUDED.mail_api_domain,
          accounts_url = EXCLUDED.accounts_url,
          scope = EXCLUDED.scope,
          token_type = EXCLUDED.token_type,
          status = COALESCE(EXCLUDED.status, zoho_mailboxes.status),
          last_error = EXCLUDED.last_error,
          updated_at = NOW()
        RETURNING *`,
      [
        email,
        record.zuid || null,
        record.accountId || null,
        record.refreshToken,
        record.accessToken || null,
        expiresAt,
        record.apiDomain || env.zohoApiDomain,
        mailApiDomain,
        record.accountsUrl || env.zohoAccountsUrl,
        record.scope || null,
        record.tokenType || null,
        record.status || "active",
        record.lastError || null,
      ]
    );

    const saved = mapRow(result.rows[0]);
    logger.info("Mailbox token stored in Postgres", {
      email: saved.email,
      accountId: saved.accountId,
      hasRefreshToken: Boolean(saved.refreshToken),
    });
    return saved;
  }

  async remove(email: string): Promise<boolean> {
    const result = await getPool().query(
      `DELETE FROM zoho_mailboxes WHERE email = $1`,
      [this.normalizeEmail(email)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markError(email: string, lastError: string): Promise<void> {
    await getPool().query(
      `UPDATE zoho_mailboxes
       SET status = 'error', last_error = $2, updated_at = NOW()
       WHERE email = $1`,
      [this.normalizeEmail(email), lastError]
    );
  }
}

export const mailboxStore = new MailboxStore();
