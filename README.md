# Zoho Organization-Wide Mail Reader (Local)

Local Node.js + TypeScript + Express app that uses **Zoho ORG (instance-level) OAuth** to test whether an administrator-authorized integration can list organization users/accounts and read mailbox messages/attachments across the Zoho Mail organization.

This is a **capability proof** before production integration. It is **not** a normal per-user OAuth app.

## Critical capability question

```text
Administrator authorization
        ↓
Instance-level OAuth token
        ↓
Can the token actually access
MAILBOX MESSAGES of other users
in the same Zoho organization?
```

Do **not** assume this works just because organization user APIs succeed.

Use:

1. `/api/zoho/test-user?email=<other-user@domain>` (Admin = A, mailbox = B)
2. Then `/api/zoho/test-all-users`

Each test response includes:

```text
Organization user/account access: YES/NO/UNTESTED
Organization mailbox message access: YES/NO/UNTESTED
Attachment access: YES/NO/UNTESTED
```

## Prerequisites

- Node.js 18+ and npm
- Postman (optional but recommended)
- Zoho Organization **Administrator** account
- Zoho **ORG** OAuth client (not Server-based / Self Client)

## Installation

```bash
npm install
```

## Environment

### macOS / Linux / Git Bash

```bash
cp .env.example .env
```

### Windows PowerShell

```powershell
Copy-Item .env.example .env
```

Edit `.env` and set at least:

```env
ZOHO_CLIENT_ID=your_org_client_id
ZOHO_CLIENT_SECRET=your_org_client_secret
ZOHO_REDIRECT_URI=http://localhost:5000/api/zoho/callback
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_DOMAIN=https://mail.zoho.com
```

### Choose the correct data center

Do **not** assume `.com`.

| If you log into Mail at | Set `ZOHO_ACCOUNTS_URL` | Set `ZOHO_API_DOMAIN` |
| --- | --- | --- |
| mail.zoho.com | https://accounts.zoho.com | https://mail.zoho.com |
| mail.zoho.in | https://accounts.zoho.in | https://mail.zoho.in |
| mail.zoho.eu | https://accounts.zoho.eu | https://mail.zoho.eu |
| mail.zoho.com.au | https://accounts.zoho.com.au | https://mail.zoho.com.au |
| mail.zoho.sg | https://accounts.zoho.sg | https://mail.zoho.sg |
| mail.zoho.jp | https://accounts.zoho.jp | https://mail.zoho.jp |

Optional:

```env
ZOHO_ZOID=1234567890
```

Set `ZOHO_ZOID` if `GET /api/zoho/organization` cannot auto-resolve it. You can find the organization ID in Zoho Mail Admin Console.

`.env` is gitignored. Never commit secrets.

## Start

```bash
npm run dev
```

Server:

- App: http://localhost:5000
- Health: http://localhost:5000/health
- OAuth callback: http://localhost:5000/api/zoho/callback

## Zoho API Console setup (ORG client)

