
/**
 * QQ Bridge owner control commands:
 *  - /silent  : stop forwarding group messages to the agent (owner only)
 *  - /active  : resume forwarding (owner only)
 *  - /role <name> : switch persona (owner only, optional file-based)
 *  - /mode    : report current mode (owner only)
 *
 * These are handled HARD by the bridge — never forwarded to the model,
 * never interpreted by the agent. Non-owner senders are silently ignored.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ResolvedOneBotAccount } from './types.js';
import { isOwner } from './policy.js';

export interface QqBridgeState {
  silent: boolean;
  role?: string;
  updatedAt: string;
}

const DEFAULT_STATE_PATH = join(homedir(), '.openclaw', 'qq-bridge-state.json');

let statePath: string | null = null;

export function setStatePath(p: string): void {
  statePath = p;
}

export function getStatePath(): string {
  return statePath ?? DEFAULT_STATE_PATH;
}

export function readState(): QqBridgeState {
  try {
    const p = getStatePath();
    if (!existsSync(p)) return { silent: false, updatedAt: new Date().toISOString() };
    return JSON.parse(readFileSync(p, 'utf8')) as QqBridgeState;
  } catch {
    return { silent: false, updatedAt: new Date().toISOString() };
  }
}

export function writeState(state: QqBridgeState): void {
  const p = getStatePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
}

export function isSilent(): boolean {
  return readState().silent === true;
}

export function setSilent(v: boolean): void {
  const s = readState();
  s.silent = v;
  s.updatedAt = new Date().toISOString();
  writeState(s);
}

export function setRole(role: string): void {
  const s = readState();
  s.role = role;
  s.updatedAt = new Date().toISOString();
  writeState(s);
}

export interface ControlCommandResult {
  handled: boolean;
  reply?: string;
}

/**
 * Parse and handle a control command. Returns {handled:true, reply} when the
 * message IS a control command (owner or not). For non-owner senders the
 * command is swallowed silently (handled:true, reply:undefined).
 */
export function handleControlCommand(
  text: string,
  account: ResolvedOneBotAccount,
  senderId: string,
): ControlCommandResult {
  const trimmed = text.trim();
  if (!/^\//.test(trimmed)) return { handled: false };

  const isCtrl = /^\/(silent|active|role|mode)\b/i.test(trimmed);
  if (!isCtrl) return { handled: false };

  const owner = isOwner(account, senderId);
  if (!owner) {
    // Non-owner control command: swallow silently.
    return { handled: true };
  }

  const parts = trimmed.split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase().replace(/^\//, '');

  switch (cmd) {
    case 'silent':
      setSilent(true);
      return { handled: true, reply: '收到，我先安静一会儿。需要我的时候发 /active。' };
    case 'active':
      setSilent(false);
      return { handled: true, reply: '在呢，回来了。' };
    case 'role': {
      const role = parts.slice(1).join(' ').trim();
      if (!role) {
        const cur = readState().role ?? 'default';
        return { handled: true, reply: `当前人格：${cur}（可用 /role <名称> 切换）` };
      }
      setRole(role);
      return { handled: true, reply: `人格已切换为：${role}` };
    }
    case 'mode': {
      const s = readState();
      return { handled: true, reply: `当前状态：${s.silent ? '静默中（/active 恢复）' : '活跃'}${s.role ? ` · 人格：${s.role}` : ''}` };
    }
    default:
      return { handled: true, reply: '未知控制命令。可用：/silent /active /role <名称> /mode' };
  }
}
