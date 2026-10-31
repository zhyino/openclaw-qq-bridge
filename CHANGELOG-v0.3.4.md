# v0.3.4 — 群聊体验与安全加固

日期：2026-10-31
基线：v0.3.3

---

## 一、新增能力

### 1. 系统通知静默（`muteSystemNotices`，默认 `true`）

`[OpenClaw]` 前缀 + `💾 Learned:` 这类系统通知不再投递给 agent，也不打 warn 日志——在出站收口点静默丢弃，调用方拿到「成功」返回。

### 2. 命令权限收口（防群友触发内置命令）

此前 `/reset /new /model /think /help` 等 OpenClaw 内置命令**任何群友都能触发**（命令文本直接进 agent）。本版在 ingest 层收口：

- 任何 `/` 开头的命令，发送者**必须有命令权限**才进 agent，否则整体丢弃（不 dispatch）
- 有权限者：`ownerQQ` 本人、`allowFrom` 里的个人（裸号 / `private:` 前缀）、显式 `*`
- `group:xxx` 条目**只放行消息，不授予命令权限**

### 3. 引用回复（`replyToId`）

`buildMessage` 支持 `replyToId`，出站回复可附带 OneBot `reply` 段（`{type:"reply", data:{id:"..."}}`），在群聊里正确引用被回复的消息。

### 4. 机器人互刷防护（三层）

| 层 | 配置 | 行为 |
| --- | --- | --- |
| 1. 手动拉黑 | `ignoreFrom: ["QQ号"]` | 这些号的消息**完全丢弃**（不走网络查询） |
| 2. 出站限频 | `outboundRateLimit: 60` | 同一目标 60 秒内最多回一条，超出的静默丢弃；**入站消息 @ 了机器人时豁免**（保证「被@必回」） |

> 演变：从「完全丢弃机器人消息」按反馈改为「入站全放行 + 出站限频」——既避免两机器人死循环刷屏，又不误伤正常聊天。

### 5. 身份识别（`userLabels` + `IsOwner`）

入站上下文显式携带 `IsOwner` 标记，`ownerQQ` 自动标「主人」，`userLabels` 配置的发送者名字附标签（如「昵称（女朋友）」）——agent 能区分「这是主人」还是陌生人，跨会话认得人。

### 6. 自然回复延迟（`replyDelaySec`）

回复前延迟基准秒数，实际延迟随机取 `0.5x~1.5x`——回复节奏自然不机械，且快速连发的消息有机会合并成一次回复。

### 7. 随机延迟（0.3.4 追加）

固定延迟太有「机器节拍感」，改为 `replyDelaySec * (0.5 + Math.random())` 随机抖动。

---

## 二、修复

- **CI Node 20 失败**：vitest 2.1.9 需要 Node ≥ 20.19（`isMarkedAsUntransferable`），CI 的 Node 20 太老导致 `verify` 矩阵持续红、GitHub 反复发失败邮件。矩阵 `[20, 22]` → `[22, 24]`（audit 20→22），`package.json` 加 `engines: { node: ">=22" }`。
- **gitleaks 防敏感信息外泄**：默认规则不认 QQ 号 / 内网 IP / 微信 openid，新增 `.gitleaks.toml` 自定义规则，CI 每次 push 自动扫描，含测试数据 allowlist（时间戳 / 占位符 / 假 token）。

---

## 三、配置

新增字段全部可配于 `channels.onebot` 顶层或 `accounts.*`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `muteSystemNotices` | `true` | 静默系统通知 |
| `ignoreFrom` | `[]` | 手动拉黑（完全丢弃） |
| `outboundRateLimit` | `0` | 出站限频间隔（被 @ 豁免） |
| `replyDelaySec` | `0` | 回复延迟基准（随机 0.5x~1.5x） |
| `userLabels` | `{}` | 身份标签映射 |

---

## 四、测试

**26 files / 297 passed**（新增：system-notice、ignore-bot、gateway.commands、mention-face、gateway.delay 等）。

---

## 五、兼容性

