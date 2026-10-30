import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildQzoneAndProfileTools } from "../src/qzone-tools.js";
import type { ResolvedOneBotAccount } from "../src/types.js";

function mkAccount(overrides?: Partial<ResolvedOneBotAccount>): ResolvedOneBotAccount {
  return {
    accountId: "default",
    enabled: true,
    wsUrl: "ws://127.0.0.1:1",
    httpUrl: "http://127.0.0.1:8080",
    qzoneWrite: true,
    replyAudit: true,
    mediaAllowDirs: [],
    config: {},
    ...overrides,
  } as ResolvedOneBotAccount;
}

const READ_TOOLS = ["qq_qzone_list", "qq_qzone_feeds", "qq_qzone_detail"];

const WRITE_TOOLS = [
  "qq_qzone_send",
  "qq_qzone_delete",
  "qq_qzone_like",
  "qq_qzone_unlike",
  "qq_qzone_comment",
  "qq_profile_set",
  "qq_online_status_set",
];

describe("qzone-tools", () => {
  const oldFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
  });

  it("registers read tools always; write tools only when qzoneWrite=true", () => {
    // qzoneWrite=false → 只有读工具
    const readOnly = buildQzoneAndProfileTools(mkAccount({ qzoneWrite: false }));
    expect(readOnly.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const w of WRITE_TOOLS) {
      expect(readOnly.some((t) => t.name === w)).toBe(false);
    }

    // qzoneWrite=true → 全部 10 个
    const all = buildQzoneAndProfileTools(mkAccount({ qzoneWrite: true }));
    expect(all.map((t) => t.name).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
    for (const t of all) {
      expect(t.label).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(typeof t.execute).toBe("function");
    }
  });

  it("returns [] when account is disabled", () => {
    expect(buildQzoneAndProfileTools(mkAccount({ enabled: false }))).toEqual([]);
  });

  async function runTool(name: string, params: Record<string, unknown>) {
    const tools = buildQzoneAndProfileTools(mkAccount({ qzoneWrite: true }));
    const tool = tools.find((t) => t.name === name)!;
    expect(tool).toBeDefined();
    return tool.execute("call-1", params as never) as Promise<{
      content?: Array<{ type?: string; text?: string }>;
      details?: { ok?: boolean; data?: unknown; error?: unknown; action?: unknown };
    }>;
  }

  function mockOk(data: unknown) {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ status: "ok", retcode: 0, data }),
    });
  }

  function lastCall() {
    const [url, init] = (globalThis.fetch as any).mock.calls.at(-1);
    return { url, body: JSON.parse(init.body) };
  }

  it("qq_qzone_list: GET own space (no target_uin)", async () => {
    mockOk({ total: 2, msglist: [{ tid: "t1", content: "hi" }] });
    const res = await runTool("qq_qzone_list", { num: 20 });
    const { url, body } = lastCall();
    expect(url).toContain("/get_qzone_msg_list");
    expect(body).toEqual({ target_uin: undefined, pos: 0, num: 20 });
    expect(res.details?.ok).toBe(true);
  });

  it("qq_qzone_list: view a friend's space via target_uin", async () => {
    mockOk({ total: 0, msglist: [] });
    await runTool("qq_qzone_list", { target_uin: "10001" });
    const { body } = lastCall();
    expect(body.target_uin).toBe("10001");
  });

  it("qq_qzone_send: publishes text-only qzone message", async () => {
    mockOk({ tid: "new-tid", time: 1700000000 });
    const res = await runTool("qq_qzone_send", { content: "今天的学习记录" });
    const { url, body } = lastCall();
    expect(url).toContain("/send_qzone_msg");
    expect(body.content).toBe("今天的学习记录");
    expect(body.ugc_right).toBe(1);
    expect(res.details?.data).toEqual({ tid: "new-tid", time: 1700000000 });
    expect(res.details?.action).toBe("send_qzone_msg");
  });

  it("qq_qzone_send: rejects http images (N-02 SSRF guard)", async () => {
    mockOk({ tid: "t2", time: 1700000001 });
    const res = await runTool("qq_qzone_send", {
      content: "带图",
      images: ["https://example.com/a.png"],
      ugc_right: 64,
    });
    expect(res.details?.ok).toBe(false);
    expect(String(res.content?.[0]?.text ?? "")).toContain("local files only");
  });

  it("qq_qzone_feeds: fetches friend feeds with cursor", async () => {
    mockOk({ feeds: [], has_more: false, next_cursor: null });
    await runTool("qq_qzone_feeds", { cursor: "abc" });
    const { url, body } = lastCall();
    expect(url).toContain("/get_qzone_feeds");
    expect(body.cursor).toBe("abc");
  });

  it("qq_qzone_like: likes a friend's post", async () => {
    mockOk({});
    await runTool("qq_qzone_like", { tid: "t9", target_uin: "10002" });
    const { url, body } = lastCall();
    expect(url).toContain("/like_qzone");
    expect(body.target_uin).toBe("10002");
  });

  it("qq_profile_set: sets personal note (signature)", async () => {
    mockOk(null);
    const res = await runTool("qq_profile_set", { personal_note: "新签名" });
    const { url, body } = lastCall();
    expect(url).toContain("/set_qq_profile");
    expect(body.personal_note).toBe("新签名");
    expect(res.details?.ok).toBe(true);
  });

  it("qq_online_status_set: sets DIY online status", async () => {
    mockOk(null);
    await runTool("qq_online_status_set", { wording: "学习中" });
    const { url, body } = lastCall();
    expect(url).toContain("/set_diy_online_status");
    expect(body.wording).toBe("学习中");
    expect(body.face_id).toBe(14);
  });

  it("propagates OneBot retcode errors as failed result", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        status: "failed",
        retcode: 100,
        message: "风控",
        wording: "频率限制",
      }),
    });
    const res = await runTool("qq_qzone_send", { content: "x" });
    expect(res.details?.ok).toBe(false);
    expect(String(res.content?.[0]?.text ?? "")).toContain("风控");
  });

  it("propagates network errors as failed result (no throw)", async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await runTool("qq_qzone_feeds", {});
    expect(res.details?.ok).toBe(false);
    expect(String(res.content?.[0]?.text ?? "")).toContain("ECONNREFUSED");
  });

  it("rejects local image paths outside media roots (V-02 guard)", async () => {
    mockOk({ tid: "t3", time: 1 });
    const res = await runTool("qq_qzone_send", {
      content: "带图",
      images: ["file:///etc/hostname"],
    });
    expect(res.details?.ok).toBe(false);
    expect(String(res.content?.[0]?.text ?? "")).toContain("media path not allowed");
  });

  it("accepts a real file inside media roots via file:// URI (N-01)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");

    const dir = mkdtempSync(join(tmpdir(), "qzone-media-"));
    const file = join(dir, "a.png");
    writeFileSync(file, "png-bytes");
    try {
      mockOk({ tid: "t4", time: 1 });
      // runTool 用默认 account；这里需要把 tmp 目录加进 mediaAllowDirs。
      // 直接调用 buildQzoneAndProfileTools 并传覆盖后的 account。
      const tools = buildQzoneAndProfileTools(
        mkAccount({ qzoneWrite: true, mediaAllowDirs: [dir] }),
      );
      const tool = tools.find((t) => t.name === "qq_qzone_send")!;
      const res = (await tool.execute("call-1", {
        content: "带图",
        images: [pathToFileURL(file).toString()],
      } as never)) as {
        content?: Array<{ type?: string; text?: string }>;
        details?: { ok?: boolean };
      };
      expect(res.details?.ok).toBe(true);
      const { body } = lastCall();
      expect(body.images[0]).toContain("a.png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("qq_qzone_send: blocks sensitive content when replyAudit is on (default)", async () => {
    mockOk({ tid: "t5", time: 1 });
    const res = await runTool("qq_qzone_send", { content: "路径是 /etc/hostname" });
    expect(res.details?.ok).toBe(false);
    expect(String(res.content?.[0]?.text ?? "")).toContain("reply audit");
  });

  it("qq_qzone_send: skips audit when replyAudit is disabled (S-02)", async () => {
    mockOk({ tid: "t6", time: 1 });
    // replyAudit:false 时，即使内容含路径也放行（与消息通道一致）
    const tools = buildQzoneAndProfileTools(mkAccount({ qzoneWrite: true, replyAudit: false }));
    const tool = tools.find((t) => t.name === "qq_qzone_send")!;
    const res = (await tool.execute("call-1", {
      content: "路径是 /etc/hostname",
    } as never)) as {
      content?: Array<{ type?: string; text?: string }>;
      details?: { ok?: boolean };
    };
    expect(res.details?.ok).toBe(true);
  });

  it("qq_profile_set: blocks sensitive signature when replyAudit is on (S-04)", async () => {
    mockOk(null);
    const res = await runTool("qq_profile_set", { personal_note: "sk-ABCDEFGHIJKLMNOPQRST" });
    expect(res.details?.ok).toBe(false);
    expect(String(res.content?.[0]?.text ?? "")).toContain("reply audit");
  });
});
