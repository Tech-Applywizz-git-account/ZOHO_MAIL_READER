import { env } from "../config/env";
import { ZohoApiError } from "../errors/zohoError";
import { tokenStore } from "../store/tokenStore";
import { OrgUserSummary } from "../types/zoho.types";
import { zohoMailRequest } from "./zohoClient";
import { logger } from "../utils/logger";

type ZohoEnvelope<T> = {
  status?: { code?: number; description?: string };
  data?: T;
};

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function pickEmail(raw: Record<string, unknown>): string {
  if (typeof raw.primaryEmailAddress === "string") {
    return raw.primaryEmailAddress;
  }
  if (typeof raw.mailboxAddress === "string") {
    return raw.mailboxAddress;
  }
  if (typeof raw.incomingUserName === "string") {
    return raw.incomingUserName;
  }
  const emails = asArray(raw.emailAddress as Record<string, unknown>[] | undefined);
  const primary = emails.find((e) => e.isPrimary) || emails[0];
  if (primary && typeof primary.mailId === "string") {
    return primary.mailId;
  }
  return "";
}

function mapUser(raw: Record<string, unknown>): OrgUserSummary {
  return {
    email: pickEmail(raw),
    zuid: String(raw.zuid ?? ""),
    accountId: String(raw.accountId ?? ""),
    displayName:
      typeof raw.displayName === "string"
        ? raw.displayName
        : typeof raw.accountDisplayName === "string"
          ? raw.accountDisplayName
          : undefined,
    role: typeof raw.role === "string" ? raw.role : undefined,
    mailboxStatus:
      typeof raw.mailboxStatus === "string" ? raw.mailboxStatus : undefined,
  };
}

function zoidMissingError(): Error {
  return new Error(
    "ZOHO_ZOID is required. Official GET /api/organization needs ZohoMail.partner.organization.READ (partner API), which regular org admins usually do not have. Set ZOHO_ZOID from Zoho Mail Admin Console → Organization → Profile → Organization ID (India DC: https://mailadmin.zoho.in), then restart the server."
  );
}

export async function resolveZoid(): Promise<string> {
  const stored = tokenStore.get()?.zoid || env.zohoZoid;
  if (stored) {
    const zoid = String(stored);
    await tokenStore.setZoid(zoid);
    return zoid;
  }

  // Partner-only path (documented). Expected to fail for normal org admins.
  try {
    const response = await zohoMailRequest<
      ZohoEnvelope<Record<string, unknown>>
    >({
      path: "/api/organization",
      context: { action: "resolveZoid" },
      retries: 0,
    });
    const zoid = response.data?.zoid;
    if (zoid) {
      await tokenStore.setZoid(String(zoid));
      logger.info("Resolved and stored zoid", { zoid: String(zoid) });
      return String(zoid);
    }
  } catch (error) {
    if (error instanceof ZohoApiError) {
      logger.warn("Could not auto-resolve zoid via GET /api/organization", {
        httpStatus: error.httpStatus,
        endpoint: error.endpoint,
      });
    }
  }

  throw zoidMissingError();
}

export async function getOrganizationDetails(): Promise<{
  zoid: string;
  orgName?: string;
  primaryDomainName?: string;
  usersCount?: number;
  mailboxCount?: number;
  planType?: string;
  superAdmin?: string;
  domains?: string[];
  source: "partner_api" | "zoid_plus_accounts";
  note?: string;
}> {
  const zoid = await resolveZoid();

  // Official org-details API is partner-scoped. Try it, then fall back.
  try {
    const response = await zohoMailRequest<
      ZohoEnvelope<Record<string, unknown>>
    >({
      path: `/api/organization/${zoid}`,
      context: { action: "getOrganization", zoid },
      retries: 0,
    });
    const data = response.data || {};
    return {
      zoid: String(data.zoid || zoid),
      orgName: typeof data.orgName === "string" ? data.orgName : undefined,
      primaryDomainName:
        typeof data.primaryDomainName === "string"
          ? data.primaryDomainName
          : undefined,
      usersCount:
        typeof data.usersCount === "number" ? data.usersCount : undefined,
      mailboxCount:
        typeof data.mailboxCount === "number" ? data.mailboxCount : undefined,
      planType: typeof data.planType === "string" ? data.planType : undefined,
      superAdmin:
        typeof data.superAdmin === "string" ? data.superAdmin : undefined,
      domains: Array.isArray(data.domains)
        ? data.domains.filter((d): d is string => typeof d === "string")
        : undefined,
      source: "partner_api",
    };
  } catch (error) {
    logger.warn(
      "Partner organization details API unavailable; using accounts summary",
      {
        zoid,
        httpStatus: error instanceof ZohoApiError ? error.httpStatus : undefined,
      }
    );
  }

  const accounts = await getOrganizationUsers({ start: 0, limit: 200 });
  const domains = Array.from(
    new Set(
      accounts
        .map((a) => a.email.split("@")[1]?.toLowerCase())
        .filter((d): d is string => Boolean(d))
    )
  );

  return {
    zoid,
    usersCount: accounts.length,
    mailboxCount: accounts.filter((a) => a.accountId).length,
    primaryDomainName: domains[0],
    domains,
    source: "zoid_plus_accounts",
    note: "GET /api/organization/{zoid} requires partner.organization scope. Returning summary from organization.accounts instead.",
  };
}

export async function getOrganizationUsers(options?: {
  start?: number;
  limit?: number;
}): Promise<OrgUserSummary[]> {
  const zoid = await resolveZoid();
  const start = options?.start ?? 0;
  const limit = Math.min(options?.limit ?? 100, 200);

  // Official: GET /api/organization/{zoid}/accounts
  // Scope: ZohoMail.organization.accounts.READ
  // https://www.zoho.com/mail/help/api/get-org-users-details.html
  const response = await zohoMailRequest<
    ZohoEnvelope<Record<string, unknown> | Record<string, unknown>[]>
  >({
    path: `/api/organization/${zoid}/accounts`,
    params: { start, limit },
    context: { action: "getOrganizationUsers", zoid, start, limit },
  });

  const rows = asArray(response.data);
  return rows.map((row) => mapUser(row));
}

export async function getAllOrganizationUsers(): Promise<OrgUserSummary[]> {
  const all: OrgUserSummary[] = [];
  let start = 0;
  // Zoho allows up to 200 per page — fewer round-trips for large orgs.
  const limit = 200;

  for (;;) {
    const page = await getOrganizationUsers({ start, limit });
    all.push(...page);
    if (page.length < limit) {
      break;
    }
    start += limit;
  }

  return all;
}

export async function getOrganizationAccounts(): Promise<OrgUserSummary[]> {
  return getAllOrganizationUsers();
}

export async function findUserByEmail(email: string): Promise<OrgUserSummary | null> {
  const target = email.trim().toLowerCase();
  const users = await getAllOrganizationUsers();
  return (
    users.find((u) => u.email.toLowerCase() === target) ||
    users.find((u) => u.email.toLowerCase().includes(target)) ||
    null
  );
}
