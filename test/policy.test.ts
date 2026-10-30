import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseTarget,
  checkOutboundTarget,
  auditReply,
  isOwner,
  isControlCommand,
  assertOutboundAllowed,
  assertSafeMediaPath,
} from '../src/policy.js';
import type { ResolvedOneBotAccount } from '../src/types.js';

/**
 * Probe once whether this host can create symlinks. POSIX always can; Windows
 * needs Developer Mode or elevation, so CI runners usually cannot.
 */
const CAN_SYMLINK: boolean = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'symlink-probe-'));
  try {
    writeFileSync(join(probe, 'target'), 'x');
    symlinkSync(join(probe, 'target'), join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

function makeAccount(overrides: Partial<ResolvedOneBotAccount> = {}): ResolvedOneBotAccount {
  return {
    accountId: 'default',
    enabled: true,
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3001',
    allowFrom: [],
    groupAutoReact: false,
    groupAutoReactEmojiId: 1,
    replyAudit: true,
    qzoneWrite: false,
    muteSystemNotices: true,
    config: {},
    ...overrides,
  };
}

describe('parseTarget', () => {
  it('parses private and group prefixes', () => {
    expect(parseTarget('private:123')).toEqual({ type: 'private', id: 123 });
    expect(parseTarget('group:456')).toEqual({ type: 'group', id: 456 });
  });
  it('strips onebot prefix', () => {
    expect(parseTarget('onebot:group:456')).toEqual({ type: 'group', id: 456 });
  });
  it('defaults bare numbers to private', () => {
    expect(parseTarget('789')).toEqual({ type: 'private', id: 789 });
  });
});

describe('checkOutboundTarget', () => {
  it('allows everything when no allowlist configured', () => {
    expect(checkOutboundTarget(makeAccount(), 'group:999').allowed).toBe(true);
  });

  it('blocks targets not in the allowlist', () => {
    const acc = makeAccount({ outboundAllow: ['group:111', 'private:222'] });
    expect(checkOutboundTarget(acc, 'group:111').allowed).toBe(true);
    expect(checkOutboundTarget(acc, 'private:222').allowed).toBe(true);
    const blocked = checkOutboundTarget(acc, 'group:333');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('not in outbound allow list');
  });

  it('denylist wins over allowlist', () => {
    const acc = makeAccount({ outboundAllow: ['group:111'], outboundDeny: ['group:111'] });
    const r = checkOutboundTarget(acc, 'group:111');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('deny list');
  });

  it('supports wildcard allow', () => {
    const acc = makeAccount({ outboundAllow: ['*'] });
    expect(checkOutboundTarget(acc, 'group:1').allowed).toBe(true);
    expect(checkOutboundTarget(acc, 'private:2').allowed).toBe(true);
  });

  it('supports type wildcard', () => {
    const acc = makeAccount({ outboundAllow: ['group:*'] });
    expect(checkOutboundTarget(acc, 'group:1').allowed).toBe(true);
    expect(checkOutboundTarget(acc, 'private:2').allowed).toBe(false);
  });
});

describe('auditReply', () => {
  it('passes normal chat text', () => {
    expect(auditReply('今晚吃什么？').ok).toBe(true);
    expect(auditReply('哈哈哈哈哈').ok).toBe(true);
  });

  it('blocks unix absolute paths', () => {
    const r = auditReply('配置在 /home/dafeiyu/.openclaw/openclaw.json 里');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('local path');
  });

  it('blocks windows absolute paths', () => {
    const r = auditReply('文件在 C:\\Users\\test\\config.json');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('local path');
  });

  it('blocks api key patterns', () => {
    const r = auditReply('用这个 api_key: sk-abcdefghijklmnopqrst 试试');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('credential');
  });

  it('blocks bearer tokens', () => {
    expect(auditReply('authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6').ok).toBe(false);
  });

  it('blocks github tokens', () => {
    expect(auditReply('token 是 ghp_abcdefghijklmnopqrstuvwxyz0123456789').ok).toBe(false);
  });

  it('does not block normal slash usage', () => {
    expect(auditReply('今天天气不错 / 心情也好').ok).toBe(true);
    expect(auditReply('1/2 加 1/3').ok).toBe(true);
  });
});

describe('isOwner', () => {
  it('returns true only for configured ownerQQ', () => {
    const acc = makeAccount({ ownerQQ: '10001' });
    expect(isOwner(acc, '10001')).toBe(true);
    expect(isOwner(acc, 10001)).toBe(true);
    expect(isOwner(acc, '99999')).toBe(false);
  });

  it('returns false when no owner configured', () => {
    expect(isOwner(makeAccount(), '10001')).toBe(false);
  });
});

describe('isControlCommand', () => {
  it('detects bridge control commands', () => {
    expect(isControlCommand('/silent')).toBe(true);
    expect(isControlCommand('/active')).toBe(true);
    expect(isControlCommand('/role 猫娘')).toBe(true);
    expect(isControlCommand('/mode')).toBe(true);
  });

  it('ignores openclaw built-in commands and normal text', () => {
    expect(isControlCommand('/reset')).toBe(false);
    expect(isControlCommand('/status')).toBe(false);
    expect(isControlCommand('今天 /silent 了吗')).toBe(false);
    expect(isControlCommand('hello')).toBe(false);
  });
});


describe('assertOutboundAllowed (H1 unified gate)', () => {
  it('allows when target whitelisted and text clean', () => {
    const acc = makeAccount({ outboundAllow: ['group:1'], replyAudit: true });
    expect(assertOutboundAllowed(acc, 'group:1', 'hello').allowed).toBe(true);
  });

  it('blocks unlisted target even with clean text', () => {
    const acc = makeAccount({ outboundAllow: ['group:1'], replyAudit: true });
    const r = assertOutboundAllowed(acc, 'group:2', 'hello');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not in outbound allow/);
  });

  it('blocks audited text even for allowed target', () => {
    const acc = makeAccount({ outboundAllow: ['group:1'], replyAudit: true });
    const r = assertOutboundAllowed(acc, 'group:1', '路径是 /home/dafeiyu/x');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/local path|credential/);
  });

  it('skips audit when replyAudit is false', () => {
    const acc = makeAccount({ outboundAllow: ['group:1'], replyAudit: false });
    expect(assertOutboundAllowed(acc, 'group:1', '路径是 /home/dafeiyu/x').allowed).toBe(true);
  });
});

