import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onebotPlugin } from '../src/channel.js';

describe('channel plugin shape', () => {
  const oldFetch = globalThis.fetch;
  const defaultSharedDir = process.env.ONEBOT_SHARED_DIR ?? join(homedir(), 'napcat', 'shared');

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
  });

  it('has correct id and meta', () => {
    expect(onebotPlugin.id).toBe('onebot');
    expect(onebotPlugin.meta.id).toBe('onebot');
    expect(onebotPlugin.meta.label).toMatch(/OneBot/);
  });

  it('capabilities: media=true, reactions=true, blockStreaming=true', () => {
    expect(onebotPlugin.capabilities.media).toBe(true);
    expect(onebotPlugin.capabilities.reactions).toBe(true);
    expect(onebotPlugin.capabilities.blockStreaming).toBe(true);
    expect(onebotPlugin.streaming!.blockStreamingCoalesceDefaults).toEqual({
      minChars: 80,
      idleMs: 600,
    });
  });

  it('normalizeTarget strips onebot: prefix and returns string', () => {
    const res = onebotPlugin.messaging!.normalizeTarget!('onebot:private:123');
    expect(res).toBe('private:123');
  });

  it('normalizeTarget passes through non-prefixed target', () => {
    expect(onebotPlugin.messaging!.normalizeTarget!('group:456')).toBe('group:456');
  });

  it('normalizeTarget is case-insensitive for prefix', () => {
    expect(onebotPlugin.messaging!.normalizeTarget!('OneBot:group:789')).toBe('group:789');
  });

  it('looksLikeId recognizes valid ids', () => {
    const looks = onebotPlugin.messaging!.targetResolver!.looksLikeId!;
    expect(looks('private:123')).toBe(true);
    expect(looks('group:456')).toBe(true);
    expect(looks('onebot:private:123')).toBe(true);
    expect(looks('789')).toBe(true);
  });

  it('looksLikeId rejects invalid ids', () => {
    const looks = onebotPlugin.messaging!.targetResolver!.looksLikeId!;
    expect(looks('abc')).toBe(false);
    expect(looks('private:abc')).toBe(false);
    expect(looks('group:')).toBe(false);
  });

  it('isConfigured requires wsUrl and httpUrl', () => {
    const isConfigured = onebotPlugin.config!.isConfigured!;
    expect(isConfigured({ wsUrl: 'ws://x', httpUrl: 'http://y' } as any, {})).toBe(true);
    expect(isConfigured({ wsUrl: 'ws://x' } as any, {})).toBe(false);
    expect(isConfigured({ httpUrl: 'http://y' } as any, {})).toBe(false);
  });

  it('describeAccount returns expected snapshot fields', () => {
    const snap = onebotPlugin.config!.describeAccount!(
      { accountId: 'default', name: 'QQ', enabled: true, wsUrl: 'ws://x', httpUrl: 'http://y' } as any,
      {},
    );

    expect(snap.accountId).toBe('default');
    expect(snap.enabled).toBe(true);
    expect(snap.configured).toBe(true);
  });
  it('setup.validateInput checks token or useEnv', () => {
    const validate = onebotPlugin.setup!.validateInput!;
    expect(validate({ input: {} } as any)).toMatch(/requires --token/);
    expect(validate({ input: { token: 'ws,http' } } as any)).toBeNull();
    expect(validate({ input: { useEnv: true } } as any)).toBeNull();
  });

  it('setup.applyAccountConfig splits token and passes to config', () => {
    const apply = onebotPlugin.setup!.applyAccountConfig!;
    const res1 = apply({ cfg: {}, accountId: 'default', input: { token: 'ws://a,http://b' } } as any);
    expect((res1 as any).channels.onebot.wsUrl).toBe('ws://a');
    expect((res1 as any).channels.onebot.sharedDir).toBe(defaultSharedDir);
    expect((res1 as any).channels.onebot.containerSharedDir).toBe('/shared');
    const res2 = apply({ cfg: {}, accountId: 'default', input: { token: 'ws://a,http://b,TOKEN123', name: 'QQBot' } } as any);
    expect((res2 as any).channels.onebot.accessToken).toBe('TOKEN123');
    expect((res2 as any).channels.onebot.name).toBe('QQBot');
  });

  it('setup.applyAccountConfig accepts explicit shared-dir inputs', () => {
    const apply = onebotPlugin.setup!.applyAccountConfig!;
    const res = apply({
      cfg: {},
      accountId: 'default',
      input: {
        token: 'ws://a,http://b',
        sharedDir: '/tmp/napcat-shared',
        containerSharedDir: '/napcat-shared',
      },
    } as any);

    expect((res as any).channels.onebot.sharedDir).toBe('/tmp/napcat-shared');
    expect((res as any).channels.onebot.containerSharedDir).toBe('/napcat-shared');
  });

  it('setup.applyAccountConfig accepts shared-dir values in token format', () => {
    const apply = onebotPlugin.setup!.applyAccountConfig!;
    const res = apply({
      cfg: {},
      accountId: 'default',
      input: {
        token: 'ws://a,http://b,TOKEN123,/tmp/napcat-shared,/napcat-shared',
      },
    } as any);

    expect((res as any).channels.onebot.accessToken).toBe('TOKEN123');
    expect((res as any).channels.onebot.sharedDir).toBe('/tmp/napcat-shared');
    expect((res as any).channels.onebot.containerSharedDir).toBe('/napcat-shared');
  });

  it('actions.react sends set_msg_emoji_like using current message context', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: null }),
    }, {});

    const result = await onebotPlugin.actions!.handleAction!({
      action: 'react',
      cfg: {
        channels: {
          onebot: {
            httpUrl: 'http://127.0.0.1:3001',
            wsUrl: 'ws://127.0.0.1:3000',
          },
        },
      },
      params: { emoji: 128077 },
      toolContext: { currentMessageId: '5566' },
    } as any);

    expect(result.details).toMatchObject({ ok: true, channel: 'onebot', action: 'react' });
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/set_msg_emoji_like$/);
    const body = JSON.parse(init.body);
    expect(body.message_id).toBe(5566);
    expect(body.emoji_id).toBe(128077);
  });

  it('actions.react validates missing args', async () => {
    const result = await onebotPlugin.actions!.handleAction!({
      action: 'react',
      cfg: {},
      params: {},
      toolContext: {},
    } as any);

    expect(result.details).toMatchObject({ ok: false, channel: 'onebot', action: 'react' });
    expect(String((result.details as any).error)).toMatch(/emoji/);
  });
});
