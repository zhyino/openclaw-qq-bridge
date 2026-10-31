import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startMockOneBotWsServer } from './helpers/mock-ws-server.js';
import { createMockRuntime } from './helpers/mock-runtime.js';
import { makeAccount } from './helpers/fixtures.js';

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

function makePrivateMsg(userId: number, text: string) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: Math.floor(Math.random() * 100000),
    user_id: userId,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: userId, nickname: `User${userId}` },
    self_id: 999,
    time: Math.floor(Date.now() / 1000),
  };
}

describe('gateway reply delay (replyDelaySec)', () => {
  beforeEach(() => {
    runtimeState = createMockRuntime({ nextDeliverPayload: { text: 'ok' } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delays the dispatch by the configured seconds', async () => {
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
        allowFrom: ['private:777'],
        replyDelaySec: 2,
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

    const t0 = Date.now();
    wsServer.sendToAll(makePrivateMsg(777, 'hi'));

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, { timeout: 8000 });

    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1800); // >= ~2s delay

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('dispatches immediately when replyDelaySec is 0', async () => {
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
        allowFrom: ['private:888'],
        replyDelaySec: 0,
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

    const t0 = Date.now();
    wsServer.sendToAll(makePrivateMsg(888, 'hi'));

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, { timeout: 5000 });

    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1800);

    ac.abort();
    await runP;
    await wsServer.close();
  });
});
