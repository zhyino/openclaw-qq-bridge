import { describe, expect, it } from 'vitest';
import { buildInboundContext } from '../src/gateway/inbound.js';
import { makeAccount } from './helpers/fixtures.js';

const OWNER = '10001';
const GF = '10002';

function makeSummary(senderId: string, senderName: string, isGroup = true) {
  return {
    first: { event: { message_id: 1, time: 1700000000 } },
    last: { event: { message_id: 1, time: 1700000000 } },
    event: {
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      message_id: 1,
      user_id: Number(senderId),
      group_id: isGroup ? 100200 : undefined,
      message: [{ type: 'text', data: { text: 'hi' } }],
      raw_message: 'hi',
      sender: { user_id: Number(senderId), nickname: senderName },
      self_id: 999,
      time: 1700000000,
    },
    isGroup,
    senderId,
    senderName,
    peerId: isGroup ? `group:100200` : `private:${senderId}`,
    address: isGroup ? `onebot:group:100200` : `onebot:private:${senderId}`,
    combinedText: 'hi',
    combinedImages: [],
    combinedRecordSegments: [],
  } as any;
}

const pluginRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: () => ({ sessionKey: 's', accountId: 'default', agentId: 'main' }),
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({ mode: 'raw' }),
      formatInboundEnvelope: (args: any) => `[${args.from}] ${args.body}`,
      finalizeInboundContext: (args: any) => args,
    },
  },
} as any;

describe('inbound sender identity (IsOwner / userLabels)', () => {
  it('marks the owner with IsOwner:true and appends （主人） to the sender name', () => {
    const account = makeAccount({ ownerQQ: OWNER, userLabels: { [OWNER]: '主人', [GF]: '女朋友' } });
    const { ctxPayload } = buildInboundContext({
      pluginRuntime,
      cfg: {},
      summary: makeSummary(OWNER, '主人昵称'),
      accountId: 'default',
      accountAllowFrom: account.allowFrom,
      account,
      body: 'hi',
      voiceMedia: [],
    });

    expect(ctxPayload.IsOwner).toBe(true);
    expect(ctxPayload.SenderName).toBe('主人昵称（主人）');
  });

  it('appends a configured userLabel for a non-owner', () => {
    const account = makeAccount({ ownerQQ: OWNER, userLabels: { [OWNER]: '主人', [GF]: '女朋友' } });
    const { ctxPayload } = buildInboundContext({
      pluginRuntime,
      cfg: {},
      summary: makeSummary(GF, '女友昵称'),
      accountId: 'default',
      accountAllowFrom: account.allowFrom,
      account,
      body: 'hi',
      voiceMedia: [],
    });

    expect(ctxPayload.IsOwner).toBe(false);
    expect(ctxPayload.SenderName).toBe('女友昵称（女朋友）');
  });

  it('leaves the name untouched when no label matches', () => {
    const account = makeAccount({ ownerQQ: OWNER, userLabels: { [OWNER]: '主人' } });
    const { ctxPayload } = buildInboundContext({
      pluginRuntime,
      cfg: {},
      summary: makeSummary('10003', '测试机器人'),
      accountId: 'default',
      accountAllowFrom: account.allowFrom,
      account,
      body: 'hi',
      voiceMedia: [],
    });

    expect(ctxPayload.IsOwner).toBe(false);
    expect(ctxPayload.SenderName).toBe('测试机器人');
  });

  it('handles a missing account gracefully (IsOwner:false, no label)', () => {
    const { ctxPayload } = buildInboundContext({
      pluginRuntime,
      cfg: {},
      summary: makeSummary(OWNER, '主人'),
      accountId: 'default',
      accountAllowFrom: undefined,
      account: undefined,
      body: 'hi',
      voiceMedia: [],
    });

    expect(ctxPayload.IsOwner).toBe(false);
    expect(ctxPayload.SenderName).toBe('主人');
  });

  it('labels appear in the formatted envelope body too', () => {
    const account = makeAccount({ ownerQQ: OWNER, userLabels: { [OWNER]: '主人' } });
    const { ctxPayload } = buildInboundContext({
      pluginRuntime,
      cfg: {},
      summary: makeSummary(OWNER, '主人昵称', false),
      accountId: 'default',
      accountAllowFrom: account.allowFrom,
      account,
      body: 'hi',
      voiceMedia: [],
    });

    // formatInboundEnvelope mock returns `[from] body` — from carries the label.
    expect(ctxPayload.Body).toContain('（主人）');
  });
});
