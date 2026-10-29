import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setStatePath,
  readState,
  writeState,
  isSilent,
  setSilent,
  setRole,
  handleControlCommand,
} from '../src/owner-control.js';
import type { ResolvedOneBotAccount } from '../src/types.js';
import { makeAccount as makeAccountBase } from './helpers/fixtures.js';

let dir: string;

// Local defaults delegate to the shared factory so a new required field on
// ResolvedOneBotAccount only has to be added in test/helpers/fixtures.ts.
function makeAccount(overrides: Partial<ResolvedOneBotAccount> = {}): ResolvedOneBotAccount {
  return makeAccountBase({
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3001',
    allowFrom: [],
    ownerQQ: '10001',
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-test-'));
  setStatePath(join(dir, 'state.json'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('state persistence', () => {
  it('defaults to not silent when no state file', () => {
    expect(isSilent()).toBe(false);
    expect(readState().silent).toBe(false);
  });

  it('persists silent flag', () => {
    setSilent(true);
    expect(isSilent()).toBe(true);
    setSilent(false);
    expect(isSilent()).toBe(false);
  });

  it('persists role', () => {
    setRole('猫娘');
    expect(readState().role).toBe('猫娘');
  });

  it('updates updatedAt on write', async () => {
    const before = readState().updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    setSilent(true);
    expect(readState().updatedAt).not.toBe(before);
  });
});

describe('handleControlCommand', () => {
  it('ignores non-command text', () => {
    const r = handleControlCommand('今天天气不错', makeAccount(), '10001');
    expect(r.handled).toBe(false);
  });

  it('ignores openclaw built-in commands', () => {
    const r = handleControlCommand('/reset', makeAccount(), '10001');
    expect(r.handled).toBe(false);
  });

  it('owner /silent sets silent and replies', () => {
    const r = handleControlCommand('/silent', makeAccount(), '10001');
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('安静');
    expect(isSilent()).toBe(true);
  });

  it('owner /active clears silent', () => {
    setSilent(true);
    const r = handleControlCommand('/active', makeAccount(), '10001');
    expect(r.handled).toBe(true);
    expect(isSilent()).toBe(false);
  });

  it('owner /role switches persona', () => {
    const r = handleControlCommand('/role 猫娘', makeAccount(), '10001');
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('猫娘');
    expect(readState().role).toBe('猫娘');
  });

  it('owner /role without arg reports current', () => {
    setRole('小鲸鱼');
    const r = handleControlCommand('/role', makeAccount(), '10001');
    expect(r.reply).toContain('小鲸鱼');
  });

  it('owner /mode reports state', () => {
    setSilent(true);
    const r = handleControlCommand('/mode', makeAccount(), '10001');
    expect(r.reply).toContain('静默');
  });

  it('non-owner command is swallowed silently', () => {
    const r = handleControlCommand('/silent', makeAccount(), '99999');
    expect(r.handled).toBe(true);
    expect(r.reply).toBeUndefined();
    expect(isSilent()).toBe(false);
  });

  it('command from account without owner configured is swallowed', () => {
    const r = handleControlCommand('/silent', makeAccount({ ownerQQ: undefined }), '10001');
    expect(r.handled).toBe(true);
    expect(r.reply).toBeUndefined();
    expect(isSilent()).toBe(false);
  });
});
