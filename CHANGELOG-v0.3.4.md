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
| 2. 自动识别 | `ignoreBots: true`（默认） | 查 `get_group_member_info` 的 `is_robot`，机器人消息限频（`botMinIntervalSec`，默认 60 秒内只放行第一条） |
| 3. 出站限频 | `outboundRateLimit: 60` | 同一目标 60 秒内最多回一条，超出的静默丢弃；**被 @ / 显式引用时豁免** |

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
| `ignoreBots` | `true` | 自动识别机器人并限频 |
| `ignoreFrom` | `[]` | 手动拉黑（完全丢弃） |
| `botMinIntervalSec` | `60` | 机器人限频间隔 |
| `outboundRateLimit` | `0` | 出站限频间隔（被 @ 豁免） |
| `replyDelaySec` | `0` | 回复延迟基准（随机 0.5x~1.5x） |
| `userLabels` | `{}` | 身份标签映射 |

---

## 四、测试

**26 files / 297 passed**（新增：system-notice、ignore-bot、gateway.commands、mention-face、gateway.delay 等）。

---

## 五、兼容性

- 所有新字段默认值保持旧行为（关闭/宽松），老配置无需改动。
- `ignoreBots` 默认 `true`：如果之前依赖「机器人消息全部放行」的行为，需显式设 `false`。
- `muteSystemNotices` 默认 `true`：如果之前希望系统通知进 agent，需显式设 `false`。
