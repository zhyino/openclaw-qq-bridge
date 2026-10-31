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

describe('gateway bot-loop guard (ignoreFrom drops before dispatch)', () => {
  const oldFetch = globalThis.fetch;

  beforeEach(() => {
    runtimeState = createMockRuntime({ nextDeliverPayload: { text: 'ok' } });
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
  });

  it('drops messages from an ignoreFrom sender, forwards everyone else', async () => {
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
        allowFrom: ['group:100200'],
        ignoreFrom: ['10003'],
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

    wsServer.sendToAll(makeGroupMsg(10003, 100200, 'ignored bot says hi'));
    // Give the ingest path a beat, then assert nothing was dispatched.
    await new Promise((r) => setTimeout(r, 1200));
    expect(runtimeState.state.lastDispatchArgs).toBeNull();

    // A non-ignored member is still forwarded (same group, same window).
    wsServer.sendToAll(makeGroupMsg(10001, 100200, 'hello human'));
    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, { timeout: 5000 });

    ac.abort();
    await runP;
    await wsServer.close();
  });
});
