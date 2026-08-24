import { env } from "../config/env";
import { ZohoApiError } from "../errors/zohoError";
import { mapWithConcurrency } from "../utils/concurrency";
import { logger } from "../utils/logger";
import { mailboxStore } from "../store/mailboxStore";
import {
  getValidMailboxAccessToken,
  listConnectedMailboxes,
} from "./zohoMailboxAuth.service";
import {
  findInboxFolder,
  getAttachmentInfo,
  getMessageContent,
  listMessages,
} from "./zohoMail.service";
import {
  findUserByEmail,
  getAllOrganizationUsers,
} from "./zohoOrganization.service";

export async function testOneUser(email: string): Promise<Record<string, unknown>> {
  const user = await findUserByEmail(email);
  if (!user) {
    return {
      status: "failed",
      email,
      error: "User not found in organization accounts list",
      capability: {
        organizationUserAccountAccess: "NO",
        organizationMailboxMessageAccess: "UNTESTED",
        attachmentAccess: "UNTESTED",
      },
    };
  }

  const connected = await mailboxStore.get(user.email);
  const result: Record<string, unknown> = {
    status: "success",
    email: user.email,
    zuid: user.zuid,
    accountId: user.accountId,
    mailboxConnected: Boolean(connected),
    steps: {} as Record<string, unknown>,
    capability: {
      organizationUserAccountAccess: "YES",
      organizationMailboxMessageAccess: "UNTESTED",
      attachmentAccess: "UNTESTED",
    },
  };

  const steps = result.steps as Record<string, unknown>;
  const capability = result.capability as Record<string, string>;

  if (!connected) {
    result.status = "failed";
    steps.error =
      "Zoho does not allow an admin token to open another user's mailbox via Mail APIs.";
    steps.fix =
      "Connect this mailbox: generate a Self Client code while logged into Zoho AS THAT USER, then POST /api/zoho/mailboxes/connect { code }.";
    steps.connectExample = {
      method: "POST",
      url: "/api/zoho/mailboxes/connect",
      body: { code: "PASTE_SELF_CLIENT_CODE_FOR_THIS_USER" },
    };
    capability.organizationMailboxMessageAccess = "NO";
    return result;
  }

  try {
    const mailboxAuth = await getValidMailboxAccessToken(user.email);
    const accountId = mailboxAuth.accountId || user.accountId;
    result.accountId = accountId;

    const inbox = await findInboxFolder(accountId, user.email);
    steps.inbox = inbox;
    if (!inbox) {
      result.status = "partial";
      steps.foldersError = "Inbox folder not found";
      return result;
    }

    const messages = await listMessages(accountId, {
      folderId: inbox.folderId,
      limit: 20,
      start: 1,
      mailboxEmail: user.email,
    });
    steps.emailCount = messages.length;
    steps.messages = messages;
    capability.organizationMailboxMessageAccess = "YES";

    const firstWithAttachment =
      messages.find((m) => m.hasAttachment) || messages[0];
    if (!firstWithAttachment) {
      steps.messageContent = null;
      steps.note = "No messages in Inbox to inspect content/attachments";
      return result;
    }

    const folderId = firstWithAttachment.folderId || inbox.folderId;
    const content = await getMessageContent(
      accountId,
      folderId,
      firstWithAttachment.messageId,
      user.email
    );
    steps.selectedMessageId = firstWithAttachment.messageId;
    steps.messageContent = {
      messageId: content.messageId,
      subject: content.subject,
      from: content.from,
      to: content.to,
      hasHtml: Boolean(content.htmlContent),
      hasText: Boolean(content.textContent),
      attachmentCount: content.attachments.length,
    };

    const attachments = await getAttachmentInfo(
      accountId,
      folderId,
      firstWithAttachment.messageId,
      user.email
    );
    steps.attachments = attachments;
    capability.attachmentAccess = attachments.length > 0 ? "YES" : "UNTESTED";

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.status = "failed";
    steps.error = message;
    if (error instanceof ZohoApiError) {
      steps.httpStatus = error.httpStatus;
      steps.zohoCode = error.zohoCode;
      steps.endpoint = error.endpoint;
    }
    capability.organizationMailboxMessageAccess = "NO";
    logger.error("testOneUser failed", {
      email: user.email,
      accountId: user.accountId,
      error: message,
    });
    return result;
  }
}

export async function testAllUsers(limitPerUser = 5): Promise<{
  users: Array<Record<string, unknown>>;
  summary: {
    totalOrgUsers: number;
    connectedMailboxes: number;
    tested: number;
    success: number;
    failed: number;
    skippedNotConnected: number;
    concurrency: number;
  };
  capability: {
    organizationUserAccountAccess: "YES" | "NO" | "UNTESTED";
    organizationMailboxMessageAccess: "YES" | "NO" | "UNTESTED";
    attachmentAccess: "YES" | "NO" | "UNTESTED";
  };
  note: string;
}> {
  const orgUsers = await getAllOrganizationUsers();
  const connected = await listConnectedMailboxes();
  const connectedSet = new Set(connected.map((c) => c.email.toLowerCase()));
  const concurrency = env.zohoConcurrency;

  const toTest = orgUsers.filter((u) => connectedSet.has(u.email.toLowerCase()));
  const skipped = orgUsers.length - toTest.length;

  const results = await mapWithConcurrency(toTest, concurrency, async (user) => {
    try {
      const auth = await getValidMailboxAccessToken(user.email);
      const accountId = auth.accountId || user.accountId;
      const inbox = await findInboxFolder(accountId, user.email);
      if (!inbox) {
        return {
          email: user.email,
          accountId,
          emailCount: 0,
          status: "failed",
          error: "Inbox not found",
        };
      }

      const messages = await listMessages(accountId, {
        folderId: inbox.folderId,
        limit: Math.min(limitPerUser, 20),
        start: 1,
        mailboxEmail: user.email,
      });

      return {
        email: user.email,
        accountId,
        emailCount: messages.length,
        status: "success",
      };
    } catch (error) {
      return {
        email: user.email,
        accountId: user.accountId,
        emailCount: 0,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        httpStatus: error instanceof ZohoApiError ? error.httpStatus : undefined,
      };
    }
  });

  const success = results.filter((r) => r.status === "success").length;
  const failed = results.length - success;

  return {
    users: results,
    summary: {
      totalOrgUsers: orgUsers.length,
      connectedMailboxes: connected.length,
      tested: results.length,
      success,
      failed,
      skippedNotConnected: skipped,
      concurrency,
    },
    capability: {
      organizationUserAccountAccess: orgUsers.length > 0 ? "YES" : "NO",
      organizationMailboxMessageAccess: success > 0 ? "YES" : "NO",
      attachmentAccess: "UNTESTED",
    },
    note: "Zoho Mail APIs cannot read other users' messages with a single admin token. Each mailbox must be connected with its own OAuth refresh token.",
  };
}
