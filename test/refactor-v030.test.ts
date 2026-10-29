import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveOneBotAccount, validateOneBotConfig } from '../src/config.js';
import {
  fileUriToPath,
  getVoiceWorkRoot,
  resolveMediaRoots,
} from '../src/paths.js';
import { checkInboundAllowed, assertSafeMediaPath, redactSensitive } from '../src/policy.js';
import { MessageBatcher, type BufferedMessage } from '../src/gateway/batch.js';
import type { ResolvedOneBotAccount } from '../src/types.js';

function account(overrides: Partial<ResolvedOneBotAccount> = {}): ResolvedOneBotAccount {
  return {
    accountId: 'default',
    enabled: true,
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3001',
    groupAutoReact: false,
    groupAutoReactEmojiId: 1,
    replyAudit: true,
    config: {},
    ...overrides,
  };
}

describe('config: default account uses a structural spread', () => {
  it('keeps mediaAllowDirs for the default account (regression: field-list drift)', () => {
    const cfg = {
      channels: {
        onebot: {
          wsUrl: 'ws://x',
          httpUrl: 'http://y',
          mediaAllowDirs: ['/srv/media'],
        },
      },
    };
    const acct = resolveOneBotAccount(cfg as any, 'default');
    expect(acct.mediaAllowDirs).toEqual(['/srv/media']);
    expect((acct.config as any).mediaAllowDirs).toEqual(['/srv/media']);
  });

  it('keeps config keys this version does not know about', () => {
    const cfg = {
      channels: { onebot: { wsUrl: 'ws://x', httpUrl: 'http://y', futureOption: 42 } },
    };
    const acct = resolveOneBotAccount(cfg as any, 'default');
    expect((acct.config as any).futureOption).toBe(42);
  });

  it('does not leak the accounts bag into the default account', () => {
    const cfg = {
      channels: {
        onebot: {
          wsUrl: 'ws://x',
          httpUrl: 'http://y',
          accounts: { a: { wsUrl: 'ws://a', httpUrl: 'http://a' } },
        },
      },
    };
    const acct = resolveOneBotAccount(cfg as any, 'default');
    expect((acct.config as any).accounts).toBeUndefined();
  });

  it('named accounts resolve identically to the default one', () => {
    const cfg = {
      channels: {
        onebot: {
          accounts: { a: { wsUrl: 'ws://a', httpUrl: 'http://a', mediaAllowDirs: ['/srv/a'] } },
        },
      },
    };
    expect(resolveOneBotAccount(cfg as any, 'a').mediaAllowDirs).toEqual(['/srv/a']);
  });
});

describe('config: validation surfaces unsafe defaults', () => {
  it('warns about empty allowFrom and empty outboundAllow', () => {
    const issues = validateOneBotConfig(
      account({ accountId: 'a', wsUrl: 'ws://x', httpUrl: 'http://y' }),
    );
    const fields = issues.map((i) => i.field);
    expect(fields).toContain('allowFrom');
    expect(fields).toContain('outboundAllow');
  });

  it('reports a malformed wsUrl as an error', () => {
    const issues = validateOneBotConfig(
      account({ wsUrl: 'http://not-a-ws', httpUrl: 'http://y', allowFrom: ['*'], outboundAllow: ['*'] }),
    );
    expect(issues.some((i) => i.level === 'error' && i.field === 'wsUrl')).toBe(true);
  });

  it('is quiet for a fully configured account', () => {
    const issues = validateOneBotConfig(
      account({
        wsUrl: 'wss://x',
        httpUrl: 'https://y',
        accessToken: 't',
        allowFrom: ['*'],
        outboundAllow: ['*'],
      }),
    );
    expect(issues).toEqual([]);
  });
});

