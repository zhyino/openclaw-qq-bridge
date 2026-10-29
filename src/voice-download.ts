import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getVoiceWorkRoot } from "./paths.js";
import { formatBytes, isAmrFormat, isSilkFormat, type VoiceLog } from "./voice-common.js";

/** Hard ceiling for a single inbound voice file. */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** A voice file that takes longer than this is not going to be useful anyway. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

function maxVoiceBytes(): number {
  const configured = Number(process.env.ONEBOT_VOICE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

export async function ensureVoiceTmpDir(): Promise<void> {
  await mkdir(getVoiceWorkRoot(), { recursive: true, mode: 0o700 });
}

/**
 * Read a response body with a hard byte ceiling.
 *
 * The declared Content-Length is checked first (cheap reject), then the stream
 * is counted as it arrives — a hostile or broken server that omits the header
 * cannot make the process buffer an unbounded amount of data.
 */
async function readCapped(
  response: Response,
  limit: number,
  log?: VoiceLog,
): Promise<Buffer | null> {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    log?.error(`Voice download rejected: declared size ${formatBytes(declared)} exceeds ${formatBytes(limit)}`);
    return null;
  }

  const stream = (response as unknown as { body?: { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } }).body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        log?.error(`Voice download aborted: exceeded ${formatBytes(limit)} limit`);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) {
    log?.error(`Voice download rejected: ${formatBytes(buffer.length)} exceeds ${formatBytes(limit)} limit`);
    return null;
  }
  return buffer;
}

export async function downloadVoiceFile(
  url: string,
  log?: VoiceLog,
): Promise<string | null> {
  try {
    await ensureVoiceTmpDir();

    const response = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      log?.error(`Voice download failed: ${response.status}`);
      return null;
    }

    const buffer = await readCapped(response, maxVoiceBytes(), log);
    if (buffer === null) return null;
    if (buffer.length === 0) {
      log?.error("Voice download returned empty file");
      return null;
    }

    const suffix = isSilkFormat(buffer) ? ".silk" : isAmrFormat(buffer) ? ".amr" : ".ogg";
    const filePath = join(getVoiceWorkRoot(), `voice-${randomUUID()}${suffix}`);
    // `wx`: never overwrite an existing file (defence against a pre-planted
    // symlink in a world-writable temp dir).
    await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });

    log?.debug?.(`Downloaded voice: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  } catch (err) {
    log?.error(`Voice download error: ${err}`);
    return null;
  }
}
