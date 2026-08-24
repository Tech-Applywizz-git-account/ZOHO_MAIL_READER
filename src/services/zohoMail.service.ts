import fs from "fs";
import path from "path";
import { AttachmentSummary, FolderSummary, MessageSummary } from "../types/zoho.types";
import { ensureSafeDownloadPath } from "../utils/sanitize";
import { getValidMailboxAccessToken } from "./zohoMailboxAuth.service";
import { zohoMailRequest } from "./zohoClient";

type ZohoEnvelope<T> = {
  status?: { code?: number; description?: string };
  data?: T;
};

type MailAuth = {
  accessToken?: string;
  mailApiDomain?: string;
  onUnauthorized?: () => Promise<string>;
};

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function truthyAttachment(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value > 0;
  }
  if (typeof value === "string") {
    return value !== "0" && value.toLowerCase() !== "false" && value !== "";
  }
  return false;
}

async function resolveMailAuth(mailboxEmail?: string): Promise<MailAuth> {
  if (!mailboxEmail) {
    return {};
  }
  const mailbox = await getValidMailboxAccessToken(mailboxEmail);
  return {
    accessToken: mailbox.accessToken,
    mailApiDomain: mailbox.mailApiDomain,
    onUnauthorized: async () => {
      const refreshed = await getValidMailboxAccessToken(mailboxEmail);
      return refreshed.accessToken;
    },
  };
}

export async function getFolders(
  accountId: string,
  mailboxEmail?: string
): Promise<FolderSummary[]> {
  const auth = await resolveMailAuth(mailboxEmail);
  const response = await zohoMailRequest<
    ZohoEnvelope<Record<string, unknown>[]>
  >({
    path: `/api/accounts/${accountId}/folders`,
    context: { action: "getFolders", accountId, mailboxEmail },
    ...auth,
  });

  return asArray(response.data).map((folder) => ({
    folderId: String(folder.folderId ?? ""),
    folderName: String(folder.folderName ?? ""),
    folderType:
      typeof folder.folderType === "string" ? folder.folderType : undefined,
    path: typeof folder.path === "string" ? folder.path : undefined,
  }));
}

export async function findInboxFolder(
  accountId: string,
  mailboxEmail?: string
): Promise<FolderSummary | null> {
  const folders = await getFolders(accountId, mailboxEmail);
  return (
    folders.find((f) => f.folderType?.toLowerCase() === "inbox") ||
    folders.find((f) => f.folderName.toLowerCase() === "inbox") ||
    folders.find((f) => f.path?.toLowerCase() === "/inbox") ||
    null
  );
}

export async function listMessages(
  accountId: string,
  options?: {
    folderId?: string;
    limit?: number;
    start?: number;
    search?: string;
    mailboxEmail?: string;
  }
): Promise<MessageSummary[]> {
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 200);
  const start = options?.start ?? 1;
  const auth = await resolveMailAuth(options?.mailboxEmail);

  if (options?.search) {
    const response = await zohoMailRequest<
      ZohoEnvelope<Record<string, unknown>[]>
    >({
      path: `/api/accounts/${accountId}/messages/search`,
      params: {
        searchKey: options.search,
        limit,
        start,
      },
      context: {
        action: "searchMessages",
        accountId,
        mailboxEmail: options.mailboxEmail,
      },
      ...auth,
    });
    return asArray(response.data).map(mapMessage);
  }

  const params: Record<string, unknown> = {
    limit,
    start,
    includeto: true,
  };
  if (options?.folderId) {
    params.folderId = options.folderId;
  }

  const response = await zohoMailRequest<
    ZohoEnvelope<Record<string, unknown>[]>
  >({
    path: `/api/accounts/${accountId}/messages/view`,
    params,
    context: {
      action: "listMessages",
      accountId,
      folderId: options?.folderId,
      mailboxEmail: options?.mailboxEmail,
    },
    ...auth,
  });

  return asArray(response.data).map(mapMessage);
}

function mapMessage(raw: Record<string, unknown>): MessageSummary {
  return {
    messageId: String(raw.messageId ?? ""),
    subject: String(raw.subject ?? ""),
    from: String(raw.fromAddress ?? raw.sender ?? ""),
    to: String(raw.toAddress ?? ""),
    cc: String(raw.ccAddress ?? ""),
    receivedTime: String(raw.receivedTime ?? raw.sentDateInGMT ?? ""),
    hasAttachment: truthyAttachment(raw.hasAttachment),
    folderId: raw.folderId !== undefined ? String(raw.folderId) : undefined,
  };
}

