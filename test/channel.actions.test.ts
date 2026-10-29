import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reactToMessage, sendImage, sendRecord, sendText, uploadFile } = vi.hoisted(() => ({
  reactToMessage: vi.fn(),
  sendImage: vi.fn(),
  sendRecord: vi.fn(),
  sendText: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock('../src/outbound.js', () => ({
  reactToMessage,
  sendImage,
  sendRecord,
  sendText,
  uploadFile,
}));

// H1 fix: the media path now passes through the policy gate. Tests that
// exercise sendMedia must let the gate pass (the gate itself is covered by
// test/policy.test.ts).
vi.mock('../src/policy.js', () => ({
  assertOutboundAllowed: () => ({ allowed: true }),
  assertSafeMediaPath: (_account: unknown, p: string) => p,
}));

import { onebotPlugin } from '../src/channel.js';
import { makeAccount } from './helpers/fixtures.js';

describe('channel actions', () => {
  beforeEach(() => {
    reactToMessage.mockReset();
    sendImage.mockReset();
    sendRecord.mockReset();
    sendText.mockReset();
    uploadFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises the react action only', () => {
    expect(onebotPlugin.actions?.describeMessageTool?.({
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any)).toEqual({ actions: ['react'] });
    expect(onebotPlugin.actions?.supportsAction?.({ action: 'react' } as any)).toBe(true);
    expect(onebotPlugin.actions?.supportsAction?.({ action: 'wave' } as any)).toBe(false);
  });

  it('hides message-tool actions when the account is not configured', () => {
    expect(onebotPlugin.actions?.describeMessageTool?.({
      cfg: {},
    } as any)).toBeNull();
  });

  it('rejects unsupported actions and missing reaction params', async () => {
    const unsupported = await onebotPlugin.actions!.handleAction!({
      action: 'wave',
      cfg: {},
      params: {},
      accountId: 'default',
      toolContext: {},
    } as any);
    expect(unsupported.details).toMatchObject({ ok: false, channel: 'onebot', action: 'wave' });
    expect(String((unsupported.details as any).error)).toMatch(/Unsupported OneBot action/);

    const missing = await onebotPlugin.actions!.handleAction!({
      action: 'react',
      cfg: {},
      params: {},
      accountId: 'default',
      toolContext: {},
    } as any);
    expect(missing.details).toMatchObject({ ok: false, channel: 'onebot', action: 'react' });
    expect(String((missing.details as any).error)).toMatch(/requires `emoji` and `message_id`/);
  });

  it('forwards successful reactions and reports failures', async () => {
    reactToMessage.mockResolvedValueOnce({
      ok: true,
      messageId: '123',
      emojiId: '128077',
    });

    const success = await onebotPlugin.actions!.handleAction!({
      action: 'react',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
      params: {
        message_id: '123',
        emoji: '128077',
      },
      accountId: 'default',
      toolContext: {},
    } as any);

    expect(success.details).toMatchObject({ ok: true, channel: 'onebot', action: 'react' });
    expect(reactToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'default' }),
      '123',
      '128077',
    );

    reactToMessage.mockResolvedValueOnce({
      ok: false,
      error: 'reaction failed',
    });

    const failure = await onebotPlugin.actions!.handleAction!({
      action: 'react',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
      params: {
        messageId: '555',
        reaction: '1',
      },
      accountId: 'default',
      toolContext: {},
    } as any);

    expect(failure.details).toMatchObject({ ok: false, channel: 'onebot', action: 'react' });
    expect(String((failure.details as any).error)).toMatch(/reaction failed/);
  });

  it('routes outbound text through resolved OneBot accounts', async () => {
    sendText.mockResolvedValueOnce({
      channel: 'onebot',
      messageId: 'out-1',
      error: undefined,
    });

    const result = await onebotPlugin.outbound!.sendText!({
      to: 'private:42',
      text: 'hello',
      accountId: 'default',
      replyToId: 'r1',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      to: 'private:42',
      text: 'hello',
      replyToId: 'r1',
      account: expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
    }));
    expect(result.messageId).toBe('out-1');

    sendText.mockResolvedValueOnce({
      channel: 'onebot',
      messageId: 'out-2',
      error: 'send failed',
    });

    const failed = onebotPlugin.outbound!.sendText!({
      to: 'private:42',
      text: 'hello',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    await expect(failed).rejects.toThrow(/send failed/);
  });

  it('routes outbound image media through sendImage and sends caption text separately', async () => {
    sendImage.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: { message_id: 99 },
    });
    sendText.mockResolvedValueOnce({
      channel: 'onebot',
      messageId: 'caption-1',
      error: undefined,
    });

    const result = await onebotPlugin.outbound!.sendMedia!({
      to: 'onebot:private:42',
      text: 'caption',
      mediaUrl: 'file:///tmp/My%20Image.png',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(sendImage).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      'private',
      42,
      '/tmp/My Image.png',
    );
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      to: 'onebot:private:42',
      text: 'caption',
      account: expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
    }));
    expect(result).toMatchObject({ channel: 'onebot', messageId: '99' });
  });

  it('routes outbound audio media through sendRecord', async () => {
    sendRecord.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: { message_id: 101 },
    });

    const result = await onebotPlugin.outbound!.sendMedia!({
      to: 'group:77',
      text: '',
      mediaUrl: '/tmp/reply.m4a',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      'group',
      77,
      '/tmp/reply.m4a',
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ channel: 'onebot', messageId: '101' });
  });

  it('routes non-image media through uploadFile using the basename', async () => {
    uploadFile.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: {},
    });

    const result = await onebotPlugin.outbound!.sendMedia!({
      to: 'private:42',
      mediaUrl: '/tmp/archive/report final.pdf',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      'private',
      42,
      '/tmp/archive/report final.pdf',
      'report final.pdf',
    );
    expect(result.channel).toBe('onebot');
    expect(typeof result.messageId).toBe('string');
  });

  it('rejects remote media URLs for outbound sendMedia', async () => {
    const attempt = onebotPlugin.outbound!.sendMedia!({
      to: 'private:42',
      mediaUrl: 'https://example.com/file.png',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    await expect(attempt).rejects.toThrow(/local file paths only/);
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendRecord).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('builds status snapshots from runtime state', () => {
    const snapshot = onebotPlugin.status!.buildAccountSnapshot!({
      account: makeAccount({
        accountId: 'default',
        name: 'QQ',
        enabled: true,
        wsUrl: 'ws://127.0.0.1:3000',
        httpUrl: 'http://127.0.0.1:3001',
      }),
      runtime: {
        running: true,
        connected: true,
        lastConnectedAt: 123,
        lastError: 'none',
      },
    } as any);

    expect(snapshot).toEqual(expect.objectContaining({
      accountId: 'default',
      name: 'QQ',
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lastConnectedAt: 123,
      lastError: 'none',
    }));
  });
});
