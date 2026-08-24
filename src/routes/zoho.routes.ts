import { Router } from "express";
import { env } from "../config/env";
import { asyncHandler } from "../middleware/errorHandler";
import {
  clearStoredTokens,
  exchangeAuthorizationCode,
  getAuthorizationUrl,
  getTokenStatus,
  getValidAccessToken,
  refreshAccessToken,
} from "../services/zohoAuth.service";
import { zohoMailRequest } from "../services/zohoClient";
import { tokenStore } from "../store/tokenStore";
import { mailboxStore } from "../store/mailboxStore";
import {
  connectMailboxWithCode,
  listConnectedMailboxes,
} from "../services/zohoMailboxAuth.service";
import {
  downloadAttachment,
  findInboxFolder,
  getAttachmentInfo,
  getFolders,
  getMessageContent,
  listMessages,
} from "../services/zohoMail.service";
import {
  getOrganizationAccounts,
  getOrganizationDetails,
  getOrganizationUsers,
} from "../services/zohoOrganization.service";
import { getCachedOrganizationAccounts } from "../services/orgUsersCache";
import { testAllUsers, testOneUser } from "../services/zohoTest.service";
import { logger } from "../utils/logger";

const router = Router();

async function syncCurrentTokenAsMailbox(): Promise<{
  email: string;
  accountId: string;
} | null> {
  const current = tokenStore.get();
  if (!current?.accessToken) {
    return null;
  }

  const response = await zohoMailRequest<{
    data?: Record<string, unknown> | Record<string, unknown>[];
  }>({
    path: "/api/accounts",
    accessToken: current.accessToken,
    mailApiDomain: current.mailApiDomain,
    retries: 0,
    context: { action: "syncAdminMailbox" },
  });

  const rows = Array.isArray(response.data)
    ? response.data
    : response.data
      ? [response.data]
      : [];
  const primary =
    rows.find((r) => r.isDefaultAccount === true) ||
    rows.find((r) => r.type === "ZOHO_ACCOUNT") ||
    rows[0];
  if (!primary) {
    return null;
  }

  const email = String(
    primary.primaryEmailAddress ||
      primary.mailboxAddress ||
      primary.incomingUserName ||
      ""
  );
  const accountId = String(primary.accountId || "");
  if (!email || !accountId) {
    return null;
  }

  await mailboxStore.save({
    email,
    accountId,
    accessToken: current.accessToken,
    refreshToken: current.refreshToken,
    apiDomain: current.apiDomain,
    mailApiDomain: current.mailApiDomain,
    accountsUrl: current.accountsUrl,
    expiresAt: current.expiresAt,
    scope: current.scope,
    tokenType: current.tokenType,
    updatedAt: new Date().toISOString(),
  });

  return { email, accountId };
}

router.get(
  "/authorize",
  asyncHandler(async (req, res) => {
    const modeParam =
      typeof req.query.mode === "string" ? req.query.mode.toLowerCase() : "";
    const mode =
      modeParam === "org" || modeParam === "server"
        ? modeParam
        : env.zohoOauthMode;
    const url = getAuthorizationUrl(mode);
    logger.info("Redirecting to Zoho authorization", { mode });
    res.redirect(url);
  })
);

router.get(
  "/mailboxes/authorize",
  asyncHandler(async (req, res) => {
    const email =
      typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@")) {
      res.status(400).json({
        error: "Query parameter email is required",
        example: "/api/zoho/mailboxes/authorize?email=user@applywizard.ai",
      });
      return;
    }

    const state = `mailbox_connect:${email}`;
    const url = getAuthorizationUrl("server", state);
    logger.info("Redirecting to Zoho mailbox connect", { email });
    res.redirect(url);
  })
);

router.post(
  "/logout",
  asyncHandler(async (_req, res) => {
    await clearStoredTokens();
    res.json({ message: "Stored tokens cleared. Re-authorize next." });
  })
);

