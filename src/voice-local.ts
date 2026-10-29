import { existsSync } from "node:fs";

export function resolveLocalVoicePath(url: string): string | null {
  const localPath = url.replace(/^file:\/\//, "");
  return existsSync(localPath) ? localPath : null;
}
