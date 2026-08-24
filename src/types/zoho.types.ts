export type TokenRecord = {
  accessToken: string;
  refreshToken: string;
  apiDomain: string;
  mailApiDomain: string;
  accountsUrl: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
  zoid?: string;
  updatedAt: string;
};

export type OrgUserSummary = {
  email: string;
  zuid: string;
  accountId: string;
  displayName?: string;
  role?: string;
  mailboxStatus?: string;
};

export type FolderSummary = {
  folderId: string;
  folderName: string;
  folderType?: string;
  path?: string;
};

export type MessageSummary = {
  messageId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  receivedTime: string;
  hasAttachment: boolean;
  folderId?: string;
};

export type AttachmentSummary = {
  attachmentId: string;
  name: string;
  size: number;
};

export type CapabilityFlags = {
  organizationUserAccountAccess: "YES" | "NO" | "UNTESTED";
  organizationMailboxMessageAccess: "YES" | "NO" | "UNTESTED";
  attachmentAccess: "YES" | "NO" | "UNTESTED";
};