router.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const error = typeof req.query.error === "string" ? req.query.error : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const accountsServer =
      typeof req.query["accounts-server"] === "string"
        ? req.query["accounts-server"]
        : typeof req.query.accounts_server === "string"
          ? req.query.accounts_server
          : undefined;
    const location =
      typeof req.query.location === "string" ? req.query.location : undefined;

    if (error) {
      res.status(400).send(`<h1>OAuth denied</h1><p>${error}</p>`);
      return;
    }

    if (!code) {
      res.status(400).json({
        error: "Missing authorization code",
        hint: "Open /api/zoho/authorize and complete admin consent.",
      });
      return;
    }

    const mailboxPrefix = "mailbox_connect:";
    if (state.startsWith(mailboxPrefix)) {
      const expectedEmail = state.slice(mailboxPrefix.length);
      const mailbox = await connectMailboxWithCode(
        code,
        accountsServer || env.zohoAccountsUrl,
        expectedEmail,
        { mode: "oauth" }
      );
      res.redirect(
        `/?connected=${encodeURIComponent(mailbox.email)}&ok=1`
      );
      return;
    }

    await exchangeAuthorizationCode(code, accountsServer);
    const status = getTokenStatus();

    res.status(200).send(`<!doctype html>
<html>
<head><title>Zoho OAuth Success</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;padding:2rem;">
  <h1>Authorization successful (${status.oauthMode})</h1>
  <p>Tokens stored locally (secrets not shown).</p>
  <ul>
    <li>mode: ${status.oauthMode}</li>
    <li>hasAccessToken: ${status.hasAccessToken}</li>
    <li>hasRefreshToken: ${status.hasRefreshToken}</li>
    <li>scope: ${status.scope || "n/a"}</li>
    <li>mailApiDomain: ${status.mailApiDomain || "n/a"}</li>
    <li>zoid: ${status.zoid || "n/a"}</li>
    <li>location: ${location || "n/a"}</li>
  </ul>
  <p><a href="/">Open Mail Connector UI</a> ·
     <a href="/api/zoho/accounts">List accounts</a></p>
</body>
</html>`);
  })
);

router.post(
  "/exchange-code",
  asyncHandler(async (req, res) => {
    const code =
      typeof req.body?.code === "string"
        ? req.body.code.trim()
        : typeof req.query.code === "string"
          ? req.query.code.trim()
          : "";
    if (!code) {
      res.status(400).json({
        error: "code is required",
        hint: "Create a Self Client in Zoho API Console, generate a code with the configured scopes, then POST { code } here.",
      });
      return;
    }
    await clearStoredTokens();
    await exchangeAuthorizationCode(code, env.zohoAccountsUrl);
    const connected = await syncCurrentTokenAsMailbox();
    res.json({
      message: "Code exchanged and tokens stored",
      oauth: getTokenStatus(),
      connectedMailbox: connected,
      next: [
        "/api/zoho/accounts",
        "/api/zoho/mailboxes",
        connected
          ? `/api/zoho/test-user?email=${encodeURIComponent(connected.email)}`
          : "/api/zoho/mailboxes/connect",
      ],
    });
  })
);

router.get(
  "/mailboxes",
  asyncHandler(async (_req, res) => {
    const connected = await listConnectedMailboxes();
    res.json({
      connectedCount: connected.length,
      mailboxes: connected,
      note: "Zoho Mail APIs require each mailbox owner's OAuth token to read that mailbox's messages. Admin token alone can list users but cannot open other accountIds.",
      howToConnect: [
        "1. Log into Zoho as the target user (or ask them to)",
        "2. API Console → Self Client → Generate Code with ZOHO_SCOPES",
        "3. POST /api/zoho/mailboxes/connect { \"code\": \"...\" }",
      ],
    });
  })
);

router.post(
  "/mailboxes/connect",
  asyncHandler(async (req, res) => {
    const code =
      typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const expectedEmail =
      typeof req.body?.expectedEmail === "string"
        ? req.body.expectedEmail.trim()
        : typeof req.body?.email === "string"
          ? req.body.email.trim()
          : undefined;
    if (!code) {
      res.status(400).json({
        error: "code is required",
        hint: "Generate a Self Client code while logged in as the mailbox owner, then POST { code }.",
      });
      return;
    }

    const mailbox = await connectMailboxWithCode(
      code,
      env.zohoAccountsUrl,
      expectedEmail,
      { mode: "self" }
    );
    res.json({
      message: "Mailbox connected",
      mailbox: {
        email: mailbox.email,
        accountId: mailbox.accountId,
        updatedAt: mailbox.updatedAt,
      },
      next: `/api/zoho/test-user?email=${encodeURIComponent(mailbox.email)}`,
    });
  })
);

