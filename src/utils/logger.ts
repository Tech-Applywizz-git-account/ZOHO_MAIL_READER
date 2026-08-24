type LogLevel = "info" | "warn" | "error" | "debug";

const SECRET_KEYS = [
  "client_secret",
  "clientSecret",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "authorization_code",
  "code",
  "Authorization",
  "authorization",
];

function maskValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function sanitizeForLog(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(sanitizeForLog);
  }
  if (input && typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_KEYS.some((s) => key.toLowerCase().includes(s.toLowerCase()))) {
        result[key] = maskValue(value);
      } else {
        result[key] = sanitizeForLog(value);
      }
    }
    return result;
  }
  return input;
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  const payload =
    meta === undefined
      ? { level, message, time: new Date().toISOString() }
      : {
          level,
          message,
          time: new Date().toISOString(),
          meta: sanitizeForLog(meta),
        };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
};