- 所有新字段默认值保持旧行为（关闭/宽松），老配置无需改动。
- `muteSystemNotices` 默认 `true`：如果之前希望系统通知进 agent，需显式设 `false`。

---

## 六、后续修复（2026-10-31 下午）

| 项 | 问题 | 修复 |
| --- | --- | --- |
| P-1 | 不响应戳一戳：`notice` 事件只打 debug 日志就丢弃 | 新增 `pokeReply`（默认 true）：`notice/notify/poke` 且 `target_id == self_id` 时合成 `[戳一戳]` 入站消息，走完整 ingest（白名单/ignoreFrom/批处理/身份） |
| P-2 | 会话被归档后永久失败（`Session ... is archived`），不产生新会话 | 新增每 peer **会话代数**（`~/.openclaw/qq-bridge-sessions.json`）：检测到 archived 错误 → 代数 +1 → 以 `<key>:g<N>` 重试一次，自动开新会话 |
| P-3 | `[OpenClaw] Request received, processing...` 超时占位提示会发到聊天里，属于噪音 | 该占位提示**不再发送**，只记日志；真正的错误（`Error:` / `Processing failed:`）仍带 `bypassMute + exemptRateLimit` 送达 |

---

## 七、按群唤醒策略（借 DSH dsh-qq-bridge 的唤醒模型）

| 项 | 内容 |
| --- | --- |
| 动机 | 群聊每条消息都跑一轮 agent，token 消耗大且容易过度插话 |
| 新增 | `wakePolicy`（`all`/`mention`/`sampled`）+ `wakeProbability` + `groups.<群号>` 按群覆盖；`requireMention: true` 兼容 OpenClaw 原生写法 |
| 机制 | 未唤醒消息零模型调用，进环形缓冲（50 条/2000 字），下次唤醒时以「[群聊未唤醒期间记录·最近 N 条]」前缀注入，上下文不断档 |
| 默认 | `all`（保持历史行为，不改变现有部署） |
| 实现 | 复用 OpenClaw 的 `groups.<id>` 配置面，不新增平行配置体系 |

---

## 八、撤回消息不再被回复

| 项 | 内容 |
| --- | --- |
| 问题 | 用户撤回消息后，插件仍会基于该消息回复（批处理窗口 + 回复延迟给了撤回足够时间） |
| 修复 | 监听 `notice/group_recall` / `friend_recall`，记录 `message_id`（TTL 10 分钟，上限 500 条）；批处理前剔除已撤回消息，整批撤回则不产生 agent 轮次；回合进行中整批撤回则静默抑制回复 |
| 测试 | `test/recall.test.ts`（4 例）：tracker 语义、批处理前剔除、回合中抑制 |

---

## 九、自检修复（2026-10-31 晚）

| 编号 | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| SC-1 | 高 | mention/sampled 群里，**已授权的斜杠命令**（`/reset`、`/new`）没 @ 机器人时被唤醒闸门吞掉（记录进 digest 但不派发） | 命令豁免唤醒闸门：`isCommand` 时永远唤醒 |
| SC-2 | 中 | 出站限频窗口在**发送前**就记账——网络失败/retcode 失败也会消耗窗口，导致重试被限频 | 拆成 `isOutboundRateLimited`（只查）+ `markOutboundSent`（成功后记账） |
| SC-3 | 中 | 未唤醒 digest 里包含**已撤回**的消息，下次唤醒会把撤回内容带给模型 | digest 条目带 `message_id`，`take()` 时用 RecallTracker 过滤 |
| SC-4 | 中 | 「被@豁免限频」用 `combinedText.includes("[被@]")` 判断——digest 前缀里若含历史 @ 会误判豁免 | `BufferedMessage.directAddress` 标记（由当条消息本身计算），不再从拼接文本推断 |
| SC-5 | 低 | poke 依赖 notice 事件的 `self_id`；若 OneBot 端省略该字段则戳一戳永远不响应 | 从 message 事件缓存 `selfId`，notice 缺字段时回退 |
