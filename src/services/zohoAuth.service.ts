import axios from "axios";
import { URLSearchParams } from "url";
import { assertOAuthConfig, env, OAuthMode } from "../config/env";
import { ZohoApiError } from "../errors/zohoError";
import { tokenStore } from "../store/tokenStore";
import { TokenRecord } from "../types/zoho.types";
import { logger } from "../utils/logger";
import { normalizeExpiresAt, resolveMailApiDomain } from "../utils/zohoDomain";

const EXPIRY_SKEW_MS = 2 * 60 * 1000;

export function getAuthorizationUrl(
  mode: OAuthMode = env.zohoOauthMode,
  state?: string
): string {
  assertOAuthConfig();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.zohoClientId,
    scope: env.zohoScopes,
    redirect_uri: env.zohoRedirectUri,
    access_type: "offline",
    prompt: "consent",
  });
  if (state) {
    params.set("state", state);
  }

  // ORG/instance-level: /oauth/v2/org/auth
  // Server-based admin user: /oauth/v2/auth
  const path =
    mode === "org" ? "/oauth/v2/org/auth" : "/oauth/v2/auth";

  logger.info("Building Zoho authorization URL", {
    mode,
    path,
    scopes: env.zohoScopes,
  });

  return `${env.zohoAccountsUrl}${path}?${params.toString()}`;
}

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

async function requestToken(
  params: URLSearchParams,
  accountsUrl: string
): Promise<TokenResponse> {
  const url = `${accountsUrl.replace(/\/$/, "")}/oauth/v2/token`;
  try {
    const response = await axios.post<TokenResponse>(url, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: env.zohoRequestTimeoutMs,
      validateStatus: () => true,
    });

    if (response.status >= 400 || response.data?.error) {
      throw new ZohoApiError({
        message:
          response.data?.error_description ||
          response.data?.error ||
          "Token request failed",
        httpStatus: response.status >= 400 ? response.status : 400,
        endpoint: url,
        zohoCode: response.data?.error,
        raw: {
          error: response.data?.error,
          error_description: response.data?.error_description,
        },
      });
    }

    if (!response.data.access_token) {
      throw new ZohoApiError({
        message: "Token response missing access_token",
        httpStatus: 500,
        endpoint: url,
        raw: { hasRefreshToken: Boolean(response.data.refresh_token) },
      });
    }

    return response.data;
  } catch (error) {
    if (error instanceof ZohoApiError) {
      throw error;
    }
    throw new ZohoApiError({
      message: error instanceof Error ? error.message : "Token request failed",
      httpStatus: 500,
      endpoint: url,
    });
  }
}

async function persistTokenResponse(
  data: TokenResponse,
  accountsUrl: string,
  existingRefreshToken?: string
): Promise<TokenRecord> {
  const mailApiDomain = resolveMailApiDomain({
    accountsUrl,
    apiDomain: data.api_domain,
    fallback: env.zohoApiDomain,
  });

  const record = await tokenStore.save({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || existingRefreshToken || "",
    apiDomain: data.api_domain || env.zohoApiDomain,
    mailApiDomain,
    accountsUrl,
    expiresAt: normalizeExpiresAt(data.expires_in),
    scope: data.scope || env.zohoScopes,
    tokenType: data.token_type,
  });

  logger.info("OAuth tokens stored", {
    hasRefreshToken: Boolean(record.refreshToken),
    apiDomain: record.apiDomain,
    mailApiDomain: record.mailApiDomain,
    accountsUrl: record.accountsUrl,
    scope: record.scope,
    expiresAt: record.expiresAt,
  });

  return record;
}

export async function exchangeAuthorizationCode(
  code: string,
  accountsServerFromCallback?: string
): Promise<TokenRecord> {
  assertOAuthConfig();
  if (!code) {
    throw new Error("Authorization code is required");
  }

  const accountsUrl = (accountsServerFromCallback || env.zohoAccountsUrl).replace(
    /\/$/,
    ""
  );

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.zohoClientId,
    client_secret: env.zohoClientSecret,
    redirect_uri: env.zohoRedirectUri,
    code,
    scope: env.zohoScopes,
  });

  const data = await requestToken(params, accountsUrl);
  return persistTokenResponse(data, accountsUrl);
}

export async function refreshAccessToken(): Promise<TokenRecord> {
  assertOAuthConfig();
  const current = tokenStore.get();
  if (!current?.refreshToken) {
    throw new Error(
      "No refresh token available. Complete authorization first via /api/zoho/authorize"
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
  return persistTokenResponse(data, accountsUrl, current.refreshToken);
}

export async function getValidAccessToken(): Promise<string> {
  const current = tokenStore.get();
  if (!current?.accessToken && !current?.refreshToken) {
    throw new Error(
      "Not authenticated. Open GET /api/zoho/authorize and complete admin consent."
    );
  }

  const needsRefresh =
    !current.accessToken ||
    !current.expiresAt ||
    current.expiresAt - Date.now() <= EXPIRY_SKEW_MS;

  if (needsRefresh) {
    if (!current.refreshToken) {
      throw new Error(
        "Access token expired and no refresh token is stored. Re-authorize."
      );
    }
    const refreshed = await refreshAccessToken();
    return refreshed.accessToken;
  }

  return current.accessToken;
}

export function getTokenStatus() {
  return {
    ...tokenStore.getPublicStatus(),
    oauthMode: env.zohoOauthMode,
    scopesConfigured: env.zohoScopes,
  };
}

export async function clearStoredTokens(): Promise<void> {
  await tokenStore.clear();
  logger.info("Cleared stored OAuth tokens");
}
