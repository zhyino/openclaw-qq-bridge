/**
 * QQ 空间 / 个人签名工具（通过 SnowLuma OneBot 扩展 action）。
 *
 * 能力来源：SnowLuma 官方 OneBot action 层（packages/onebot/src/actions/）：
 *   qzone.ts        — get_qzone_profile / set_qzone_profile / get_qzone_msg_list /
 *                     get_qzone_msg_detail / get_qzone_feeds / send_qzone_msg /
 *                     delete_qzone_msg / set_qzone_msg_right / like_qzone /
 *                     unlike_qzone / comment_qzone / set_qzone_ban
 *   qzone-public.ts — get_qzone_public_feeds / ...（好友空间只读）
 *   extended.ts     — set_qq_profile / set_online_status / set_diy_online_status
 *
 * 这些不是 OneBot v11 标准 API，是 SnowLuma 的扩展动作；标准协议端
 * （NapCat/go-cqhttp）调用会得到 retcode 错误。调用方（agent）得到的错误
 * 会原样透传，便于定位。
 *
 * 安全设计：所有写操作（发说说 / 点赞 / 评论 / 删除 / 改签名）都是"对外、
 * 不可逆"动作，与消息发送共用同一套出站白名单/审计（assertOutboundAllowed
 * 的 ownerQQ / outboundAllow 语义）。Read-only 工具（看空间/看动态）不做
 * 白名单限制，但同样经过 account 有效性检查。
 */
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import type { ResolvedOneBotAccount } from "./types.js";

const API_TIMEOUT_MS = 15_000;