describe('paths: one source of truth', () => {
  const oldVoiceDir = process.env.ONEBOT_VOICE_DIR;

  afterEach(() => {
    if (oldVoiceDir === undefined) delete process.env.ONEBOT_VOICE_DIR;
    else process.env.ONEBOT_VOICE_DIR = oldVoiceDir;
  });

  it('media roots always include the shared dir and the voice work root', () => {
    const roots = resolveMediaRoots(account({ sharedDir: '/srv/shared' }));
    expect(roots).toContain(resolve('/srv/shared'));
    expect(roots).toContain(getVoiceWorkRoot());
  });

  it('honours ONEBOT_VOICE_DIR', () => {
    process.env.ONEBOT_VOICE_DIR = join(tmpdir(), 'custom-voice-root');
    expect(getVoiceWorkRoot()).toBe(resolve(join(tmpdir(), 'custom-voice-root')));
    expect(resolveMediaRoots(account())).toContain(getVoiceWorkRoot());
  });

  it('accepts a file the voice pipeline just wrote (regression: phantom root)', () => {
    const root = getVoiceWorkRoot();
    mkdirSync(root, { recursive: true });
    const file = join(root, `probe-${Date.now()}.mp3`);
    writeFileSync(file, 'x');
    try {
      expect(assertSafeMediaPath(account(), file)).toBe(resolve(file));
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('decodes percent-escaped file URIs without platform-specific URL parsing', () => {
    expect(fileUriToPath('file:///tmp/My%20Image.png')).toBe('/tmp/My Image.png');
    expect(fileUriToPath('/plain/path.png')).toBe('/plain/path.png');
  });
});

describe('policy: inbound matching shares the outbound matcher', () => {
  it('allows everything when allowFrom is empty (documented legacy default)', () => {
    expect(checkInboundAllowed(account(), 'group:123').allowed).toBe(true);
  });

  it('matches exact ids and "*"', () => {
    const acc = account({ allowFrom: ['group:123', 'private:9'] });
    expect(checkInboundAllowed(acc, 'group:123').allowed).toBe(true);
    expect(checkInboundAllowed(acc, 'private:9').allowed).toBe(true);
    expect(checkInboundAllowed(acc, 'group:124').allowed).toBe(false);
  });

  it('supports the type wildcard inbound too (regression: two implementations)', () => {
    const acc = account({ allowFrom: ['group:*'] });
    expect(checkInboundAllowed(acc, 'group:1').allowed).toBe(true);
    expect(checkInboundAllowed(acc, 'private:1').allowed).toBe(false);
  });
});

describe('redactSensitive', () => {
  it('replaces paths and credentials but keeps the sentence', () => {
    const out = redactSensitive('配置在 /home/u/.openclaw/openclaw.json, token: sk-abcdefghijklmnop');
    expect(out).toContain('[path]');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('.openclaw');
    expect(out).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('MessageBatcher', () => {
  function msg(text: string): BufferedMessage {
    return {
      event: { message_id: 1, user_id: 1, self_id: 2, message_type: 'group', group_id: 5 } as any,
      text,
      images: [],
      recordSegments: [],
    };
  }

  it('coalesces within the gap window and flushes after it', async () => {
    const flushed: string[][] = [];
    const batcher = new MessageBatcher({
      gapMs: 20,
      maxMessages: 10,
      maxChars: 1000,
      onFlush: (_key, messages) => {
        flushed.push(messages.map((m) => m.text));
      },
    });

    batcher.push('k', msg('a'));
    batcher.push('k', msg('b'));
    expect(flushed).toEqual([]);

    await new Promise((r) => setTimeout(r, 60));
    expect(flushed).toEqual([['a', 'b']]);
    batcher.dispose();
  });

  it('flushes early when the batch is full', () => {
    const flushed: string[][] = [];
    const batcher = new MessageBatcher({
      gapMs: 10_000,
      maxMessages: 2,
      maxChars: 1000,
      onFlush: (_key, messages) => {
        flushed.push(messages.map((m) => m.text));
      },
    });

    batcher.push('k', msg('a'));
    batcher.push('k', msg('b'));
    batcher.push('k', msg('c'));

    expect(flushed).toEqual([['a', 'b']]);
    batcher.dispose();
  });

  it('drops pending messages on dispose', async () => {
    const flushed: string[][] = [];
    const batcher = new MessageBatcher({
      gapMs: 20,
      maxMessages: 10,
      maxChars: 1000,
      onFlush: (_key, messages) => {
        flushed.push(messages.map((m) => m.text));
      },
    });

    batcher.push('k', msg('a'));
    batcher.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(flushed).toEqual([]);
  });

  it('reports async flush failures through onError instead of unhandled rejections', async () => {
    const errors: unknown[] = [];
    const batcher = new MessageBatcher({
      gapMs: 5,
      maxMessages: 1,
      maxChars: 10,
      onFlush: async () => {
        throw new Error('boom');
      },
      onError: (err) => errors.push(err),
    });

    batcher.push('k', msg('a'));
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(1);
    batcher.dispose();
  });
});
