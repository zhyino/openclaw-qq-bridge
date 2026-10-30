import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSystemNotice } from '../src/policy.js';
import { sendText } from '../src/outbound.js';
import type { ResolvedOneBotAccount } from '../src/types.js';

function mkAccount(overrides?: Partial<ResolvedOneBotAccount>): ResolvedOneBotAccount {
  return {
    accountId: 'default',
    enabled: true,
    wsUrl: 'ws://x',
    httpUrl: 'http://127.0.0.1:1',
    config: {},
    muteSystemNotices: true,
    ...overrides,
  } as any;
}

describe('isSystemNotice', () => {
  it('matches plugin error/processing notices with [OpenClaw] prefix', () => {
    expect(isSystemNotice('[OpenClaw] Request received, processing...')).toBe(true);
    expect(isSystemNotice('[OpenClaw] Error: something broke')).toBe(true);
    expect(isSystemNotice('[OpenClaw] Processing failed: boom')).toBe(true);
    expect(isSystemNotice('  [OpenClaw] Error: leading whitespace  ')).toBe(true);
  });

  it('matches host skill-learning notifications', () => {
    expect(isSystemNotice('💾 Learned: created view-chat-image (Recurring: ...)')).toBe(true);
    expect(isSystemNotice('💾 Learned: updated foo. Say "undo" to revert this skill change.')).toBe(true);
  });

  it('matches the fixed "Say undo to revert" trailer anywhere in the text', () => {
    expect(isSystemNotice('Foo. Say "undo" to revert this skill change.')).toBe(true);
  });

  it('does not match ordinary chat text', () => {
    expect(isSystemNotice('你好，今天天气不错')).toBe(false);
    // 用户文本以 [OpenClaw] 开头也会被拦——这是静默丢弃语义的一部分
    expect(isSystemNotice('[OpenClaw] 里的文字是用户发的')).toBe(true);
    expect(isSystemNotice('正常回复 [OpenClaw] 中间出现')).toBe(false);
    expect(isSystemNotice('')).toBe(false);
    expect(isSystemNotice('   ')).toBe(false);
  });
});

describe('sendText — muteSystemNotices', () => {
  const oldFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
  });

  it('silently drops a muted system notice: no fetch call, no error', async () => {
    const res = await sendText({
      to: 'private:123',
      text: '[OpenClaw] Request received, processing...',
      account: mkAccount(),
    });

    expect(res.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });

  it('silently drops a 💾 Learned notification when muted', async () => {
    const res = await sendText({
      to: 'private:123',
      text: '💾 Learned: created view-chat-image (Recurring: ...)',
      account: mkAccount(),
    });

    expect(res.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });

  it('does not send the notice even when it targets the whitelisted group', async () => {
    const res = await sendText({
      to: 'group:806966728',
      text: '[OpenClaw] Error: something broke',
      account: mkAccount({ outboundAllow: ['group:806966728'] }),
    });

    expect(res.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });

  it('sends normally when muteSystemNotices is disabled', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9 } }),
    });

    const res = await sendText({
      to: 'private:123',
      text: '[OpenClaw] Request received, processing...',
      account: mkAccount({ muteSystemNotices: false }),
    });

    expect(res.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_private_msg$/);
  });

  it('sends ordinary text normally when muted is enabled', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 10 } }),
    });

    const res = await sendText({
      to: 'private:123',
      text: '今天的天气真不错',
      account: mkAccount(),
    });

    expect(res.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });
});
