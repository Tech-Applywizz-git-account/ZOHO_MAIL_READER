import { mailboxStore } from "../store/mailboxStore";
import { logger } from "../utils/logger";
import {
  findInboxFolder,
  getMessageContent,
  listMessages,
} from "./zohoMail.service";

export type GreenhouseSecurityCodeResult = {
  found: boolean;
  email: string;
  reason?: string;
  code?: string;
  subject?: string;
  from?: string;
  receivedTime?: string;
  companyMatched?: boolean;
};

const SUBJECT_HINT = "security code for your application";
const FROM_HINTS = ["greenhouse-mail.io", "greenhouse.io"];

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r/g, "");
}

export function extractGreenhouseSecurityCode(raw: string): string | null {
  const text = stripHtml(raw || "").replace(/[ \t]+/g, " ").trim();
  const labeled = text.match(
    /copy and paste this code into the security code field[^\n]*\n+\s*([A-Za-z0-9]{6,16})/i
  );
  if (labeled?.[1]) {
    return labeled[1];
  }
  const beforeResubmit = text.match(
    /on your application:\s*([A-Za-z0-9]{6,16})\s+After you enter/i
  );
  if (beforeResubmit?.[1]) {
    return beforeResubmit[1];
  }
  const colon = text.match(
    /security code field on your application:\s*([A-Za-z0-9]{6,16})/i
  );
  if (colon?.[1]) {
    return colon[1];
  }
  return null;
}

function parseReceivedMs(value: string | number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return n < 1e12 ? n * 1000 : n;
}

function isGreenhouseSecurityMail(from: string, subject: string): boolean {
  const fromLower = (from || "").toLowerCase();
  const subjectLower = (subject || "").toLowerCase();
  const fromOk = FROM_HINTS.some((hint) => fromLower.includes(hint));
  return fromOk && subjectLower.includes(SUBJECT_HINT);
}

function companyMatches(subject: string, company?: string): boolean {
  const wanted = (company || "").trim().toLowerCase();
  if (!wanted) {
    return false;
  }
  const subjectLower = (subject || "").toLowerCase();
  if (subjectLower.includes(`to ${wanted}`)) {
    return true;
  }
  const tokens = wanted.split(/\s+/).filter((t) => t.length >= 3);
  if (!tokens.length) {
    return subjectLower.includes(wanted);
  }
  return tokens.every((t) => subjectLower.includes(t));
}

export async function findGreenhouseSecurityCode(params: {
  email: string;
  company?: string;
  receivedAfterMs?: number;
}): Promise<GreenhouseSecurityCodeResult> {
  const email = mailboxStore.normalizeEmail(params.email);
  if (!email.includes("@")) {
    return { found: false, email, reason: "invalid_email" };
  }

  const mailbox = await mailboxStore.get(email);
  if (!mailbox?.accountId) {
    return { found: false, email, reason: "mailbox_not_connected" };
  }

  const receivedAfterMs =
    params.receivedAfterMs && params.receivedAfterMs > 0
      ? params.receivedAfterMs
      : Date.now() - 15 * 60 * 1000;

  const inbox = await findInboxFolder(mailbox.accountId, email);
  let listed = await listMessages(mailbox.accountId, {
    search: "Security code for your application",
    limit: 30,
    start: 1,
    mailboxEmail: email,
  }).catch(() => []);

  if (!listed.length) {
    listed = await listMessages(mailbox.accountId, {
      folderId: inbox?.folderId,
      limit: 40,
      start: 1,
      mailboxEmail: email,
    });
  }

  const candidates = listed.filter((msg) => {
    if (!isGreenhouseSecurityMail(msg.from, msg.subject)) {
      return false;
    }
    const received = parseReceivedMs(msg.receivedTime);
    return !received || received >= receivedAfterMs;
  });

  type Parsed = {
    code: string;
    subject: string;
    from: string;
    receivedTime: string;
    receivedMs: number;
    companyMatched: boolean;
  };
  const parsed: Parsed[] = [];

  for (const msg of candidates) {
    const folderId = msg.folderId || inbox?.folderId;
    if (!folderId || !msg.messageId) {
      continue;
    }
    try {
      const content = await getMessageContent(
        mailbox.accountId,
        folderId,
        msg.messageId,
        email
      );
      const body = `${content.textContent}\n${content.htmlContent}`;
      const code = extractGreenhouseSecurityCode(body);
      if (!code) {
        continue;
      }
      const subject = content.subject || msg.subject;
      parsed.push({
        code,
        subject,
        from: content.from || msg.from,
        receivedTime: content.receivedTime || msg.receivedTime,
        receivedMs: parseReceivedMs(content.receivedTime || msg.receivedTime),
        companyMatched: companyMatches(subject, params.company),
      });
    } catch (error) {
      logger.warn("Failed to read Greenhouse security-code mail", {
        email,
        messageId: msg.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  parsed.sort((a, b) => b.receivedMs - a.receivedMs);
  const preferred =
    params.company?.trim() && parsed.some((p) => p.companyMatched)
      ? parsed.find((p) => p.companyMatched)
      : parsed[0];

  if (!preferred) {
    return { found: false, email, reason: "not_yet" };
  }

  return {
    found: true,
    email,
    code: preferred.code,
    subject: preferred.subject,
    from: preferred.from,
    receivedTime: preferred.receivedTime,
    companyMatched: preferred.companyMatched,
  };
}