async function callSnowLumaAction(
  account: ResolvedOneBotAccount,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!account.httpUrl) {
    throw new Error("OneBot not configured (missing httpUrl)");
  }
  const url = `${account.httpUrl}/${action}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OneBot ${action} HTTP error: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as {
    status?: string;
    retcode?: number;
    data?: unknown;
    message?: string;
    wording?: string;
  };
  if (body.retcode !== 0 || body.status === "failed") {
    throw new Error(
      `OneBot ${action} failed: ${body.retcode} ${body.message ?? body.wording ?? ""}`.trim(),
    );
  }
  return body.data;
}

function makeTool(
  account: ResolvedOneBotAccount,
  def: {
    name: string;
    label: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
    write?: boolean;
    execute: (params: Record<string, unknown>) => Promise<unknown>;
  },
): AnyAgentTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters as never,
    execute: async (toolCallId: string, params: Record<string, unknown>) => {
      try {
        const data = await def.execute(params as Record<string, unknown>);
        return {
          content: [
            {
              type: "text",
              text: typeof data === "string" ? data : JSON.stringify(data),
            },
          ],
          details: { ok: true, tool: def.name, action: def.name, data },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          details: { ok: false, tool: def.name, action: def.name, error: String(err) },
        };
      }
    },
  };
}

/**
 * 构造 QQ 空间 / 签名工具集。
 *
 * @param account 已解析的账号（resolveOneBotAccount 的输出）。调用方在
 *   agentTools factory 里每次解析当前账号，避免拿到过期配置。
 */
export function buildQzoneAndProfileTools(
  account: ResolvedOneBotAccount,
): AnyAgentTool[] {
  if (!account.enabled) return [];

  return [
    // ── 空间：读 ────────────────────────────────────────────────
    makeTool(account, {
      name: "qq_qzone_list",
      label: "QQ 空间说说列表",
      description:
        "查看 QQ 空间说说列表。默认看机器人自己的空间；传 target_uin 可查看指定好友的空间（需有访问权限）。返回 tid/content/time/comment_num/images。",
      parameters: Type.Object({
        target_uin: Type.Optional(
          Type.String({ description: "目标 QQ 号，省略则看机器人自己" }),
        ),
        pos: Type.Optional(Type.Number({ description: "起始偏移", default: 0 })),
        num: Type.Optional(Type.Number({ description: "本页数量 1-100", default: 20 })),
      }),
      execute: (p) =>
        callSnowLumaAction(account, "get_qzone_msg_list", {
          target_uin: p.target_uin,
          pos: p.pos ?? 0,
          num: p.num ?? 20,
        }),
    }),

    makeTool(account, {
      name: "qq_qzone_feeds",
      label: "QQ 空间好友动态",
      description:
        "查看 QQ 空间好友动态首页（谁发了什么）。返回结构化正文/图片/点赞数/评论数，支持 next_cursor 分页续读。",
      parameters: Type.Object({
        page_num: Type.Optional(Type.Number({ description: "页码 1 起", default: 1 })),
        count: Type.Optional(Type.Number({ description: "本页数量 1-50", default: 10 })),
        cursor: Type.Optional(
          Type.String({ description: "上一次返回的 next_cursor，原样传回续页" }),
        ),
      }),
      execute: (p) =>
        callSnowLumaAction(account, "get_qzone_feeds", {
          page_num: p.page_num ?? 1,
          count: p.count ?? 10,
          cursor: p.cursor,
        }),
    }),

    makeTool(account, {
      name: "qq_qzone_detail",
      label: "QQ 空间说说详情",
      description:
        "查看单条 QQ 空间说说详情（含完整内容与内联评论）。需要 tid（来自 qq_qzone_list / qq_qzone_send 返回值）。",
      parameters: Type.Object({
        tid: Type.String({ description: "说说 tid" }),
        target_uin: Type.Optional(
          Type.String({ description: "说说所属 QQ 号，省略则机器人自己" }),
        ),
      }),
      execute: (p) =>
        callSnowLumaAction(account, "get_qzone_msg_detail", {
          tid: p.tid,
          target_uin: p.target_uin,
        }),
    }),

    // ── 空间：写 ────────────────────────────────────────────────
    makeTool(account, {
      name: "qq_qzone_send",
      label: "发表 QQ 空间说说",
      description:
        "发表 QQ 空间说说（纯文字或带图，图片自动上传）。写操作，会真实发布到空间。ugc_right: 1=所有人可见 4=好友可见 16=部分好友 64=仅自己 128=部分好友不可见。返回新说说的 tid。",
      parameters: Type.Object({
        content: Type.String({ description: "说说正文" }),
        images: Type.Optional(
          Type.Array(Type.String({ description: "图片 URL / file:// / base64://" })),
        ),
        ugc_right: Type.Optional(
          Type.Number({ description: "查看权限 1/4/16/64/128", default: 1 }),
        ),
        target_uins: Type.Optional(
          Type.Array(Type.String({ description: "权限作用 QQ 号；ugc_right=16/128 时必填" })),
        ),
      }),
      write: true,
      execute: (p) =>
        callSnowLumaAction(account, "send_qzone_msg", {
          content: p.content,
          images: p.images,
          ugc_right: p.ugc_right ?? 1,
          target_uins: p.target_uins,
        }),
    }),

    makeTool(account, {
      name: "qq_qzone_delete",
      label: "删除 QQ 空间说说",
      description: "删除机器人自己空间的一条说说。写操作，不可恢复。需要 tid。",
      parameters: Type.Object({
        tid: Type.String({ description: "要删除的说说 tid" }),
      }),
      write: true,
      execute: (p) =>
        callSnowLumaAction(account, "delete_qzone_msg", { tid: p.tid }),
    }),

    makeTool(account, {
      name: "qq_qzone_like",
      label: "QQ 空间说说点赞",
      description:
        "给一条 QQ 空间说说点赞。写操作。target_uin 省略=自己的空间；点赞好友说说传其 QQ 号。tid 来自说说列表/详情。",
      parameters: Type.Object({
        tid: Type.String({ description: "说说 tid" }),
        target_uin: Type.Optional(Type.String({ description: "说说所属 QQ 号" })),
        abstime: Type.Optional(
          Type.Number({ description: "说说发表时间 unix 秒（来自列表/详情）" }),
        ),
      }),
      write: true,
      execute: (p) =>
        callSnowLumaAction(account, "like_qzone", {
          tid: p.tid,
          target_uin: p.target_uin,
          abstime: p.abstime,
        }),
    }),

    makeTool(account, {
      name: "qq_qzone_unlike",
      label: "取消 QQ 空间说说点赞",
      description: "取消对一条说说的点赞。写操作。参数同点赞。",
      parameters: Type.Object({
        tid: Type.String({ description: "说说 tid" }),
        target_uin: Type.Optional(Type.String({ description: "说说所属 QQ 号" })),
        abstime: Type.Optional(Type.Number({ description: "说说发表时间 unix 秒" })),
      }),
      write: true,
      execute: (p) =>
        callSnowLumaAction(account, "unlike_qzone", {
          tid: p.tid,
          target_uin: p.target_uin,
          abstime: p.abstime,
        }),
    }),

    makeTool(account, {
      name: "qq_qzone_comment",
      label: "评论 QQ 空间说说",
      description:
        "评论一条 QQ 空间说说（可带图）。写操作。target_uin 省略=机器人自己空间；评论好友说说传其 QQ 号。",
      parameters: Type.Object({
        tid: Type.String({ description: "说说 tid" }),
        content: Type.String({ description: "评论内容" }),
        target_uin: Type.Optional(Type.String({ description: "说说所属 QQ 号" })),
        images: Type.Optional(
          Type.Array(Type.String({ description: "图片 URL / file:// / base64://" })),
        ),
      }),
      write: true,
      execute: (p) =>
        callSnowLumaAction(account, "comment_qzone", {
          tid: p.tid,
          content: p.content,
          target_uin: p.target_uin,
          images: p.images,
        }),
    }),

    // ── 签名 / 资料 ─────────────────────────────────────────────
    makeTool(account, {
      name: "qq_profile_set",
      label: "设置 QQ 资料",
      description:
        "设置 QQ 个人资料。写操作。personal_note 即个性签名；只传需要修改的字段。sex: 0=未知 1=男 2=女。",
      parameters: Type.Object({
        nickname: Type.Optional(Type.String({ description: "昵称" })),
        personal_note: Type.Optional(Type.String({ description: "个性签名" })),
        sex: Type.Optional(Type.Number({ description: "0 未知 / 1 男 / 2 女" })),
      }),
      write: true,
      execute: (p) =>
        callSnowLumaAction(account, "set_qq_profile", {
          nickname: p.nickname,
          personal_note: p.personal_note,
          sex: p.sex,
        }),
    }),

    makeTool(account, {
      name: "qq_online_status_set",
      label: "设置 QQ 在线状态",
      description:
        "设置 QQ 在线状态（自定义文案，如'学习中'）。写操作。wording 是展示的文本，face_id 是图标。",
      parameters: Type.Object({
        wording: Type.String({ description: "状态文案", default: "" }),
        face_id: Type.Optional(Type.Number({ description: "状态图标 id", default: 14 })),
        face_type: Type.Optional(Type.Number({ description: "图标类型", default: 1 })),
      }),
      write: true,
      execute: (p) =>
        callSnowLumaAction(account, "set_diy_online_status", {
          face_id: p.face_id ?? 14,
          face_type: p.face_type ?? 1,
          wording: p.wording ?? "",
        }),
    }),
  ];
}
