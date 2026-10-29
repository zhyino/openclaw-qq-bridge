# OpenClaw QQ Bridge

OpenClaw 的 QQ 消息通道插件，基于 **OneBot 11 协议**，兼容 **SnowLuma / NapCat / go-cqhttp** 等所有 OneBot 11 实现。

在 openclaw-onebot-plugin（MIT）基础上增强了安全硬边界，移植了 qq-bridge 的精华能力：

- 🔒 **出站强制白名单** — agent 只能发到配置允许的目标，即使被 prompt injection 诱导也发不出去
- 🛡️ **回复审计** — 回复文本含本地路径 / 凭据特征时整条拦截，不发送
- 👑 **owner 控制命令** — `/silent` `/active` `/role` `/mode` 由桥接硬执行，不经过模型；群友的控制词被静默吞掉
- 📚 **黑话学习** — 从群聊提取网络用语候选 → 联网查释义 → 管理员确认后才注入聊天上下文
- 🧹 继承骨架：block streaming、reaction、语音链路（SILK→MP3→STT→TTS）、消息聚合、自动重连

## 架构

```
SnowLuma / NapCat（QQ 登录端，提供 OneBot 11 接口）
    ↕  正向 WebSocket + HTTP API
openclaw-qq-bridge（OpenClaw 渠道插件）
    ↕
OpenClaw Agent
```

## 安装

```bash
openclaw plugins install <本包>
openclaw gateway restart
```

或手动复制到 `~/.openclaw/extensions/` 后 `npm install --omit=dev`。

要求：OpenClaw ≥ 2026.3.23，Node.js 22+。

## 配置

在 `openclaw.json` 中添加：

```json
{
  "plugins": {
    "allow": ["openclaw-qq-bridge"],
    "entries": {
      "openclaw-qq-bridge": { "enabled": true }
    }
  },
  "channels": {
    "onebot": {
      "enabled": true,
      "wsUrl": "ws://<SnowLuma的IP>:3001",
      "httpUrl": "http://<SnowLuma的IP>:3000",
      "accessToken": "你的token（可选）",
      "allowFrom": [
        "private:主人QQ号",
        "private:女友QQ号",
        "group:群1群号"
      ],
      "ownerQQ": "主人QQ号",
      "outboundAllow": [
        "private:主人QQ号",
        "private:女友QQ号",
        "group:群1群号"
      ],
      "outboundDeny": [],
      "replyAudit": true,
      "sharedDir": "/path/to/napcat/shared",
      "containerSharedDir": "/shared",
      "mediaAllowDirs": [],
      "groupAutoReact": false,
      "groupAutoReactEmojiId": 1
    }
  }
}
```

### 配置字段说明

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `wsUrl` | OneBot WebSocket 地址（入站消息） | - |
| `httpUrl` | OneBot HTTP API 地址（出站消息） | - |
| `accessToken` | API 鉴权 token（可选，建议必填） | - |
| `allowFrom` | 入站白名单：`private:<QQ>` / `group:<群号>` / `group:*` / `*` | 空=全部放行（不推荐） |
| `ownerQQ` | 管理员 QQ 号（可执行控制命令） | 无 |
| `outboundAllow` | **出站白名单**：agent 只能发到这些目标 | 空=全部放行（不推荐） |
| `outboundDeny` | 出站黑名单：永远禁止的目标，优先级高于 allow | `[]` |
| `replyAudit` | 是否开启回复审计（拦截路径/凭据泄露） | `true` |
| `sharedDir` | 与 NapCat 容器共享的宿主目录（媒体中转站） | `~/napcat/shared` |
| `containerSharedDir` | `sharedDir` 在容器内的路径 | `/shared` |
| `mediaAllowDirs` | 额外允许发送的媒体目录（除 `sharedDir` 之外） | `[]` |
| `groupAutoReact` | 群消息自动加 reaction | `false` |
| `groupAutoReactEmojiId` | 自动 reaction 使用的表情 id | `1` |

> `allowFrom` 与 `outboundAllow` 用的是**同一套匹配规则**：精确 id、`*`、以及类型通配 `group:*` / `private:*`。裸数字不会被当成 QQ 号（旧配置里的 `groupAllowFrom: ["123456"]` 会自动补成 `group:123456`）。

### 媒体文件放在哪

agent 发出的图片/语音/文件，路径必须落在受控目录内，否则会被拒绝并返回 `media path not allowed`。受控目录 = 以下三者之和：

| 目录 | 用途 |
| --- | --- |
| `sharedDir` | 与 NapCat 共享的中转站（`<sharedDir>/openclaw/` 下会自动暂存、24 小时清理） |
| `mediaAllowDirs` | 你额外放行的目录，比如 agent 的 workspace |
| 语音工作目录 | 插件自己转码语音用的临时目录，自动放行，默认 `<tmp>/openclaw-onebot-voice`，可用 `ONEBOT_VOICE_DIR` 覆盖 |

不在上述目录里的文件**不会**被发出去。如果你的 agent 把生成物写在 workspace 里，把它加进 `mediaAllowDirs`：

```json
"mediaAllowDirs": ["/home/user/.openclaw/workspace"]
```


## owner 控制命令

由桥接**硬执行**，不经过模型。只有 `ownerQQ` 发送才生效；非 owner 发送会被静默丢弃（不回复、不提示）。

| 命令 | 效果 |
| --- | --- |
| `/silent` | 静默：群消息不再投递给 agent（owner 私聊仍通） |
| `/active` | 恢复活跃 |
| `/role <名称>` | 切换人格（写入 `~/.openclaw/qq-bridge-state.json`，由你的提示词体系读取） |
| `/role` | 查看当前人格 |
| `/mode` | 查看当前状态 |

