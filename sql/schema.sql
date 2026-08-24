-- Zoho Mail Reader: per-user mailbox OAuth tokens
-- Run this in Supabase SQL Editor (or psql)

CREATE TABLE IF NOT EXISTS zoho_mailboxes (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  zuid            TEXT,
  account_id      TEXT,
  refresh_token   TEXT NOT NULL,
  access_token    TEXT,
  expires_at      TIMESTAMPTZ,
  api_domain      TEXT,
  mail_api_domain TEXT,
  accounts_url    TEXT,
  scope           TEXT,
  token_type      TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'revoked', 'error')),
  last_error      TEXT,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT zoho_mailboxes_email_unique UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_zoho_mailboxes_status
  ON zoho_mailboxes (status);

CREATE INDEX IF NOT EXISTS idx_zoho_mailboxes_account_id
  ON zoho_mailboxes (account_id);

-- Optional: admin/org app token (for listing users, not reading others' mail)
CREATE TABLE IF NOT EXISTS zoho_oauth_tokens (
  id              BIGSERIAL PRIMARY KEY,
  token_kind      TEXT NOT NULL DEFAULT 'admin'
                  CHECK (token_kind IN ('admin', 'org')),
  access_token    TEXT,
  refresh_token   TEXT NOT NULL,
  expires_at      TIMESTAMPTZ,
  api_domain      TEXT,
  mail_api_domain TEXT,
  accounts_url    TEXT,
  scope           TEXT,
  token_type      TEXT,
  zoid            TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT zoho_oauth_tokens_kind_unique UNIQUE (token_kind)
);
