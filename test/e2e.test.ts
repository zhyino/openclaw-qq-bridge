import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMockOneBotWsServer } from './helpers/mock-ws-server.js';
import { startMockOneBotHttpServer } from './helpers/mock-http-server.js';
import { createMockRuntime } from './helpers/mock-runtime.js';
import { makeAccount } from './helpers/fixtures.js';

let runtimeState: any;
vi.mock('../src/runtime.js', () => {
  return {
    getOneBotRuntime: () => runtimeState.runtime,
  };
});

describe('e2e', () => {
  beforeEach(() => {
    runtimeState = createMockRuntime({ nextDeliverPayload: { text: 'e2e-reply' } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('private message -> dispatch -> outbound HTTP send_private_msg', async () => {
    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
        config: { mediaAllowDirs: [tmpdir()] },
        mediaAllowDirs: [tmpdir()],
      }),
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 2001,
      user_id: 3001,
      message: [{ type: 'text', data: { text: 'hello e2e' } }],
      raw_message: 'hello e2e',
      sender: { user_id: 3001, nickname: 'E2EUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(httpServer.requests.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const req = httpServer.requests[0];
    expect(req.url).toBe('/send_private_msg');
    expect(req.bodyJson.user_id).toBe(3001);
    expect(req.bodyJson.message[0].type).toBe('text');
    expect(req.bodyJson.message[0].data.text).toBe('e2e-reply');

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('group message -> outbound HTTP send_group_msg', async () => {
    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
        config: { mediaAllowDirs: [tmpdir()] },
        mediaAllowDirs: [tmpdir()],
      }),
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 2002,
      user_id: 3002,
      group_id: 4002,
      message: [{ type: 'text', data: { text: 'hey group' } }],
      raw_message: 'hey group',
      sender: { user_id: 3002, nickname: 'GroupUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(httpServer.requests.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const req = httpServer.requests[0];
    expect(req.url).toBe('/send_group_msg');
    expect(req.bodyJson.group_id).toBe(4002);

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('media reply: deliver mediaUrls triggers image send + text send', async () => {
    // N1: the media file must exist and be inside an allowed root.
    writeFileSync(join(tmpdir(), 'pic.png'), 'fake-png');
    runtimeState = createMockRuntime({
      nextDeliverPayload: { text: 'here', mediaUrls: [join(tmpdir(), 'pic.png')] },
    });

    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();
    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
        config: { mediaAllowDirs: [tmpdir()] },
        mediaAllowDirs: [tmpdir()],
      }),
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 2003,
      user_id: 3003,
      message: [{ type: 'text', data: { text: 'need image' } }],
      raw_message: 'need image',
      sender: { user_id: 3003, nickname: 'MediaUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => expect(httpServer.requests.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });

    const [r1, r2] = httpServer.requests;
    expect(r1.url).toBe('/send_private_msg');
    expect(r1.bodyJson.message[0].type).toBe('image');
    expect(String(r1.bodyJson.message[0].data.file)).toMatch(/^file:\/\/\/shared\/openclaw\/images\//);

    expect(r2.url).toBe('/send_private_msg');
    expect(r2.bodyJson.message[0].type).toBe('text');

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('block streaming sends multiple QQ messages in order', async () => {
    runtimeState = createMockRuntime({
      nextDeliverPayloads: [
        { text: 'stream-1' },
        { text: 'stream-2' },
      ],
    });

    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
        config: { mediaAllowDirs: [tmpdir()] },
        mediaAllowDirs: [tmpdir()],
      }),
      abortSignal: ac.signal,
      cfg: {
        agents: { defaults: { blockStreamingDefault: 'on' } },
      },
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 2004,
      user_id: 3004,
      message: [{ type: 'text', data: { text: 'stream it' } }],
      raw_message: 'stream it',
      sender: { user_id: 3004, nickname: 'StreamUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(httpServer.requests.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });

    expect(httpServer.requests[0].url).toBe('/send_private_msg');
    expect(httpServer.requests[0].bodyJson.message[0].data.text).toBe('stream-1');
    expect(httpServer.requests[1].bodyJson.message[0].data.text).toBe('stream-2');

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('reconnects after WS close and can reconnect to restarted server', async () => {
    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');
    const ac = new AbortController();

    let readyCount = 0;
    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
        config: { mediaAllowDirs: [tmpdir()] },
        mediaAllowDirs: [tmpdir()],
      }),
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => {
        readyCount++;
      },
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await vi.waitFor(() => expect(readyCount).toBe(1));

    wsServer.closeAllClients(4002, 'boom');

    // Wait for reconnect delay (>=1s)
    await new Promise((r) => setTimeout(r, 1200));

    expect(wsServer.connectionUrls.length).toBeGreaterThanOrEqual(2);

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('N2: deliver with a media path outside allowed roots is blocked (no file leak)', async () => {
    const secretFile = '/etc/hostname';
    runtimeState = createMockRuntime({
      nextDeliverPayload: { text: 'leak attempt', mediaUrls: [secretFile] },
    });

    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();
    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: makeAccount({
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
        config: { mediaAllowDirs: [tmpdir()] },
        mediaAllowDirs: [tmpdir()],
      }),
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 2004,
      user_id: 3004,
      message: [{ type: 'text', data: { text: 'send it' } }],
      raw_message: 'send it',
      sender: { user_id: 3004, nickname: 'Attacker' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => expect(httpServer.requests.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const bodies = httpServer.requests.map((r: any) => JSON.stringify(r.bodyJson));
    expect(bodies.every((b: string) => !b.includes('hostname'))).toBe(true);

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

});
