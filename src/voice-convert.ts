import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { getVoiceWorkRoot } from "./paths.js";
import type { VoiceLog } from "./voice-common.js";

/**
 * Audio transcoding.
 *
 * Two invariants:
 *  - `spawn(cmd, args[])`, never a shell string. Argument arrays are immune to
 *    injection; the input path can never become a command.
 *  - one private work directory per conversion, created with `mkdtemp` under
 *    the voice root (0700, unpredictable name), removed with the result.
 *    Earlier versions leaked one directory per conversion into /tmp.
 */

const CONVERT_TIMEOUT_MS = 15_000;

const EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin", // macOS (Apple Silicon) Homebrew
  "/usr/local/bin", // macOS (Intel) Homebrew / Linux local
];

function toolEnv(): NodeJS.ProcessEnv {
  const base = { ...process.env };
  const current = typeof base.PATH === "string" ? base.PATH : "";
  const merged = [...EXTRA_PATH_DIRS, ...(current ? [current] : [])].join(":");
  return { ...base, PATH: merged };
}

function runTool(cmd: string, args: string[], timeoutMs = CONVERT_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore", env: toolEnv() });
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`tool timed out after ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} unavailable: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

async function makeWorkDir(): Promise<string> {
  const root = getVoiceWorkRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, "conv-"));
}

function isInsideVoiceRoot(candidate: string): boolean {
  const rel = relative(getVoiceWorkRoot(), candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function discard(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* ignore */
  }
}

export async function convertSilkToMp3(
  silkPath: string,
  log?: VoiceLog,
): Promise<string | null> {
  const workDir = await makeWorkDir();
  const pcmPath = join(workDir, `${randomUUID()}.pcm`);
  const mp3Path = join(workDir, `${randomUUID()}.mp3`);

  try {
    // SILK -> PCM via pilk, arguments passed through sys.argv (no eval, no shell).
    const code1 = await runTool("uv", [
      "run",
      "--with",
      "pilk",
      "python3",
      "-c",
      "import pilk, sys; pilk.decode(sys.argv[1], sys.argv[2])",
      silkPath,
      pcmPath,
    ]);
    if (code1 !== 0) {
      throw new Error(`pilk decode failed with exit code ${code1}`);
    }

    // SILK is typically 24000Hz mono 16-bit LE.
    const code2 = await runTool("ffmpeg", [
      "-y",
      "-f",
      "s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-i",
      pcmPath,
      mp3Path,
    ]);
    if (code2 !== 0) {
      throw new Error(`ffmpeg pcm->mp3 failed with exit code ${code2}`);
    }

    await discard(pcmPath);

    if (!existsSync(mp3Path)) {
      throw new Error("ffmpeg produced no output");
    }

    log?.info(`SILK -> mp3 OK: ${mp3Path}`);
    await discard(silkPath);
    return mp3Path;
  } catch (err) {
    log?.error(`SILK conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

export async function convertAmrToMp3(
  amrPath: string,
  log?: VoiceLog,
): Promise<string | null> {
  const workDir = await makeWorkDir();
  const mp3Path = join(workDir, `${randomUUID()}.mp3`);

  try {
    const code = await runTool("ffmpeg", ["-y", "-i", amrPath, "-ar", "16000", "-ac", "1", mp3Path]);
    if (code !== 0) {
      throw new Error(`ffmpeg amr->mp3 failed with exit code ${code}`);
    }
    if (!existsSync(mp3Path)) {
      throw new Error("ffmpeg produced no output");
    }

    log?.info(`AMR -> mp3 OK: ${mp3Path}`);
    await discard(amrPath);
    return mp3Path;
  } catch (err) {
    log?.error(`AMR conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

/**
 * Remove converted voice files and the private work directory that holds them.
 * Only directories this module created (under the voice root, `conv-*`) are
 * removed — a caller passing an arbitrary path can delete a file, never a tree.
 */
export function cleanupVoiceFiles(paths: string[]): void {
  for (const p of paths) {
    if (!p) continue;
    const dir = dirname(p);
    const managed = isInsideVoiceRoot(p) && dir.split(/[\\/]/).pop()?.startsWith("conv-");
    void unlink(p).catch(() => {});
    if (managed) {
      void rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