describe('assertSafeMediaPath (H1 media path whitelist)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'policy-media-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAcc(sharedDir?: string, extraDirs: string[] = []) {
    return makeAccount({
      sharedDir,
      mediaAllowDirs: extraDirs,
      config: { mediaAllowDirs: extraDirs },
    });
  }

  it('accepts a file inside sharedDir', () => {
    const f = join(dir, 'ok.png');
    writeFileSync(f, 'x');
    const acc = makeAcc(dir);
    const resolved = assertSafeMediaPath(acc, f);
    expect(resolved).toBe(resolve(f));
  });

  it('rejects a file outside any controlled directory', () => {
    const outside = join(dir, '..', 'outside.png');
    const acc = makeAcc(join(dir, 'shared'));
    expect(() => assertSafeMediaPath(acc, outside)).toThrow(/outside controlled/);
  });

  it('rejects path traversal', () => {
    const acc = makeAcc(dir);
    expect(() => assertSafeMediaPath(acc, join(dir, '..', '..', 'etc', 'passwd'))).toThrow();
  });

  it('rejects a missing file', () => {
    const acc = makeAcc(dir);
    expect(() => assertSafeMediaPath(acc, join(dir, 'nope.png'))).toThrow(/not found/);
  });

  // Windows only allows symlink creation with Developer Mode or admin rights.
  // Without the capability check these two cases fail with EPERM on a clean
  // Windows runner, which turns CI red for an environment limitation rather
  // than a policy regression.
  it.skipIf(!CAN_SYMLINK)('rejects symlink escape outside the root', () => {
    const targetOutside = join(dir, '..', 'secret-target.txt');
    writeFileSync(targetOutside, 'secret');
    const link = join(dir, 'evil.png');
    symlinkSync(targetOutside, link);
    const acc = makeAcc(dir);
    expect(() => assertSafeMediaPath(acc, link)).toThrow(/symlink|outside/);
  });

  it.skipIf(!CAN_SYMLINK)('accepts a symlink that resolves inside the root', () => {
    const real = join(dir, 'real.png');
    writeFileSync(real, 'x');
    const link = join(dir, 'alias.png');
    symlinkSync(real, link);
    const acc = makeAcc(dir);
    expect(assertSafeMediaPath(acc, link)).toBe(resolve(link));
  });
});
