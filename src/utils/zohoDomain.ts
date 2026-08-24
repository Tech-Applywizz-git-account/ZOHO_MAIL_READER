import { env } from "../config/env";

/**
 * Derive Zoho Mail API host from Accounts URL or OAuth api_domain.
 * Prefer OAuth callback DC over .env defaults — env may still say .com
 * while the org instance lives in .in/.eu/etc.
 */
export function resolveMailApiDomain(options: {
  accountsUrl?: string;
  apiDomain?: string;
  fallback?: string;
}): string {
  const candidates = [
    options.accountsUrl,
    options.apiDomain,
    options.fallback,
    env.zohoApiDomain,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();

      if (host.startsWith("mail.")) {
        return `${url.protocol}//${host}`;
      }
      if (host.startsWith("accounts.zoho")) {
        return `${url.protocol}//${host.replace("accounts.zoho", "mail.zoho")}`;
      }
      if (host.startsWith("accounts.zohocloud")) {
        return `${url.protocol}//${host.replace(
          "accounts.zohocloud",
          "mail.zohocloud"
        )}`;
      }
      // https://www.zohoapis.in → https://mail.zoho.in
      const apisMatch = host.match(/^www\.zohoapis(\..+)$/);
      if (apisMatch) {
        return `${url.protocol}//mail.zoho${apisMatch[1]}`;
      }
    } catch {
      // try next candidate
    }
  }

  return "https://mail.zoho.com";
}

export function normalizeExpiresAt(expiresIn: number | undefined): number {
  // Zoho normally returns seconds (3600). Guard against millisecond values.
  const raw = expiresIn ?? 3600;
  const ms = raw > 86400 ? raw : raw * 1000;
  return Date.now() + ms;
}