router.get(
  "/ui/users",
  asyncHandler(async (req, res) => {
    const force = req.query.refresh === "1" || req.query.refresh === "true";
    const [accountsResult, connected] = await Promise.all([
      getCachedOrganizationAccounts({ force }),
      listConnectedMailboxes(),
    ]);
    const byEmail = new Map(
      connected.map((m) => [m.email.toLowerCase(), m] as const)
    );

    const users = accountsResult.users
      .filter((a) => a.email)
      .map((a) => {
        const link = byEmail.get(a.email.toLowerCase());
        return {
          email: a.email,
          zuid: a.zuid,
          accountId: a.accountId,
          displayName: a.displayName || null,
          connected: Boolean(link),
          status: link?.status || "not_connected",
          connectedAt: link?.updatedAt || null,
        };
      })
      .sort((a, b) => {
        if (a.connected !== b.connected) {
          return a.connected ? -1 : 1;
        }
        return a.email.localeCompare(b.email);
      });

    res.json({
      total: users.length,
      connectedCount: users.filter((u) => u.connected).length,
      scopes: env.zohoScopes,
      consoleUrl: "https://api-console.zoho.in/",
      cached: accountsResult.cached,
      fetchedAt: accountsResult.fetchedAt,
      cacheExpiresAt: accountsResult.expiresAt,
      users,
    });
  })
);

router.get(
  "/ui/inbox",
  asyncHandler(async (req, res) => {
    const email =
      typeof req.query.email === "string" ? req.query.email.trim() : "";
    if (!email) {
      res.status(400).json({ error: "Query parameter email is required" });
      return;
    }

    const connected = await mailboxStore.get(email);
    if (!connected) {
      res.status(400).json({
        error: "Mailbox not connected",
        hint: "Paste a Self Client code for this user first.",
      });
      return;
    }

    const accountId = connected.accountId;
    if (!accountId) {
      res.status(400).json({ error: "Connected mailbox has no accountId" });
      return;
    }

    const limit = req.query.limit ? Number(req.query.limit) : 30;
    const inbox = await findInboxFolder(accountId, email);
    if (!inbox) {
      res.status(404).json({ error: "Inbox folder not found" });
      return;
    }

    const messages = await listMessages(accountId, {
      folderId: inbox.folderId,
      limit,
      start: 1,
      mailboxEmail: email,
    });

    res.json({
      email,
      accountId,
      inbox,
      messages,
    });
  })
);

router.get(
  "/ui/message",
  asyncHandler(async (req, res) => {
    const email =
      typeof req.query.email === "string" ? req.query.email.trim() : "";
    const accountId =
      typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
    const folderId =
      typeof req.query.folderId === "string" ? req.query.folderId.trim() : "";
    const messageId =
      typeof req.query.messageId === "string" ? req.query.messageId.trim() : "";

    if (!email || !accountId || !folderId || !messageId) {
      res.status(400).json({
        error: "email, accountId, folderId, and messageId are required",
      });
      return;
    }

    const connected = await mailboxStore.get(email);
    if (!connected) {
      res.status(400).json({ error: "Mailbox not connected" });
      return;
    }

    const message = await getMessageContent(
      accountId,
      folderId,
      messageId,
      email
    );
    res.json({ message });
  })
);

router.post(
  "/mailboxes/sync-admin",
  asyncHandler(async (_req, res) => {
    await getValidAccessToken();
    const connected = await syncCurrentTokenAsMailbox();
    if (!connected) {
      res.status(400).json({
        error: "Could not sync admin mailbox from current token",
      });
      return;
    }
    res.json({ message: "Admin mailbox synced", mailbox: connected });
  })
);

router.get(
  "/token-status",
  asyncHandler(async (_req, res) => {
    res.json({
      oauth: getTokenStatus(),
      redirectUri: env.zohoRedirectUri,
      accountsUrl: env.zohoAccountsUrl,
      mailApiDomain: env.zohoApiDomain,
      zoidConfigured: env.zohoZoid || null,
      connectedMailboxes: (await listConnectedMailboxes()).length,
    });
  })
);

router.post(
  "/refresh",
  asyncHandler(async (_req, res) => {
    await refreshAccessToken();
    res.json({
      message: "Access token refreshed",
      oauth: getTokenStatus(),
    });
  })
);

router.get(
  "/refresh",
  asyncHandler(async (_req, res) => {
    await refreshAccessToken();
    res.json({
      message: "Access token refreshed",
      oauth: getTokenStatus(),
    });
  })
);

