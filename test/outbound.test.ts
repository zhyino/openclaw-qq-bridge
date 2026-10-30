import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { sendText, sendImage, sendRecord, uploadFile, reactToMessage } from '../src/outbound.js';
import type { ResolvedOneBotAccount } from '../src/types.js';


function ensureTestFile(p: string): string {
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'test-content');
  }
  return p;
}

// Every fixture lives under this sandbox; nothing is written into the repo
// (v0.2.1 shipped a.png / a.mp3 because these tests used process.cwd()).
const SANDBOX = mkdtempSync(join(tmpdir(), 'onebot-outbound-'));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

const TEST_MEDIA_DIRS = [tmpdir(), SANDBOX];

function mkAccount(overrides?: Partial<ResolvedOneBotAccount>): ResolvedOneBotAccount {
  const base = {
    accountId: 'default',
    enabled: true,
    wsUrl: 'ws://x',
    httpUrl: 'http://127.0.0.1:1',
    config: {},
    mediaAllowDirs: TEST_MEDIA_DIRS,
    ...overrides,
  };
  // keep config.mediaAllowDirs in sync
  base.config = { mediaAllowDirs: base.mediaAllowDirs ?? [], ...(base.config ?? {}) };
  return base as any;
}

describe('outbound', () => {
  const oldFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
  });

  it('sendText: defaults raw number target to private', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9 } }),
    });

    const res = await sendText({ to: '123', text: 'hi', account: mkAccount() });
    expect(res.error).toBeUndefined();

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_private_msg$/);
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(123);
    expect(body.message[0].type).toBe('text');
  });

  it('sendText: private target uses send_private_msg', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }),
    });

    await sendText({ to: 'private:123', text: 'hello', account: mkAccount() });
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_private_msg$/);
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(123);
  });

  it('sendText: group target uses send_group_msg', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 2 } }),
    });

    await sendText({ to: 'onebot:group:456', text: 'yo', account: mkAccount() });
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_group_msg$/);
    const body = JSON.parse(init.body);
    expect(body.group_id).toBe(456);
  });

  it('sendText: handles API retcode failures', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'failed', retcode: 100, data: null, message: 'bad' }),
    });

    const res = await sendText({ to: 'private:1', text: 'x', account: mkAccount() });
    expect(res.error).toMatch(/returned error/);
  });

  it('sendText: handles non-200 response', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Oops',
      json: async () => ({}),
    });

    const res = await sendText({ to: 'private:1', text: 'x', account: mkAccount() });
    expect(res.error).toMatch(/500/);
  });

  it('sendText: handles network error', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('net down'));
    const res = await sendText({ to: 'private:1', text: 'x', account: mkAccount() });
    expect(res.error).toMatch(/net down/);
  });

  it('sendText: missing httpUrl returns error', async () => {
    const res = await sendText({ to: 'private:1', text: 'x', account: mkAccount({ httpUrl: '' }) });
    expect(res.error).toMatch(/missing httpUrl/);
  });

  it('sendImage: preserves direct file uri for non-staged paths', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 3 } }),
    });

    await sendImage(mkAccount(), 'private', 1, ensureTestFile(join(tmpdir(), 'a.png')));
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(1);
    expect(body.message[0].type).toBe('image');
    expect(body.message[0].data.file).toMatch(/^file:\/\/\/shared\/openclaw\/images\//);
  });

  it('sendRecord: sends record segment', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 4 } }),
    });

    await sendRecord(mkAccount(), 'group', 9, ensureTestFile(join(tmpdir(), 'a.mp3')));
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_group_msg$/);
    const body = JSON.parse(init.body);
    expect(body.group_id).toBe(9);
    expect(body.message[0].type).toBe('record');
  });

  it('sendRecord: stages absolute host files into the container shared dir', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 4 } }),
    });

    const root = mkdtempSync(join(tmpdir(), 'onebot-record-'));
    const sharedDir = join(root, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    const source = join(root, 'voice.mp3');
    writeFileSync(source, 'voice-bytes');

    await sendRecord(
      mkAccount({
        config: { sharedDir, containerSharedDir: '/shared', mediaAllowDirs: [root, tmpdir()] } as any,
        mediaAllowDirs: [root, tmpdir()],
      }),
      'private',
      9,
      source,
    );

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.message[0].data.file).toMatch(/^file:\/\/\/shared\/openclaw\/audio\//);

    const rel = body.message[0].data.file.replace('file:///shared/', '');
    const staged = join(sharedDir, rel);
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(staged, 'utf8')).toBe('voice-bytes');
    if (process.platform !== 'win32') {
      expect(statSync(staged).mode & 0o777).toBe(0o600);
      expect(statSync(join(sharedDir, 'openclaw', 'audio')).mode & 0o777).toBe(0o700);
    }
  });

  it('uploadFile: calls upload_group_file with file uri', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: {} }),
    });

    await uploadFile(mkAccount(), 'group', 9, ensureTestFile(join(tmpdir(), 'f.zip')), 'f.zip');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/upload_group_file$/);
    const body = JSON.parse(init.body);
    expect(body.group_id).toBe(9);
    expect(body.file).toMatch(/^file:\/\/\/shared\/openclaw\/files\//);
    expect(body.name).toBe('f.zip');
  });

  it('sendText: includes Authorization header when accessToken is set', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 10 } }),
    });

    await sendText({ to: 'private:1', text: 'x', account: mkAccount({ accessToken: 'AT' }) });
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer AT');
  });

  it('sendImage: group target preserves relative file path', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 3 } }) });
    await sendImage(mkAccount(), 'group', 1, ensureTestFile(join(SANDBOX, 'a.png')));
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.group_id).toBe(1);
    expect(body.message[0].type).toBe('image');
    expect(body.message[0].data.file).toMatch(/^file:\/\/\/shared\/openclaw\/images\//);
  });

  it('sendRecord: private target works without file prefix', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 4 } }) });
    await sendRecord(mkAccount(), 'private', 9, ensureTestFile(join(SANDBOX, 'a.mp3')));
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_private_msg$/);
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(9);
    expect(body.message[0].type).toBe('record');
    expect(body.message[0].data.file).toMatch(/^file:\/\/\/shared\/openclaw\/audio\//);
  });

  it('uploadFile: calls upload_private_file with file uri', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) });
    await uploadFile(mkAccount(), 'private', 9, ensureTestFile(join(tmpdir(), 'f.zip')), 'f.zip');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/upload_private_file$/);
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(9);
    expect(body.file).toMatch(/^file:\/\/\/shared\/openclaw\/files\//);
  });

  it('reactToMessage: calls set_msg_emoji_like', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: null }),
    });

    const res = await reactToMessage(mkAccount(), '5566', '128077');
    expect(res.ok).toBe(true);

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/set_msg_emoji_like$/);
    const body = JSON.parse(init.body);
    expect(body.message_id).toBe(5566);
    expect(body.emoji_id).toBe(128077);
  });

  it('reactToMessage: surfaces API errors', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'failed', retcode: 100, data: null, message: 'bad react' }),
    });

    const res = await reactToMessage(mkAccount(), 1, 2);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/bad react/);
  });

  it('reactToMessage: returns config errors when httpUrl is missing', async () => {
    const res = await reactToMessage(mkAccount({ httpUrl: '' }), '55', '66');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing httpUrl/);
  });

  it('reactToMessage: returns thrown network errors', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('reaction network down'));
    const res = await reactToMessage(mkAccount(), '55', '66');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reaction network down/);
  });
});

