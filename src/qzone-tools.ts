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
 * 安全设计（v0.3.2 复审加固 / v0.3.3 二轮复审加固）：
 *  - 写操作（发/删/点赞/评论/改签名）受 `qzoneWrite` 配置开关控制：
 *    未显式开启时这些工具根本不注册，agent 看不到、调不了。该开关与
 *    `outboundAllow` 完全解耦——发说说没有收件人，peer 白名单语义不适用。
 *  - 图片只接受本地文件（file:// 或绝对路径），经 `assertSafeMediaPath`
 *    （词法 + realpath 双检）与消息通道同一套媒体根白名单；http(s)/base64
 *    一律拒绝（防 SSRF 外传）。
 *  - 写工具正文（说说/评论/签名/昵称）在 `replyAudit` 开启时过 `auditReply`，
 *    与消息通道同一规则。
 *  - Read-only 工具（看空间/看动态）不设白名单，但同样经过 account 检查。
 */
import { Type, type Static } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import type { ResolvedOneBotAccount } from "./types.js";
import { assertSafeMediaPath, auditReply } from "./policy.js";
import { fileUriToPath } from "./paths.js";
import { resolveNapCatMediaUri } from "./outbound.js";

const API_TIMEOUT_MS = 15_000;

/** SnowLuma OneBot 扩展动作名（也是日志/详情里的 action 标识）。 */
type QzoneAction =
  | "get_qzone_msg_list"
  | "get_qzone_feeds"
  | "get_qzone_msg_detail"
  | "send_qzone_msg"
  | "delete_qzone_msg"
  | "like_qzone"
  | "unlike_qzone"
  | "comment_qzone"
  | "set_qq_profile"
  | "set_diy_online_status";

async function callSnowLumaAction(
  account: ResolvedOneBotAccount,
  action: QzoneAction,
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

/**
 * 校验一条图片引用。
 *
 *  - 本地路径（file:// 或绝对路径）：走媒体根白名单（词法 + realpath 双检）。
 *  - http(s) / base64：拒绝。与消息通道一致（channel.ts 对 http 图片抛
 *    "OneBot sendMedia currently supports local file paths only"）——否则
 *    SnowLuma 会去抓取内网/云元数据地址并把结果外传到空间图床，构成
 *    SSRF 外传通道。
 */
async function normalizeImageRef(account: ResolvedOneBotAccount, img: string): Promise<string> {
  const trimmed = String(img).trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    throw new Error("qzone images support local files only (http(s) URLs are rejected)");
  }
  if (lower.startsWith("base64://")) {
    throw new Error("qzone images support local files only (base64:// is rejected)");
  }
  const localPath = lower.startsWith("file://") ? fileUriToPath(trimmed) : trimmed;
  // Same choke point as the message path: validate against the media roots and
  // copy into the shared dir, then hand SnowLuma a container-visible URI. A
  // bare host path breaks every Docker deployment (SnowLuma can't see it).
  return resolveNapCatMediaUri(account, localPath, "images");
}

function makeTool(
  account: ResolvedOneBotAccount,
  def: {
    name: string;
    label: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
    action: QzoneAction;
    write?: boolean;
    execute: (params: Record<string, unknown>) => Promise<unknown>;
  },
): AnyAgentTool {
  const writeMark = def.write === true ? "（写操作）" : "";
  return {
    name: def.name,
    label: def.label,
    description: `${def.description}${writeMark}`,
    parameters: def.parameters as never,
    execute: async (toolCallId: string, params: Static<typeof def.parameters>) => {
      try {
        const data = await def.execute(params as Record<string, unknown>);
        return {
          content: [
            {
              type: "text",
              text: typeof data === "string" ? data : JSON.stringify(data),
            },
          ],
          details: { ok: true, tool: def.name, action: def.action, data },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          details: { ok: false, tool: def.name, action: def.action, error: String(err) },
        };
      }
    },
  };
}

/**
 * 构造 QQ 空间 / 签名工具集。
 *
 * 写操作工具仅在 `account.qzoneWrite === true` 时注册。该开关与
 * `outboundAllow` 解耦（发说说无收件人，peer 白名单不适用）。
 *
 * @param account 已解析的账号（resolveOneBotAccount 的输出）。调用方在
 *   agentTools factory 里每次解析当前账号，避免拿到过期配置。
 */