router.get(
  "/organization",
  asyncHandler(async (_req, res) => {
    const organization = await getOrganizationDetails();
    res.json({ organization });
  })
);

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const start = req.query.start ? Number(req.query.start) : 0;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const users = await getOrganizationUsers({ start, limit });
    res.json({
      users: users.map((u) => ({
        email: u.email,
        zuid: u.zuid,
      })),
    });
  })
);

router.get(
  "/accounts",
  asyncHandler(async (_req, res) => {
    const accounts = await getOrganizationAccounts();
    res.json({
      accounts: accounts.map((a) => ({
        email: a.email,
        zuid: a.zuid,
        accountId: a.accountId,
      })),
    });
  })
);

router.get(
  "/accounts/:accountId/folders",
  asyncHandler(async (req, res) => {
    const mailboxEmail =
      typeof req.query.mailboxEmail === "string"
        ? req.query.mailboxEmail
        : undefined;
    const folders = await getFolders(req.params.accountId, mailboxEmail);
    res.json({
      folders: folders.map((f) => ({
        folderId: f.folderId,
        folderName: f.folderName,
        folderType: f.folderType,
        path: f.path,
      })),
    });
  })
);

router.get(
  "/accounts/:accountId/messages",
  asyncHandler(async (req, res) => {
    const messages = await listMessages(req.params.accountId, {
      folderId:
        typeof req.query.folderId === "string" ? req.query.folderId : undefined,
      limit: req.query.limit ? Number(req.query.limit) : 20,
      start: req.query.start ? Number(req.query.start) : 1,
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      mailboxEmail:
        typeof req.query.mailboxEmail === "string"
          ? req.query.mailboxEmail
          : undefined,
    });
    res.json({ messages });
  })
);

router.get(
  "/accounts/:accountId/messages/:messageId",
  asyncHandler(async (req, res) => {
    const folderId =
      typeof req.query.folderId === "string" ? req.query.folderId : "";
    if (!folderId) {
      res.status(400).json({
        error: "folderId query parameter is required",
        hint: "Zoho message content APIs require folderId. Get it from list messages or folders.",
      });
      return;
    }

    const mailboxEmail =
      typeof req.query.mailboxEmail === "string"
        ? req.query.mailboxEmail
        : undefined;
    const message = await getMessageContent(
      req.params.accountId,
      folderId,
      req.params.messageId,
      mailboxEmail
    );
    res.json({ message });
  })
);

router.get(
  "/accounts/:accountId/messages/:messageId/attachments",
  asyncHandler(async (req, res) => {
    const folderId =
      typeof req.query.folderId === "string" ? req.query.folderId : "";
    if (!folderId) {
      res.status(400).json({
        error: "folderId query parameter is required",
      });
      return;
    }

    const mailboxEmail =
      typeof req.query.mailboxEmail === "string"
        ? req.query.mailboxEmail
        : undefined;
    const attachments = await getAttachmentInfo(
      req.params.accountId,
      folderId,
      req.params.messageId,
      mailboxEmail
    );
    res.json({ attachments });
  })
);

router.get(
  "/accounts/:accountId/messages/:messageId/attachments/:attachmentId/download",
  asyncHandler(async (req, res) => {
    const folderId =
      typeof req.query.folderId === "string" ? req.query.folderId : "";
    if (!folderId) {
      res.status(400).json({
        error: "folderId query parameter is required",
      });
      return;
    }

    const downloaded = await downloadAttachment({
      accountId: req.params.accountId,
      folderId,
      messageId: req.params.messageId,
      attachmentId: req.params.attachmentId,
      filename:
        typeof req.query.filename === "string" ? req.query.filename : undefined,
      mailboxEmail:
        typeof req.query.mailboxEmail === "string"
          ? req.query.mailboxEmail
          : undefined,
    });

    res.json({
      message: "Attachment downloaded",
      ...downloaded,
    });
  })
);

router.get(
  "/test-user",
  asyncHandler(async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!email) {
      res.status(400).json({
        error: "Query parameter email is required",
        example: "/api/zoho/test-user?email=user@example.com",
      });
      return;
    }
    const result = await testOneUser(email);
    res.json(result);
  })
);

router.get(
  "/test-all-users",
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 5;
    const result = await testAllUsers(limit);
    res.json(result);
  })
);

export default router;