describe('outbound rate limit (outboundRateLimit)', () => {
  const oldFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
  });

  // Use unique targets per test to avoid cross-test state in the module-level map.
  it('silently drops a second reply to the same target within the interval', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 7 } }),
    });

    const account = mkAccount({ outboundRateLimit: 60 });
    const to = `private:${900000 + Math.floor(Math.random() * 100000)}`;

    const first = await sendText({ to, text: 'first reply', account });
    expect(first.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);

    const second = await sendText({ to, text: 'second reply', account });
    // Rate-limited: no error, no fetch.
    expect(second.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('allows replies to different targets regardless of the interval', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 8 } }),
    });

    const account = mkAccount({ outboundRateLimit: 60 });
    const a = `private:${910000 + Math.floor(Math.random() * 100000)}`;
    const b = `private:${920000 + Math.floor(Math.random() * 100000)}`;

    await sendText({ to: a, text: 'to a', account });
    const second = await sendText({ to: b, text: 'to b', account });

    expect(second.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('exempts explicit replies (replyToId present) from the rate limit', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9 } }),
    });

    const account = mkAccount({ outboundRateLimit: 60 });
    const to = `private:${930000 + Math.floor(Math.random() * 100000)}`;

    await sendText({ to, text: 'first', account });
    const second = await sendText({ to, text: 'explicit reply', replyToId: '12345', account });

    expect(second.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('does not rate-limit when outboundRateLimit is 0 (disabled)', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 10 } }),
    });

    const account = mkAccount({ outboundRateLimit: 0 });
    const to = `private:${940000 + Math.floor(Math.random() * 100000)}`;

    await sendText({ to, text: 'one', account });
    const second = await sendText({ to, text: 'two', account });

    expect(second.error).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });
});