1. Open [Zoho API Console – Add ORG client](https://api-console.zoho.com/add?client_type=ORG)
2. Sign in as the **organization administrator**
3. Create an **ORG** client
4. Homepage URL:

```text
http://localhost:5000
```

5. Authorized Redirect URI:

```text
http://localhost:5000/api/zoho/callback
```

6. Copy Client ID and Client Secret into `.env`

Official docs:

- [Instance-level OAuth](https://www.zoho.com/developer/oauth/instance-level-oauth.html)
- [Get authorization code (ORG)](https://www.zoho.com/accounts/protocol/oauth/instance-level-oauth/get-auth-code.html)

## OAuth flow used by this app

```text
Browser → GET /api/zoho/authorize
       → Redirect to {ZOHO_ACCOUNTS_URL}/oauth/v2/org/auth
       → Admin selects Zoho Mail instance + consents
       → Redirect to /api/zoho/callback?code=...
       → Server exchanges code at /oauth/v2/token
       → Stores access_token + refresh_token in .data/tokens.json
       → Later API calls use Authorization: Zoho-oauthtoken {access_token}
       → Auto-refresh via refresh_token before expiry
```

This uses `/oauth/v2/org/auth` (instance-level), **not** `/oauth/v2/auth` (per-user).

## Scopes used (read-only)

Default `ZOHO_SCOPES`:

```text
ZohoMail.organization.accounts.READ
ZohoMail.folders.READ
ZohoMail.messages.READ
```

Verified against official endpoint docs:

| Capability | Endpoint | Scope |
| --- | --- | --- |
| Org users/accounts | `GET /api/organization/{zoid}/accounts` | `ZohoMail.organization.accounts.READ` |
| Folders | `GET /api/accounts/{accountId}/folders` | `ZohoMail.folders.READ` |
| List emails | `GET /api/accounts/{accountId}/messages/view` | `ZohoMail.messages.READ` |
| Message content | `GET /api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/content` | `ZohoMail.messages.READ` |
| Attachment info | `.../attachmentinfo` | `ZohoMail.messages.READ` |
| Attachment download | `.../attachments/{attachmentId}` | `ZohoMail.messages.READ` |

Notes from official docs:

- Instance-level OAuth allows **one Zoho app per refresh token**. All scopes above are `ZohoMail.*` only.
- Organization details (`GET /api/organization`) is documented under `ZohoMail.partner.organization.READ`. If that call fails with a scope/permission error, set `ZOHO_ZOID` manually. Do **not** broaden to `ALL` unless an endpoint truly requires it.
- This app never auto-requests `ALL` scopes.

## Testing order

1. Start server: `npm run dev`
2. Open http://localhost:5000/api/zoho/authorize
3. Login as Zoho Organization Administrator
4. Select the Zoho Mail organization/instance
5. Approve requested permissions
6. Confirm callback success page (tokens are stored server-side, not shown)
7. Check http://localhost:5000/api/zoho/token-status
8. Call `/api/zoho/organization`
9. Call `/api/zoho/users`
10. Call `/api/zoho/accounts`
11. Pick one **other** user's `accountId`
12. Call `/api/zoho/accounts/:accountId/folders`
13. List emails with Inbox `folderId`
14. Get message content (`folderId` query required)
15. Get attachments / download one file into `downloads/`

Fast path:

```text
GET /api/zoho/test-user?email=other.user@yourdomain.com
GET /api/zoho/test-all-users
```

## API route list

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Health check |
| GET | `/api/zoho/authorize` | Start ORG OAuth |
| GET | `/api/zoho/callback` | OAuth callback |
| GET | `/api/zoho/token-status` | Non-secret token status |
| GET/POST | `/api/zoho/refresh` | Force refresh access token |
| GET | `/api/zoho/organization` | Organization details + store zoid |
| GET | `/api/zoho/users` | Org users (email, zuid) |
| GET | `/api/zoho/accounts` | Users with accountId |
| GET | `/api/zoho/accounts/:accountId/folders` | Folders |
| GET | `/api/zoho/accounts/:accountId/messages` | List/search emails |
| GET | `/api/zoho/accounts/:accountId/messages/:messageId` | Message content |
| GET | `/api/zoho/accounts/:accountId/messages/:messageId/attachments` | Attachment metadata |
| GET | `/api/zoho/accounts/:accountId/messages/:messageId/attachments/:attachmentId/download` | Download attachment |
| GET | `/api/zoho/test-user?email=` | One-mailbox capability test |
| GET | `/api/zoho/test-all-users` | Controlled org-wide summary test |

Message/attachment routes require `?folderId=...` because Zoho’s official content/attachment APIs include `folderId` in the path.

## Postman

Import:

- `postman/Zoho-Mail-Local.postman_collection.json`
- `postman/Zoho-Mail-Local.postman_environment.json`

Environment placeholders only — no real secrets.

## Safety / rate limits

- Default message page size: 20
- Request timeout via `ZOHO_REQUEST_TIMEOUT_MS`
- Retries for 401 (refresh), 429, and 5xx
- Org-wide tests use configurable concurrency (`ZOHO_CONCURRENCY`, default 2)
- Logs never print client secret / access token / refresh token / authorization code
- Attachment filenames are sanitized; path traversal blocked
- Downloads go to `downloads/`

## Official documentation URLs used

OAuth:

- https://www.zoho.com/developer/oauth/instance-level-oauth.html
- https://www.zoho.com/accounts/protocol/oauth/instance-level-oauth/get-auth-code.html
- https://www.zoho.com/accounts/protocol/oauth/web-apps/access-token.html
- https://www.zoho.com/mail/help/api/using-oauth-2.html

Mail APIs:

- https://www.zoho.com/mail/help/api/
- https://www.zoho.com/mail/help/api/getting-started-with-api.html
- https://www.zoho.com/mail/help/api/get-org-details.html
- https://www.zoho.com/mail/help/api/get-org-users-details.html
- https://www.zoho.com/mail/help/api/get-all-folder-details.html
- https://www.zoho.com/mail/help/api/get-emails-list.html
- https://www.zoho.com/mail/help/api/get-email-content.html
- https://www.zoho.com/mail/help/api/get-attach-info.html
- https://www.zoho.com/mail/help/api/get-attachment-content.html
- https://www.zoho.com/mail/help/api/email-api.html
- https://www.zoho.com/mail/help/api/folders-api.html

## Project structure

```text
src/
  config/env.ts
  services/zohoAuth.service.ts
  services/zohoOrganization.service.ts
  services/zohoMail.service.ts
  services/zohoTest.service.ts
  services/zohoClient.ts
  store/tokenStore.ts
  routes/
  middleware/
postman/
downloads/
.data/                 # local token JSON (gitignored)
.env.example
```

Token storage is a local JSON file for development and is structured so it can later be replaced by PostgreSQL/Supabase.

## Test results / limitations (fill after you run)

Until you complete a live test against a **second user mailbox**, treat these as unproven:

```text
Organization user/account access: UNTESTED
Organization mailbox message access: UNTESTED
Attachment access: UNTESTED
```

### Known documentation caveats

1. **Org details scope** is documented as partner organization scope; zoid may need to be set manually.
2. **Message APIs are accountId-scoped**. Instance-level OAuth claims instance-wide access, but whether Mail message endpoints allow **other users’ accountIds** must be proven by `/api/zoho/test-user` against user B.
3. If mailbox access for other users fails with permission/scope errors, officially supported alternatives appear to be product features such as **Mailbox Delegation** or **eDiscovery** (Admin Console), not unrestricted message APIs via a single admin token. Confirm against Zoho support/docs for your plan before production design.

## What you should do next

1. Put Client ID / Client Secret in `.env`
2. Confirm data-center URLs
3. Run `npm run dev`
4. Open http://localhost:5000/api/zoho/authorize
5. Test with another user’s email via `/api/zoho/test-user?email=...`
6. Record YES/NO capability results before integrating into production
