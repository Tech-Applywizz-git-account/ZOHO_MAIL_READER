import path from "path";

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename || "attachment");
  const cleaned = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "attachment.bin";
  }
  return cleaned.slice(0, 180);
}

export function ensureSafeDownloadPath(downloadDir: string, filename: string): string {
  const safeName = sanitizeFilename(filename);
  const fullPath = path.resolve(downloadDir, safeName);
  const resolvedDir = path.resolve(downloadDir);
  if (!fullPath.startsWith(resolvedDir + path.sep) && fullPath !== resolvedDir) {
    throw new Error("Invalid attachment filename (path traversal blocked)");
  }
  return fullPath;
}
