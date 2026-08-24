import axios, { AxiosError, AxiosRequestConfig, Method } from "axios";
import { env } from "../config/env";
import { ZohoApiError } from "../errors/zohoError";
import { getValidAccessToken } from "./zohoAuth.service";
import { tokenStore } from "../store/tokenStore";
import { logger } from "../utils/logger";

type RequestOptions = {
  method?: Method;
  path: string;
  params?: Record<string, unknown>;
  data?: unknown;
  responseType?: AxiosRequestConfig["responseType"];
  context?: Record<string, unknown>;
  retries?: number;
  /** Use a specific mailbox access token instead of the admin/org token. */
  accessToken?: string;
  mailApiDomain?: string;
  onUnauthorized?: () => Promise<string>;
};

function getMailBaseUrl(override?: string): string {
  if (override) {
    return override.replace(/\/$/, "");
  }
  const stored = tokenStore.get();
  return (
    stored?.mailApiDomain ||
    env.zohoApiDomain ||
    "https://mail.zoho.com"
  ).replace(/\/$/, "");
}

function extractZohoPayload(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload) && payload.length >= 2 && payload[1] && typeof payload[1] === "object") {
    return payload[1] as Record<string, unknown>;
  }
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }
  return null;
}

function extractZohoCode(payload: unknown): string | number | undefined {
  const obj = extractZohoPayload(payload);
  if (!obj) {
    return undefined;
  }
  const status = obj.status as Record<string, unknown> | undefined;
  if (status?.code !== undefined) {
    return status.code as string | number;
  }
  if (typeof obj.errorCode === "string" || typeof obj.errorCode === "number") {
    return obj.errorCode;
  }
  return undefined;
}

function extractMessage(payload: unknown, fallback: string): string {
  const obj = extractZohoPayload(payload);
  if (!obj) {
    return fallback;
  }
  const status = obj.status as Record<string, unknown> | undefined;
  const data = obj.data as Record<string, unknown> | undefined;
  return (
    (typeof obj.errorCode === "string" && obj.errorCode) ||
    (typeof obj.msg === "string" && obj.msg) ||
    (typeof data?.moreInfo === "string" && data.moreInfo) ||
    (typeof status?.description === "string" && status.description) ||
    (typeof obj.message === "string" && obj.message) ||
    fallback
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function zohoMailRequest<T = unknown>(
  options: RequestOptions
): Promise<T> {
  const method = options.method || "GET";
  const baseURL = getMailBaseUrl(options.mailApiDomain);
  const endpoint = `${baseURL}${options.path}`;
  const maxRetries = options.retries ?? 2;

  let lastError: unknown;
  let accessToken = options.accessToken;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    if (!accessToken) {
      accessToken = await getValidAccessToken();
    }

    try {
      const response = await axios.request<T>({
        method,
        url: endpoint,
        params: options.params,
        data: options.data,
        responseType: options.responseType || "json",
        timeout: env.zohoRequestTimeoutMs,
        headers: {
          Accept:
            options.responseType === "arraybuffer"
              ? "application/octet-stream"
              : "application/json",
          "Content-Type": "application/json",
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        validateStatus: () => true,
      });

      const zohoCode = extractZohoCode(response.data);
      const isInvalidScope =
        String(zohoCode).toUpperCase() === "INVALID_OAUTHSCOPE" ||
        extractMessage(response.data, "")
          .toUpperCase()
          .includes("INVALID_OAUTHSCOPE");

      if (response.status === 401 && attempt <= maxRetries && !isInvalidScope) {
        logger.warn("Zoho returned 401; refreshing token and retrying", {
          endpoint: options.path,
          attempt,
          context: options.context,
        });
        if (options.onUnauthorized) {
          accessToken = await options.onUnauthorized();
        } else if (!options.accessToken) {
          const { refreshAccessToken } = await import("./zohoAuth.service");
          await refreshAccessToken();
          accessToken = undefined;
        } else {
          break;
        }
        continue;
      }

      if (response.status === 429 && attempt <= maxRetries) {
        const retryAfter = Number(response.headers["retry-after"] || 2);
        logger.warn("Zoho rate limited; backing off", {
          endpoint: options.path,
          attempt,
          retryAfter,
          context: options.context,
        });
        await sleep(Math.min(Math.max(retryAfter, 1), 10) * 1000);
        continue;
      }

      if (response.status >= 500 && attempt <= maxRetries) {
        logger.warn("Zoho transient error; retrying", {
          endpoint: options.path,
          status: response.status,
          attempt,
          context: options.context,
        });
        await sleep(500 * attempt);
        continue;
      }

      if (response.status >= 400) {
        const message = extractMessage(
          response.data,
          `Zoho API request failed (${response.status})`
        );
        const error = new ZohoApiError({
          message,
          httpStatus: response.status,
          endpoint: options.path,
          zohoCode,
          context: options.context,
          raw: response.data,
        });
        logger.error("Zoho API error", {
          httpStatus: error.httpStatus,
          zohoCode: error.zohoCode,
          endpoint: error.endpoint,
          context: error.context,
        });
        throw error;
      }

      return response.data;
    } catch (error) {
      lastError = error;
      if (error instanceof ZohoApiError) {
        throw error;
      }

      const axiosError = error as AxiosError;
      if (axiosError.code === "ECONNABORTED" && attempt <= maxRetries) {
        await sleep(500 * attempt);
        continue;
      }

      throw new ZohoApiError({
        message: axiosError.message || "Zoho request failed",
        httpStatus: axiosError.response?.status || 500,
        endpoint: options.path,
        context: options.context,
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ZohoApiError({
        message: "Zoho request failed after retries",
        httpStatus: 500,
        endpoint: options.path,
        context: options.context,
      });
}