export function buildQzoneAndProfileTools(
  account: ResolvedOneBotAccount,
): AnyAgentTool[] {
  if (!account.enabled) return [];

  const writeEnabled = account.qzoneWrite === true;

  const tools: AnyAgentTool[] = [
    // ── 空间：读（始终注册）────────────────────────────────────
    makeTool(account, {
      name: "qq_qzone_list",
      label: "QQ 空间说说列表",
      description:
        "查看 QQ 空间说说列表。默认看机器人自己的空间；传 target_uin 可查看指定好友的空间（需有访问权限）。返回 tid/content/time/comment_num/images。",
      action: "get_qzone_msg_list",
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
      action: "get_qzone_feeds",
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
      action: "get_qzone_msg_detail",
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
  ];

  // ── 空间 / 资料：写（仅 qzoneWrite 开启时注册）────────────────
  if (writeEnabled) {
    tools.push(
      makeTool(account, {
        name: "qq_qzone_send",
        label: "发表 QQ 空间说说",
        description:
          "发表 QQ 空间说说（纯文字或带图，图片自动上传）。写操作，会真实发布到空间。ugc_right: 1=所有人可见 4=好友可见 16=部分好友 64=仅自己 128=部分好友不可见。返回新说说的 tid。",
        action: "send_qzone_msg",
        parameters: Type.Object({
          content: Type.String({ description: "说说正文" }),
          images: Type.Optional(
            Type.Array(Type.String({ description: "本地图片路径（file:// 或绝对路径）；http(s)/base64 会被拒绝" })),
          ),
          ugc_right: Type.Optional(
            Type.Number({ description: "查看权限 1/4/16/64/128", default: 1 }),
          ),
          target_uins: Type.Optional(
            Type.Array(Type.String({ description: "权限作用 QQ 号；ugc_right=16/128 时必填" })),
          ),
        }),
        write: true,
        execute: async (p) => {
          // 与消息通道一致：仅 replyAudit 开启时审计（policy.ts assertOutboundAllowed 同规则）
          if (account.replyAudit) {
            const audit = auditReply(String(p.content ?? ""));
            if (!audit.ok) {
              throw new Error(`qzone send blocked by reply audit: ${audit.reason ?? "sensitive content"}`);
            }
          }
          return callSnowLumaAction(account, "send_qzone_msg", {
            content: p.content,
            images: Array.isArray(p.images)
              ? await Promise.all(p.images.map((img: string) => normalizeImageRef(account, img)))
              : undefined,
            ugc_right: p.ugc_right ?? 1,
            target_uins: p.target_uins,
          });
        },
      }),

      makeTool(account, {
        name: "qq_qzone_delete",
        label: "删除 QQ 空间说说",
        description: "删除机器人自己空间的一条说说。写操作，不可恢复。需要 tid。",
        action: "delete_qzone_msg",
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
        action: "like_qzone",
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
        action: "unlike_qzone",
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
        action: "comment_qzone",
        parameters: Type.Object({
          tid: Type.String({ description: "说说 tid" }),
          content: Type.String({ description: "评论内容" }),
          target_uin: Type.Optional(Type.String({ description: "说说所属 QQ 号" })),
          images: Type.Optional(
            Type.Array(Type.String({ description: "本地图片路径（file:// 或绝对路径）；http(s)/base64 会被拒绝" })),
          ),
        }),
        write: true,
        execute: async (p) => {
          // 与消息通道一致：仅 replyAudit 开启时审计
          if (account.replyAudit) {
            const audit = auditReply(String(p.content ?? ""));
            if (!audit.ok) {
              throw new Error(`qzone comment blocked by reply audit: ${audit.reason ?? "sensitive content"}`);
            }
          }
          return callSnowLumaAction(account, "comment_qzone", {
            tid: p.tid,
            content: p.content,
            target_uin: p.target_uin,
            images: Array.isArray(p.images)
              ? await Promise.all(p.images.map((img: string) => normalizeImageRef(account, img)))
              : undefined,
          });
        },
      }),

      makeTool(account, {
        name: "qq_profile_set",
        label: "设置 QQ 资料",
        description:
          "设置 QQ 个人资料。写操作。personal_note 即个性签名；只传需要修改的字段。sex: 0=未知 1=男 2=女。",
        action: "set_qq_profile",
        parameters: Type.Object({
          nickname: Type.Optional(Type.String({ description: "昵称" })),
          personal_note: Type.Optional(Type.String({ description: "个性签名" })),
          sex: Type.Optional(Type.Number({ description: "0 未知 / 1 男 / 2 女" })),
        }),
        write: true,
        execute: (p) => {
          // 签名/昵称也是公开展示文本，与消息通道一致在 replyAudit 开启时审计
          const auditText = [p.personal_note, p.nickname].filter(Boolean).join("\n");
          if (account.replyAudit && auditText) {
            const audit = auditReply(auditText);
            if (!audit.ok) {
              throw new Error(`qzone profile blocked by reply audit: ${audit.reason ?? "sensitive content"}`);
            }
          }
          return callSnowLumaAction(account, "set_qq_profile", {
            nickname: p.nickname,
            personal_note: p.personal_note,
            sex: p.sex,
          });
        },
      }),

      makeTool(account, {
        name: "qq_online_status_set",
        label: "设置 QQ 在线状态",
        description:
          "设置 QQ 在线状态（自定义文案，如'学习中'）。写操作。wording 是展示的文本，face_id 是图标。",
        action: "set_diy_online_status",
        parameters: Type.Object({
          wording: Type.String({ description: "状态文案", default: "" }),
          face_id: Type.Optional(Type.Number({ description: "状态图标 id", default: 14 })),
          face_type: Type.Optional(Type.Number({ description: "图标类型", default: 1 })),
        }),
        write: true,
        execute: (p) => {
          // 在线状态文案是公开展示文本：与签名/说说同规则，replyAudit 开启时审计
          if (account.replyAudit) {
            const audit = auditReply(String(p.wording ?? ""));
            if (!audit.ok) {
              throw new Error(`qzone status blocked by reply audit: ${audit.reason ?? "sensitive content"}`);
            }
          }
          return callSnowLumaAction(account, "set_diy_online_status", {
            face_id: p.face_id ?? 14,
            face_type: p.face_type ?? 1,
            wording: p.wording ?? "",
          });
        },
      }),
    );
  }

  return tools;
}
