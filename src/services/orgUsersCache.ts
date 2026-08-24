import { OrgUserSummary } from "../types/zoho.types";
import { getOrganizationAccounts } from "./zohoOrganization.service";

const TTL_MS = 10 * 60 * 1000;

let cache: { fetchedAt: number; users: OrgUserSummary[] } | null = null;
let inflight: Promise<OrgUserSummary[]> | null = null;

export async function getCachedOrganizationAccounts(options?: {
  force?: boolean;
}): Promise<{
  users: OrgUserSummary[];
  cached: boolean;
  fetchedAt: string;
  expiresAt: string;
}> {
  const force = options?.force === true;
  const now = Date.now();

  if (!force && cache && now - cache.fetchedAt < TTL_MS) {
    return {
      users: cache.users,
      cached: true,
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
      expiresAt: new Date(cache.fetchedAt + TTL_MS).toISOString(),
    };
  }

  if (!force && inflight) {
    const users = await inflight;
    return {
      users,
      cached: true,
      fetchedAt: new Date(cache?.fetchedAt || now).toISOString(),
      expiresAt: new Date((cache?.fetchedAt || now) + TTL_MS).toISOString(),
    };
  }

  inflight = getOrganizationAccounts()
    .then((users) => {
      cache = { fetchedAt: Date.now(), users };
      return users;
    })
    .finally(() => {
      inflight = null;
    });

  const users = await inflight;
  return {
    users,
    cached: false,
    fetchedAt: new Date(cache!.fetchedAt).toISOString(),
    expiresAt: new Date(cache!.fetchedAt + TTL_MS).toISOString(),
  };
}

export function clearOrganizationAccountsCache(): void {
  cache = null;
}
