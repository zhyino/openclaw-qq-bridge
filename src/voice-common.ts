export interface VoiceLog {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export { getVoiceWorkRoot } from "./paths.js";

/** Header detection is byte-based, never extension-based: NapCat serves voice
 *  with whatever `file` string it happens to have, extensions lie. */
export function isSilkFormat(buf: Buffer): boolean {
  const h = buf.toString("utf-8", 0, 10);
  return h.includes("#!SILK");
}

export function isAmrFormat(buf: Buffer): boolean {
  const h = buf.toString("utf-8", 0, 6);
  return h.startsWith("#!AMR");
}

export function resolveVoiceContentType(filePath: string): string {
  if (filePath.endsWith(".mp3")) return "audio/mpeg";
  if (filePath.endsWith(".wav")) return "audio/wav";
  if (filePath.endsWith(".amr")) return "audio/amr";
  return "audio/ogg";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
