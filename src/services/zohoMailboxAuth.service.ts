import axios from "axios";
import { URLSearchParams } from "url";
import { assertOAuthConfig, env } from "../config/env";
import { ZohoApiError } from "../errors/zohoError";
import { mailboxStore, MailboxTokenRecord } from "../store/mailboxStore";
import { logger } from "../utils/logger";
import { normalizeExpiresAt, resolveMailApiDomain } from "../utils/zohoDomain";
import { zohoMailRequest } from "./zohoClient";

const EXPIRY_SKEW_MS = 2 * 60 * 1000;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  api_domain?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type ZohoEnvelope<T> = {
  status?: { code?: number; description?: string };
  data?: T;
};

async function requestToken(
  params: URLSearchParams,
  accountsUrl: string
): Promise<TokenResponse> {
  const url = `${accountsUrl.replace(/\/$/, "")}/oauth/v2/token`;
  const response = await axios.post<TokenResponse>(url, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: env.zohoRequestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status >= 400 || response.data?.error || !response.data.access_token) {
    throw new ZohoApiError({
      message:
        response.data?.error_description ||
        response.data?.error ||
        "Token request failed",
      httpStatus: response.status >= 400 ? response.status : 400,
      endpoint: url,
      zohoCode: response.data?.error,
    });
  }

  return response.data;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

async function resolveIdentityFromAccessToken(
  accessToken: string,
  mailApiDomain: string
): Promise<{ email: string; accountId: string }> {
  const response = await zohoMailRequest<
    ZohoEnvelope<Record<string, unknown> | Record<string, unknown>[]>
  >({
    path: "/api/accounts",
    accessToken,
    mailApiDomain,
    retries: 0,
    context: { action: "resolveMailboxIdentity" },
  });

  const rows = asArray(response.data);
  const primary =
    rows.find((r) => r.isDefaultAccount === true) ||
    rows.find((r) => r.type === "ZOHO_ACCOUNT") ||
    rows[0];

  if (!primary) {
    throw new Error("Token is valid but /api/accounts returned no mailbox");
  }

  const email = String(
    primary.primaryEmailAddress ||
      primary.mailboxAddress ||
      primary.incomingUserName ||
      ""
  );
  const accountId = String(primary.accountId || "");
  if (!email || !accountId) {
    throw new Error("Could not resolve email/accountId from /api/accounts");
  }

  return { email, accountId };
}

export async function connectMailboxWithCode(
  code: string,
  accountsUrl = env.zohoAccountsUrl,
  expectedEmail?: string,
  options?: { mode?: "self" | "oauth" }
): Promise<MailboxTokenRecord> {
  assertOAuthConfig();
  if (!code) {
    throw new Error("Authorization code is required");
  }

  const mode = options?.mode || "self";
  const buildParams = (includeRedirectUri: boolean) => {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.zohoClientId,
      client_secret: env.zohoClientSecret,
      code,
      scope: env.zohoScopes,
    });
    if (includeRedirectUri) {
      params.set("redirect_uri", env.zohoRedirectUri);
    }
    return params;
  };

  let data: TokenResponse;
  try {
    // Self Client codes usually reject/ignore redirect_uri.
    // Browser OAuth codes require the exact registered redirect_uri.
    data = await requestToken(
      buildParams(mode === "oauth"),
      accountsUrl
    );
  } catch (error) {
    if (mode === "self") {
      try {
        data = await requestToken(buildParams(true), accountsUrl);
        logger.info("Self Client token exchange succeeded with redirect_uri");
      } catch {
        throw enrichInvalidCodeError(error);
      }
    } else {
      throw enrichInvalidCodeError(error);
    }
  }

  const mailApiDomain = resolveMailApiDomain({
    accountsUrl,
    apiDomain: data.api_domain,
    fallback: env.zohoApiDomain,
  });

  const identity = await resolveIdentityFromAccessToken(
    data.access_token,
    mailApiDomain
  );

  if (
    expectedEmail &&
    identity.email.toLowerCase() !== expectedEmail.trim().toLowerCase()
  ) {
    throw new Error(
      `OAuth login was ${identity.email}, but you selected ${expectedEmail}. Sign in to Zoho as the selected user and try again.`
    );
  }

  return mailboxStore.save({
    email: identity.email,
    accountId: identity.accountId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    apiDomain: data.api_domain || env.zohoApiDomain,
    mailApiDomain,
    accountsUrl,
    expiresAt: normalizeExpiresAt(data.expires_in),
    scope: data.scope || env.zohoScopes,
    tokenType: data.token_type,
    updatedAt: new Date().toISOString(),
  });
}

function enrichInvalidCodeError(error: unknown): Error {
  if (
    error instanceof ZohoApiError &&
    String(error.zohoCode).toLowerCase() === "invalid_code"
  ) {
    return new ZohoApiError({
      message: "invalid_code",
      httpStatus: 400,
      endpoint: error.endpoint,
      zohoCode: "invalid_code",
      raw: error.raw,
      context: {
        hint:
          "Self Client codes only work when generated in YOUR API Console app (same Client ID as this server) and expire in about 1 minute / one use. For other users, use Connect via Zoho login (browser OAuth) instead of pasting a Self Client code.",
      },
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function refreshMailboxToken(
  email: string
): Promise<MailboxTokenRecord> {
  assertOAuthConfig();
  const current = await mailboxStore.get(email);
  if (!current?.refreshToken) {
    throw new Error(
      `No refresh token for mailbox ${email}. Connect that mailbox first.`
    );
  }

  const accountsUrl = current.accountsUrl || env.zohoAccountsUrl;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.zohoClientId,
    client_secret: env.zohoClientSecret,
    refresh_token: current.refreshToken,
    scope: env.zohoScopes,
  });

  const data = await requestToken(params, accountsUrl);
  const mailApiDomain = resolveMailApiDomain({
    accountsUrl,
    apiDomain: data.api_domain,
    fallback: current.mailApiDomain,
  });

  return mailboxStore.save({
    ...current,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
    apiDomain: data.api_domain || current.apiDomain,
    mailApiDomain,
    accountsUrl,
    expiresAt: normalizeExpiresAt(data.expires_in),
    scope: data.scope || current.scope,
    tokenType: data.token_type || current.tokenType,
    updatedAt: new Date().toISOString(),
  });
}

export async function getValidMailboxAccessToken(
  email: string
): Promise<{ accessToken: string; mailApiDomain: string; accountId: string }> {
  let current = await mailboxStore.get(email);
  if (!current) {
    throw new Error(
      `Mailbox ${email} is not connected. POST /api/zoho/mailboxes/connect with a Self Client code generated while logged in as that user.`
    );
  }

  const needsRefresh =
    !current.accessToken ||
    !current.expiresAt ||
    current.expiresAt - Date.now() <= EXPIRY_SKEW_MS;

  if (needsRefresh) {
    current = await refreshMailboxToken(email);
  }

  if (!current.accountId) {
    const identity = await resolveIdentityFromAccessToken(
      current.accessToken,
      current.mailApiDomain
    );
    current = await mailboxStore.save({
      ...current,
      accountId: identity.accountId,
    });
  }

  return {
    accessToken: current.accessToken,
    mailApiDomain: current.mailApiDomain,
    accountId: current.accountId!,
  };
}

export async function listConnectedMailboxes() {
  return mailboxStore.list();
}