> 状态文件：`~/.openclaw/qq-bridge-state.json`，可被 SOUL.md / 定时任务读取，实现"门牌"效果。

## 黑话学习

群聊消息进入滚动窗口，攒够一定数量后：

1. **提取** — 用提取 prompt 让模型从最近群聊中找出"疑似黑话"候选
2. **研究** — 对候选生成联网考究 prompt（用 `web_search` / `web_fetch` 查证含义）
3. **确认** — 只有 `confirmed: true` 且含义非空的词条会被注入聊天上下文（【群聊黑话表】）
4. **注入** — 按出现次数排序，最多 8 条，随每条消息注入

词条库存储：可配置路径的 JSON 文件，原子写入、损坏自动隔离、容量上限 2000 条。

> 设计原则：候选默认不自动转正。模型搜到的释义只作为候选，最终是否需要管理员确认取决于你的调用方式——本插件提供完整的提取/研究/注入 API，你可以在 cron 任务或自定义逻辑里调用。

## 安全设计

### 只有一个出站通道

文本、图片、语音、文件、表情回应，全部经过 `src/outbound.ts` 里的 `dispatchSend()`。白名单校验和回复审计挂在这个函数上，不在各个调用点——新增一种消息类型也不可能绕过它。

媒体额外经过 `resolveNapCatMediaUri()`：先做字面路径检查，再用 `realpath` 检查符号链接解析后的真实路径，防止「共享目录里放一个指向 `~/.openclaw/openclaw.json` 的软链接」。

### 出站强制白名单（硬拦截）

`outboundAllow` / `outboundDeny` 在**发送前**校验。agent 调用发送工具时，目标必须命中 allow 列表且不在 deny 列表，否则直接拒绝，返回错误。

这层是物理防线：即使模型被群友 prompt injection 诱导，也无法把消息发到白名单以外的地方。

### 回复审计（硬拦截）

`replyAudit: true` 时，agent 的回复文本若包含：

- 本机路径（`C:\`、`/home/`、`/tmp/`、`/etc/` 等）
- 凭据特征（`api_key:`、`sk-...`、`token:`、`password:`、`Bearer`、GitHub token 等）

→ 整条拦截不发送，并返回 `outbound blocked by policy` 错误。

运行期的错误提示（不是模型回复）走的是**脱敏**而不是丢弃：`redactSensitive()` 把路径替换成 `[path]`、凭据替换成 `[redacted]` 后照常发出，用户至少知道出了什么问题。

### 启动自检

每个账号启动时执行一次配置体检，问题写进日志：

| 级别 | 条件 |
| --- | --- |
| error | `wsUrl` / `httpUrl` 缺失、协议不对 |
| warn | 没配 `accessToken`、`allowFrom` 为空（全放行）、`outboundAllow` 为空（全放行）、`replyAudit: false`、`mediaAllowDirs` 指向不存在的目录 |

默认值是宽松的（为了不让老用户升级后断联），但不再**静默**。


### 控制命令硬执行

`/silent` `/active` `/role` `/mode` 在消息到达模型之前就被插件拦截处理。群友发这些命令会被静默丢弃，agent 永远看不到、也无法回应或模仿。

## 开发

```bash
npm ci             # 按 package-lock.json 精确安装（无 lock 时才用 npm install）
npm run verify     # 提交前跑这个：typecheck(src+test) + manifest 字段对账 + 全量测试 + 生产依赖漏洞扫描
npm run build      # tsc 编译到 dist/（发布/安装前需要）
npm run pack:dry-run
```

`npm test` 会先跑 vitest，再用 `scripts/check-test-count.mjs` 比对「实际跑过的测试文件数」与「磁盘上的测试文件数」——两者不一致直接失败，避免测试被漏跑而 CI 假绿。当前基线：20 个测试文件、218 个用例（Linux/macOS 全跑；Windows 无符号链接权限时 2 个用例自动跳过）。

`npm run manifest:check` 校验 `src/types.ts` 的配置字段全部出现在 `openclaw.plugin.json` 的 schema 里。schema 是 `additionalProperties: false`，字段漏登记等于该配置项对用户不可写。

目录结构：

```
src/
  paths.ts          所有目录的唯一事实源（共享目录、暂存目录、语音目录）
  target.ts         目标地址解析 + 白名单匹配（入站出站共用）
  policy.ts         入站判定 / 出站闸门 / 回复审计 / 媒体路径校验
  config.ts         配置解析（整对象承接，不做字段名单）+ 启动自检
  outbound.ts       出站唯一通道：dispatchSend / resolveNapCatMediaUri
  gateway.ts        WebSocket 生命周期
  gateway/
    batch.ts        消息聚合（可单独测试，不依赖 socket）
    inbound.ts      段提取 / 信封组装 / 命令授权
    dispatch.ts     一个批次 = 一轮 agent，含投递与超时兜底
```

CI 在 `.github/workflows/ci.yml`：Linux + Windows × Node 20/22 跑类型检查、构建、测试，另有一个生产依赖漏洞扫描任务。


## 致谢

- [openclaw-onebot-plugin](https://github.com/xucheng/openclaw-onebot) — 插件骨架（MIT）
- [qq-bridge](https://github.com/Derpyu520/qq-bridge) — 出站白名单 / 回复审计 / 黑话学习设计参考（MIT）

## License

MIT
