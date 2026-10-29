/**
 * Single source of truth for every filesystem root the bridge touches.
 *
 * Design rule: the code that WRITES to a directory and the code that
 * WHITELISTS it must import the same symbol from this module.
 *
 * History (why this file exists): v0.1–v0.2 kept three independent copies of
 * the same fact — the config field list in `config.ts`, the root literals in
 * `policy.ts`, and the output paths in `voice-*.ts`. They drifted apart in
 * three consecutive releases: first the guard sat at the wrong layer, then it
 * locked out its own agent, then the allowlist pointed at a directory that
 * nothing ever wrote to. One symbol per fact makes that class of bug
 * unrepresentable.
 */
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedOneBotAccount } from "./types.js";

/** Sub-directory of sharedDir used to stage outbound media for NapCat. */
export const STAGED_MEDIA_DIRNAME = "openclaw";

/** Staged media older than this is pruned on the next outbound media send. */
export const STAGED_MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function getDefaultSharedDir(): string {
  return process.env.ONEBOT_SHARED_DIR ?? join(homedir(), "napcat", "shared");
}

export function getDefaultContainerSharedDir(): string {
  return process.env.ONEBOT_CONTAINER_SHARED_DIR ?? "/shared";
}

/**
 * Scratch space for inbound voice (download + transcoding output).
 * Overridable so deployments can pin it to a volume with a quota.
 */
export function getVoiceWorkRoot(): string {
  return resolve(process.env.ONEBOT_VOICE_DIR ?? join(tmpdir(), "openclaw-onebot-voice"));
}

/**
 * Turn a `file://` URI into a filesystem path.
 *
 * `fileURLToPath()` rejects POSIX-style URIs on Windows (`file:///tmp/a.png`
 * points outside the current drive), which used to surface as a raw TypeError
 * from an agent-supplied URL. Degrade to percent-decoding instead of throwing.
 */
export function fileUriToPath(uri: string): string {
  if (!/^file:/i.test(uri)) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    const stripped = uri.replace(/^file:\/\//i, "");
    try {
      return decodeURIComponent(stripped);
    } catch {
      return stripped;
    }
  }
}

export interface AccountDirs {
  /** Host directory shared with the NapCat container. */
  sharedDir: string;
  /** Path of `sharedDir` as seen from inside the NapCat container. */
  containerSharedDir: string;
  /** Where outbound media is staged: `<sharedDir>/openclaw`. */
  stagingRoot: string;
}

export function resolveAccountDirs(account: ResolvedOneBotAccount): AccountDirs {
  const raw = (account.config ?? {}) as Record<string, unknown>;
  const sharedDir =
    typeof raw.sharedDir === "string" && raw.sharedDir.trim()
      ? raw.sharedDir.trim()
      : account.sharedDir && account.sharedDir.trim()
        ? account.sharedDir.trim()
        : getDefaultSharedDir();
  const containerRaw =
    typeof raw.containerSharedDir === "string" && raw.containerSharedDir.trim()
      ? raw.containerSharedDir.trim()
      : getDefaultContainerSharedDir();
  const containerSharedDir = containerRaw.replace(/\/+$/, "") || "/shared";

  return {
    sharedDir: resolve(sharedDir),
    containerSharedDir,
    stagingRoot: join(resolve(sharedDir), STAGED_MEDIA_DIRNAME),
  };
}

/**
 * Every directory a media file may be read from.
 *
 * Included by construction:
 *  - the shared dir (outbound staging lives inside it)
 *  - explicit `mediaAllowDirs` (config, per account)
 *  - the voice work root — this plugin writes decoded/transcoded voice there,
 *    and the reply pipeline sends it straight back, so it MUST be allowed
 */
export function resolveMediaRoots(account: ResolvedOneBotAccount): string[] {
  const roots = new Set<string>();

  roots.add(resolveAccountDirs(account).sharedDir);

  const configured = [
    ...(Array.isArray(account.mediaAllowDirs) ? account.mediaAllowDirs : []),
    ...(Array.isArray((account.config as Record<string, unknown> | undefined)?.mediaAllowDirs)
      ? ((account.config as Record<string, unknown>).mediaAllowDirs as unknown[])
      : []),
  ];
  for (const dir of configured) {
    if (typeof dir === "string" && dir.trim()) {
      roots.add(resolve(dir.trim()));
    }
  }

  roots.add(getVoiceWorkRoot());

  return [...roots];
}
