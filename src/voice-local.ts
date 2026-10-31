import { existsSync } from "node:fs";
import { fileUriToPath } from "./paths.js";

/**
 * Resolve a `file:` URI (or a plain path) to an existing local path.
 * Uses the shared `fileUriToPath` — hand-rolling `replace(/^file:\/\//, "")`
 * leaves a leading slash on Windows (`/C:/...`), so existsSync is always false
 * and local voice segments are silently dropped.
 */
export function resolveLocalVoicePath(url: string): string | null {
  if (!url) return null;
  const localPath = url.toLowerCase().startsWith("file:") ? fileUriToPath(url) : url;
  return existsSync(localPath) ? localPath : null;
}
