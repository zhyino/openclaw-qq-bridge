import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Session generation bookkeeping.
 *
 * OpenClaw hard-blocks work on an archived session ("Session ... is archived.
 * Restore it before starting new work.") and exposes no restore API to channel
 * plugins. The host also derives one fixed session key per peer, so after a
 * user archives the conversation every inbound message would fail forever.
 *
 * The fix is a per-peer generation counter: generation 0 uses the host's key
 * verbatim; after an archived error we bump the counter and route to
 * `<host-key>:g<N>`, which the host treats as a fresh session. Context is
 * deliberately NOT resurrected — archiving means "start over".
 */

function statePath(): string {
  // Read at call time so tests (and profile switches) can point elsewhere.
  return (
    process.env.QQ_BRIDGE_SESSION_STATE ??
    join(homedir(), ".openclaw", "qq-bridge-sessions.json")
  );
}

type GenerationMap = Record<string, number>;

function readState(): GenerationMap {
  try {
    if (!existsSync(statePath())) return {};
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: GenerationMap = {};
    for (const [peer, gen] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(gen);
      if (Number.isFinite(n) && n > 0) out[peer] = Math.trunc(n);
    }
    return out;
  } catch {
    return {};
  }
}

function writeState(state: GenerationMap): void {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Best effort: a failed write only means the next archived error retries again.
  }
}

/** Current generation for a peer (0 = the host's original session key). */
export function getSessionGeneration(peerId: string): number {
  return readState()[peerId] ?? 0;
}

/** Increment the generation for a peer and return the new value. */
export function bumpSessionGeneration(peerId: string): number {
  const state = readState();
  const next = (state[peerId] ?? 0) + 1;
  state[peerId] = next;
  writeState(state);
  return next;
}

/** Apply a generation to the host-provided session key. */
export function applySessionGeneration(sessionKey: string, generation: number): string {
  return generation > 0 ? `${sessionKey}:g${generation}` : sessionKey;
}
