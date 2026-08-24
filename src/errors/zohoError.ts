export class ZohoApiError extends Error {
  public readonly httpStatus: number;
  public readonly zohoCode?: string | number;
  public readonly endpoint: string;
  public readonly context?: Record<string, unknown>;
  public readonly isScopeError: boolean;
  public readonly isRateLimited: boolean;
  public readonly isTransient: boolean;
  public readonly raw?: unknown;

  constructor(params: {
    message: string;
    httpStatus: number;
    endpoint: string;
    zohoCode?: string | number;
    context?: Record<string, unknown>;
    raw?: unknown;
  }) {
    super(params.message);
    this.name = "ZohoApiError";
    this.httpStatus = params.httpStatus;
    this.endpoint = params.endpoint;
    this.zohoCode = params.zohoCode;
    this.context = params.context;
    this.raw = params.raw;

    const text = `${params.message} ${JSON.stringify(params.raw ?? {})}`.toLowerCase();
    this.isScopeError =
      params.httpStatus === 401 ||
      params.httpStatus === 403 ||
      text.includes("scope") ||
      text.includes("insufficient") ||
      text.includes("permission") ||
      text.includes("oauth");
    this.isRateLimited = params.httpStatus === 429;
    this.isTransient =
      params.httpStatus === 408 ||
      params.httpStatus === 429 ||
      params.httpStatus >= 500;
  }
}

export function toPublicError(error: unknown): {
  error: string;
  httpStatus?: number;
  zohoCode?: string | number;
  endpoint?: string;
  context?: Record<string, unknown>;
  hint?: string;
} {
  if (error instanceof ZohoApiError) {
    return {
      error: error.message,
      httpStatus: error.httpStatus,
      zohoCode: error.zohoCode,
      endpoint: error.endpoint,
      context: error.context,
      hint:
        typeof error.context?.hint === "string"
          ? error.context.hint
          : error.isScopeError
        ? String(error.zohoCode).toUpperCase() === "INVALID_OAUTHSCOPE"
          ? "Zoho returned INVALID_OAUTHSCOPE. Re-authorize at /api/zoho/authorize and confirm the consent screen lists ZohoMail.organization.accounts.READ, ZohoMail.folders.READ, and ZohoMail.messages.READ. Refreshing the token will not fix missing scopes."
          : "The current token does not have the required scope for this endpoint."
        : error.isRateLimited
          ? "Zoho rate limit hit. Retry with smaller page sizes or lower concurrency."
          : undefined,
    };
  }

  if (error instanceof Error) {
    return { error: error.message };
  }

  return { error: "Unknown error" };
}
