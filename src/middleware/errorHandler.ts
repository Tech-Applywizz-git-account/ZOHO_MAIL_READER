import { Request, Response, NextFunction } from "express";
import { ZohoApiError, toPublicError } from "../errors/zohoError";
import { logger } from "../utils/logger";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const publicError = toPublicError(err);
  const status =
    err instanceof ZohoApiError
      ? err.httpStatus || 500
      : err instanceof Error && err.message.includes("Not authenticated")
        ? 401
        : err instanceof Error &&
            (err.message.includes("Missing required") ||
              err.message.includes("Self Client code belongs to") ||
              err.message.includes("Authorization code is required") ||
              err.message.includes("No refresh token"))
          ? 400
          : 500;

  logger.error("Request failed", publicError);
  res.status(status >= 400 && status < 600 ? status : 500).json(publicError);
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