export async function getMessageDetails(
  accountId: string,
  folderId: string,
  messageId: string,
  mailboxEmail?: string
): Promise<Record<string, unknown>> {
  const auth = await resolveMailAuth(mailboxEmail);
  const response = await zohoMailRequest<
    ZohoEnvelope<Record<string, unknown>>
  >({
    path: `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/details`,
    context: {
      action: "getMessageDetails",
      accountId,
      folderId,
      messageId,
      mailboxEmail,
    },
    ...auth,
  });
  return response.data || {};
}

export async function getMessageContent(
  accountId: string,
  folderId: string,
  messageId: string,
  mailboxEmail?: string
): Promise<{
  messageId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  receivedTime: string;
  textContent: string;
  htmlContent: string;
  attachments: AttachmentSummary[];
}> {
  const [contentResponse, detailsRaw, attachments] = await Promise.all([
    (async () => {
      const auth = await resolveMailAuth(mailboxEmail);
      return zohoMailRequest<ZohoEnvelope<Record<string, unknown>>>({
        path: `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`,
        context: {
          action: "getMessageContent",
          accountId,
          folderId,
          messageId,
          mailboxEmail,
        },
        ...auth,
      });
    })(),
    getMessageDetails(accountId, folderId, messageId, mailboxEmail).catch(
      (): Record<string, unknown> => ({})
    ),
    getAttachmentInfo(accountId, folderId, messageId, mailboxEmail).catch(
      () => []
    ),
  ]);

  const contentData = contentResponse.data || {};
  const details = detailsRaw;
  const htmlContent = String(
    contentData.content ?? contentData.htmlContent ?? ""
  );
  const textContent = String(
    contentData.textContent ?? contentData.plainText ?? ""
  );

  return {
    messageId: String(contentData.messageId ?? messageId),
    subject: String(details.subject ?? ""),
    from: String(details.fromAddress ?? details.from ?? ""),
    to: String(details.toAddress ?? details.to ?? ""),
    cc: String(details.ccAddress ?? details.cc ?? ""),
    bcc: String(details.bccAddress ?? details.bcc ?? ""),
    receivedTime: String(details.receivedTime ?? details.sentDateInGMT ?? ""),
    textContent,
    htmlContent,
    attachments,
  };
}

export async function getAttachmentInfo(
  accountId: string,
  folderId: string,
  messageId: string,
  mailboxEmail?: string
): Promise<AttachmentSummary[]> {
  const auth = await resolveMailAuth(mailboxEmail);
  const response = await zohoMailRequest<
    ZohoEnvelope<{
      attachments?: Record<string, unknown>[];
      messageId?: string;
    }>
  >({
    path: `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo`,
    context: {
      action: "getAttachmentInfo",
      accountId,
      folderId,
      messageId,
      mailboxEmail,
    },
    ...auth,
  });

  const attachments = asArray(response.data?.attachments);
  return attachments.map((item) => ({
    attachmentId: String(item.attachmentId ?? ""),
    name: String(item.attachmentName ?? item.name ?? "attachment"),
    size: Number(item.attachmentSize ?? item.size ?? 0),
  }));
}

export async function downloadAttachment(params: {
  accountId: string;
  folderId: string;
  messageId: string;
  attachmentId: string;
  filename?: string;
  mailboxEmail?: string;
}): Promise<{ savedPath: string; filename: string; bytes: number }> {
  const auth = await resolveMailAuth(params.mailboxEmail);
  const binary = await zohoMailRequest<ArrayBuffer>({
    path: `/api/accounts/${params.accountId}/folders/${params.folderId}/messages/${params.messageId}/attachments/${params.attachmentId}`,
    responseType: "arraybuffer",
    context: {
      action: "downloadAttachment",
      accountId: params.accountId,
      messageId: params.messageId,
      attachmentId: params.attachmentId,
      mailboxEmail: params.mailboxEmail,
    },
    ...auth,
  });

  const downloadDir = path.resolve(process.cwd(), "downloads");
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  let filename = params.filename;
  if (!filename) {
    const meta = await getAttachmentInfo(
      params.accountId,
      params.folderId,
      params.messageId,
      params.mailboxEmail
    );
    filename =
      meta.find((a) => a.attachmentId === params.attachmentId)?.name ||
      `attachment-${params.attachmentId}`;
  }

  const savedPath = ensureSafeDownloadPath(downloadDir, filename);
  const buffer = Buffer.from(binary);
  fs.writeFileSync(savedPath, buffer);

  return {
    savedPath,
    filename: path.basename(savedPath),
    bytes: buffer.length,
  };
}
