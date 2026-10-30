import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMockOneBotWsServer } from './helpers/mock-ws-server.js';
import { createMockRuntime } from './helpers/mock-runtime.js';
import { makeAccount } from './helpers/fixtures.js';
import { isIgnoredSender } from '../src/policy.js';

let runtimeState: any;
vi.mock('../src/runtime.js', () => {
  return {
    getOneBotRuntime: () => runtimeState.runtime,
  };
});

vi.mock('../src/outbound.js', () => ({
  sendText: async () => ({ channel: 'onebot', messageId: 'm1' }),
  sendImage: async () => ({ status: 'ok', retcode: 0, data: {} }),
  sendRecord: async () => ({ status: 'ok', retcode: 0, data: {} }),
  reactToMessage: async () => ({ channel: 'onebot', ok: true }),
}));

function makeGroupMsg(userId: number, groupId: number, text: string) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: Math.floor(Math.random() * 100000),
    user_id: userId,
    group_id: groupId,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: userId, nickname: `User${userId}` },
    self_id: 999,
    time: Math.floor(Date.now() / 1000),
  };
}

describe('isIgnoredSender (manual ignoreFrom list)', () => {
  it('returns true for a listed QQ id', () => {
    const acct = makeAccount({ ignoreFrom: ['10003'] });
    expect(isIgnoredSender(acct, '10003')).toBe(true);
  });

  it('returns false when not listed or list is empty', () => {
    const acct = makeAccount({ ignoreFrom: ['10003'] });
    expect(isIgnoredSender(acct, '10001')).toBe(false);

    const empty = makeAccount({ ignoreFrom: [] });
    expect(isIgnoredSender(empty, '10003')).toBe(false);

    const unset = makeAccount({ ignoreFrom: undefined });
    expect(isIgnoredSender(unset, '10003')).toBe(false);
  });
});

describe('gateway bot-loop guard (ignoreBots via is_robot)', () => {
  const oldFetch = globalThis.fetch;

  beforeEach(() => {
    runtimeState = createMockRuntime({ nextDeliverPayload: { text: 'ok' } });
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
  });

  it('drops a group message from a member SnowLuma flags is_robot:true', async () => {
    // The bot lookup hits get_group_member_info; respond is_robot:true.
    (globalThis.fetch as any).mockImplementation((url: string) => {
      if (String(url).includes('/get_group_member_info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', retcode: 0, data: { is_robot: true } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });

    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        allowFrom: ['group:806966728'],
        ignoreBots: true,
        groupAutoReact: false,
        groupAutoReactEmojiId: 1,
        config: {},
      }),
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;
    runtimeState.state.lastDispatchArgs = null;

    wsServer.sendToAll(makeGroupMsg(10003, 806966728, 'hello from bot'));

    // give the async lookup + ingest time; nothing should reach the agent
    await new Promise((r) => setTimeout(r, 1800));
    expect(runtimeState.state.lastDispatchArgs).toBeNull();

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('forwards a group message from a non-bot member', async () => {
    (globalThis.fetch as any).mockImplementation((url: string) => {
      if (String(url).includes('/get_group_member_info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', retcode: 0, data: { is_robot: false } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });

    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        allowFrom: ['group:806966728'],
        ignoreBots: true,
        groupAutoReact: false,
        groupAutoReactEmojiId: 1,
        config: {},
      }),
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;
    runtimeState.state.lastDispatchArgs = null;

    wsServer.sendToAll(makeGroupMsg(10001, 806966728, 'hello human'));

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, { timeout: 5000 });

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('does not drop a message when the bot lookup fails (network error)', async () => {
    (globalThis.fetch as any).mockImplementation((url: string) => {
      if (String(url).includes('/get_group_member_info')) {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });

    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        allowFrom: ['group:806966728'],
        ignoreBots: true,
        groupAutoReact: false,
        groupAutoReactEmojiId: 1,
        config: {},
      }),
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;
    runtimeState.state.lastDispatchArgs = null;

    wsServer.sendToAll(makeGroupMsg(10003, 806966728, 'flaky lookup'));

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, { timeout: 5000 });

    ac.abort();
    await runP;
    await wsServer.close();
  });
});
