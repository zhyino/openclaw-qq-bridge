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

const COMMAND_CASES = [
  '/help',
  '/commands',
  '/status',
  '/new',
  '/reset',
  '/model anthropic/claude-sonnet-4-6',
  '/think high',
  '/verbose on',
  '/reasoning medium',
  '/context',
  '/whoami',
];

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

describe('gateway command passthrough', () => {
  beforeEach(() => {
    runtimeState = createMockRuntime({ nextDeliverPayload: { text: 'ok' } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(COMMAND_CASES)('forwards %s through the OpenClaw text-command path', async (commandText) => {
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

    runtimeState.state.lastFinalizeArgs = null;
    runtimeState.state.lastDispatchArgs = null;

    wsServer.sendToAll(makePrivateMsg(777, commandText));

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, { timeout: 5000 });

    expect(runtimeState.state.lastFinalizeArgs.CommandBody).toBe(commandText);
    expect(runtimeState.state.lastFinalizeArgs.CommandAuthorized).toBe(true);
    expect(runtimeState.state.lastFinalizeArgs.CommandSource).toBe('text');

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('drops /reset sent by a group member entirely (never reaches the agent)', async () => {
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
        // 群被放行，但群成员 QQ 号不在 allowFrom 里
        allowFrom: ['group:100200'],
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
    runtimeState.state.lastFinalizeArgs = null;
    runtimeState.state.lastDispatchArgs = null;

    // 群友 55555 发 /reset
    wsServer.sendToAll(makeGroupMsg(55555, 100200, '/reset'));

    // 命令被整体丢弃：不 dispatch，不进 agent
    await new Promise((r) => setTimeout(r, 1800));
    expect(runtimeState.state.lastDispatchArgs).toBeNull();
    expect(runtimeState.state.lastFinalizeArgs).toBeNull();

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('authorizes /reset sent by an individually listed QQ id inside a listed group', async () => {
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
        allowFrom: ['10001', 'group:100200'],
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
    runtimeState.state.lastFinalizeArgs = null;
    runtimeState.state.lastDispatchArgs = null;

    wsServer.sendToAll(makeGroupMsg(10001, 100200, '/reset'));

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, { timeout: 5000 });

    expect(runtimeState.state.lastFinalizeArgs.CommandAuthorized).toBe(true);

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('does NOT forward ANY slash command from an unprivileged group member (not just /reset)', async () => {
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

    for (const cmd of ['/new', '/model gpt-5', '/think high', '/help', '/context', '/whoami', '/verbose on']) {
      runtimeState.state.lastDispatchArgs = null;
      wsServer.sendToAll(makeGroupMsg(55555, 100200, cmd));
      // 给 batcher 一点时间；不该有任何 dispatch
      await new Promise((r) => setTimeout(r, 1800));
      expect(runtimeState.state.lastDispatchArgs, `${cmd} must NOT reach the agent`).toBeNull();
    }

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('forwards slash commands from an individually authorized sender in a group', async () => {
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
        allowFrom: ['10001', 'group:100200'],
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

    for (const cmd of ['/reset', '/new', '/model gpt-5']) {
      runtimeState.state.lastDispatchArgs = null;
      wsServer.sendToAll(makeGroupMsg(10001, 100200, cmd));
      await vi.waitFor(() => {
        expect(runtimeState.state.lastDispatchArgs, `${cmd} must reach the agent`).not.toBeNull();
      }, { timeout: 5000 });
    }

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('does NOT forward slash commands from an unprivileged PRIVATE sender', async () => {
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
        // 群放行，但私聊只放行 10001
        allowFrom: ['private:10001', 'group:100200'],
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
    wsServer.sendToAll(makePrivateMsg(99999, '/reset'));
    await new Promise((r) => setTimeout(r, 1800));
    expect(runtimeState.state.lastDispatchArgs).toBeNull();

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('falls back gracefully on older runtimes without channel.commands helpers', async () => {
    const legacyRuntime = createMockRuntime({ nextDeliverPayload: { text: 'ok' } });
    delete (legacyRuntime.runtime.channel as { commands?: unknown }).commands;
    runtimeState = legacyRuntime;

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
    wsServer.sendToAll(makePrivateMsg(888, '/status'));

    await vi.waitFor(() => {
      expect(legacyRuntime.state.lastDispatchArgs).not.toBeNull();
    }, { timeout: 5000 });

    expect(legacyRuntime.state.lastFinalizeArgs.CommandAuthorized).toBe(true);

    ac.abort();
    await runP;
    await wsServer.close();
  });
});
