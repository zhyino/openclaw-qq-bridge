# 安全基线（v0.3.0）

> 本文档描述当前实现的安全边界、已知残余风险与发布前回归清单。改代码必须同步改本文——两者不一致时以代码为准，并视为缺陷。

---

## 一、威胁模型

### 本插件防谁

| 威胁 | 说明 |
| --- | --- |
| 群友 prompt injection | 群聊内容是不可信输入，可能诱导 agent 执行命令、读文件、外发数据 |
| agent 误发 | agent 把本机路径、token、私钥、无关聊天内容发到错误的会话 |
| 媒体外泄 | 通过发「图片/文件」把 `~/.openclaw` 里的凭据搬运出去 |
| 本机其它进程 | 通过可预测的文件名/符号链接劫持暂存文件 |

### 本插件不防谁

- **不限制 agent 的工具面。** agent 有没有 `bash`、能不能读文件，由 OpenClaw 的 preset 决定，不归这个插件管。
- **不防 OneBot 服务端本身被攻破。** 那是 NapCat/SnowLuma 的边界。
- **不防 owner 自己。** `ownerQQ` 拥有控制命令权限。

### 一条必须说清的前提

因为不限制工具面，**出口有时就是唯一防线**。v0.1 的「媒体通道绕过白名单」之所以是致命问题，就是因为它让唯一的那道防线漏了一扇门。

---

## 二、已实现的边界

| 边界 | 实现位置 | 机制 |
| --- | --- | --- |
| 出站唯一通道 | `outbound.ts` `dispatchSend()` | 所有发送（文本/图片/语音/文件）都经过它，白名单在这里校验 |
| 媒体唯一收口 | `outbound.ts` `resolveNapCatMediaUri()` | 路径白名单只在这里，调用点无法绕过 |
| 媒体真实路径校验 | `policy.ts` `assertSafeMediaPath()` | 字面检查 + `realpath` 检查，防符号链接逃逸 |
| 媒体根唯一事实源 | `paths.ts` `resolveMediaRoots()` | 共享目录 / `mediaAllowDirs` / 语音目录，三者只在这里拼装 |
| 回复审计 | `policy.ts` `auditReply()` | 路径与凭据特征正则，命中即拦截 |
| 错误信息脱敏 | `policy.ts` `redactSensitive()` | 运行期报错先脱敏再发，不再整条丢弃 |
| 入站白名单 | `policy.ts` `checkInboundAllowed()` | 与出站共用 `target.ts` 的匹配器 |
| 控制命令硬执行 | `gateway.ts` `ingest()` | 在消息入批**之前**处理，无法被 1.5s 聚合窗口绕过 |
| CQ 码转义 | `outbound.ts` `escapeCqText()` | 文本里的 `[CQ:` 被改写成全角冒号 |
| 自身消息过滤 | `gateway.ts` `ingest()` | `user_id === self_id` 直接丢弃 |
| 传输鉴权 | `gateway.ts` `connect()` | WS 用 `Authorization` 头，token 不进 URL |
| 帧大小限制 | `gateway.ts` `connect()` | `maxPayload: 16MB`，关闭压缩 |
| 配置契约一致性 | `scripts/check-manifest-fields.mjs` + `test/manifest.test.ts` | 类型里出现的字段必须在 manifest schema 里声明，否则 CI 失败 |
| 语音下载限流 | `voice-download.ts` | 20MB 上限（可配）、15s 超时、流式计数 |
| 语音临时文件 | `voice-convert.ts` | 每次转码一个 `mkdtemp` 0700 目录，随结果一起删除 |
| 暂存文件 | `outbound.ts` | `openclaw/<kind>/`，0600，24h TTL 清理 |
| 状态文件 | `slang-learner.ts` | 原子写（temp + rename）、损坏隔离、条数上限 |
| 启动自检 | `config.ts` `validateOneBotConfig()` | 宽松默认值会写进日志，不再静默 |

---

## 三、残余风险

> 状态：**开** = 当前版本存在；**缓** = 有缓解但未根治。

### R-1　空白名单 = 全放行（开，缓解：启动告警）

`allowFrom` 为空表示接受所有群和私聊；`outboundAllow` 为空表示 agent 可以发给任何它叫得出名字的会话。

这是最危险的默认值，但也是老用户不断联的前提。目前的处理：启动时打 `config warn`。**建议生产环境显式配置两者。**

### R-2　回复审计是正则启发式（开）

`auditReply()` 拦的是特征，不是语义。base64、拆分字符、`/home` 写成 `/ho me`、用 markdown 链接包住路径，都可能绕过。

定位：**提高成本，不是保证**。真正的保证来自「不要把凭据放在 agent 读得到的地方」。

### R-3　入站图片只传 URL（开）

`extractImages()` 把 URL 塞进信封，由 agent 侧自行下载。插件不做内容校验，也不限制协议——如果 agent 有 fetch 工具，SSRF 面在 agent 侧。

### R-4　语音下载不做 host 校验（开）

`downloadVoiceFile()` 只认 `http(s)`，不限目标 host。若 OneBot 服务端被控制，可以让插件去拉内网地址（盲 SSRF：只看大小与耗时）。

### R-5　owner 控制命令无速率限制（开）

`/role` 会写磁盘。owner 账号被盗或脚本化刷命令时，没有节流。

### R-6　运行时状态在内存（开）

`silent` 状态、批次缓冲、重连计数都在进程内存。重启后 `silent` 复位为「活跃」，待发批次丢失。

### R-7　Windows 上文件权限不生效（开，环境限制）

`chmod(0o600)` 在 Windows 上是空操作，暂存媒体文件的实际权限由目录 ACL 决定。依赖文件权限做隔离的部署（多用户共机）在 Windows 上不成立。

### R-8　依赖 OpenClaw 内部 dist 的脚本（缓）

`scripts/sync-openclaw-cli.mjs` 会原地改 OpenClaw 的 `dist`。上游一升级就静默失效，且修改了第三方产物。

### R-9　传输层明文（开，取决于部署）

OneBot HTTP 默认明文。跨机部署必须走 `https://`，并在 `httpUrl` 里显式写出来；插件不做 TLS 强制。

### R-10　暂存目录在共享目录内（开，取决于部署）

`<sharedDir>/openclaw/` 与 NapCat 容器共享。若该容器不可信，它能读到别人发出去的媒体。隔离部署应把 `sharedDir` 指向专用目录。

### R-11　类型层与配置层是两套约定（已缓解，v0.3.1 → v0.3.2）

TypeScript 类型编译后消失，运行时生效的只有 `openclaw.plugin.json` 里那份 JSON Schema，而它写着 `additionalProperties: false`。一份字段如果是"只在 TS 里"，用户写进配置会被拒或静默丢弃，且没有任何提示。

v0.3.1 之前，五个安全字段（`ownerQQ`、`outboundAllow`、`outboundDeny`、`replyAudit`、`mediaAllowDirs`）全部只存在于 `src/types.ts`，**不在 manifest 里**——也就是说这个插件对外宣称的全部硬化能力，在运行时校验器眼里都不存在。

v0.3.1 补了顶层，**但漏了 `$defs.account`**：多账号场景下账号级的安全配置依然被 `additionalProperties: false` 拒绝。守卫当时只读 `schema.properties`，所以对着一半的 schema 报了 OK。

v0.3.2 起，检查按位置做，覆盖每一处：

- `scripts/check-manifest-fields.mjs`：
  - 顶层必须声明 `OneBotAccountConfig` 的全部字段；
  - `$defs.account` 必须声明「除 `accounts` 外的全部字段」——两份清单必须同步；
  - 两个载体层都必须声明五个安全字段；
  - account 不得声明顶层没有的字段；
- `test/manifest.test.ts`：除了字段名断言，还**用 ajv 实际编译 schema 并校验一份双账号配置**，以及一条「删掉字段后守卫必须报错」的反向用例——只断言"通过"的守卫，无法证明它不是恒绿。

**残余局限**：仍然是两份手写清单，只是加了两条交叉约束。schema 里可以有 TS 没有的字段（宿主注入的 `commands`、`streaming` 等），这是允许的；但如果有人在 schema 里加了一个插件从不读取的字段，守卫不会察觉。根治要靠单一来源生成（zod → 类型 + 校验 + JSON Schema），见 CHANGELOG v0.3.2 第六节。

### R-12　`ownerQQ` 是单值，非主人命令被静默吞掉（开）

`ownerQQ?: string`，`isOwner()` 用 `String(owner) === String(senderId)` 严格比对——**一个账号只能有一个主人**。

`owner-control.ts:91-95`：非主人发 `/silent` `/active` `/role` `/mode` 时返回 `{ handled: true }`，**不回复任何内容**，且事件不会转给模型。也就是说第二个管理员（例如共用同一个 QQ 号的另一个人）发这些命令，界面表现是"机器人完全没反应"，既没有拒绝提示，也没有落到模型那里去解释。

影响：多人共用一号时，只有一人能管理；另一人会误判机器人故障。缓解：把 `ownerQQ` 给到最需要管理权的人；或在使用文档中明确写出这一点。

### R-13　控制状态全局共享（开）

`~/.openclaw/qq-bridge-state.json` 是**一个文件**，`silent` / `role` 均不带账号或会话维度。

后果：任一主人执行 `/silent`，所有账号、所有会话（包括其他主人的私聊）一起静默；`/role` 切换人格同样全局生效。多账号部署下，一个账号的管理动作会波及另一个账号。

影响：不是越权（只有 owner 能改），但会造成"我没发命令，机器人却不出声"的困惑。缓解：单账号部署时无影响；多账号且主人不同时，应视为已知限制。


---

## 四、推荐的最小安全配置

```json
{
  "channels": {
    "onebot": {
      "wsUrl": "ws://127.0.0.1:3001",
      "httpUrl": "http://127.0.0.1:3000",
      "accessToken": "换成长随机串",
      "allowFrom": ["private:你的QQ", "group:你的群"],
      "outboundAllow": ["private:你的QQ", "group:你的群"],
      "replyAudit": true,
      "ownerQQ": "你的QQ",
      "mediaAllowDirs": ["/home/user/.openclaw/workspace"]
    }
  }
}
```

部署检查：

1. OneBot 的 WS/HTTP 只监听内网或本机，不要暴露公网。
2. `accessToken` 与 NapCat 侧配置一致，且不是默认值。
3. `mediaAllowDirs` 只放确实需要发送的目录，**不要**写 `/` 或 `~`。
4. `sharedDir` 与 NapCat 的挂载点一致，且不包含敏感文件。

---

## 五、发布前回归

```bash
npm run typecheck        # 0 错误
npm test                 # 208 用例全绿
npm run audit:prod       # 生产依赖 0 漏洞
```

人工回归：

- [ ] **R-1**：只配默认账号，确认启动日志出现 `allowFrom is empty` 警告
- [ ] **R-1**：不配 `mediaAllowDirs`，往 workspace 里的图片发送，确认被拒且报错可读
- [ ] 默认账号配 `mediaAllowDirs`，确认图片能发（v0.2.1 的字段丢失回归）
- [ ] 发一条 TTS 语音，确认不是「语音回复发送失败」
- [ ] 发 `[CQ:image,file=http://x/y.png]` 文本，确认对方收到的是文本
- [ ] 群里先发「你好」再发 `/silent`，确认命令生效（聚合绕过回归）
- [ ] `git ls-files` 里不含 `a.png` / `a.mp3` 之类测试残留

---

## 六、变更影响矩阵

| 改动文件 | 必须回来检查 |
| --- | --- |
| `paths.ts` | 第三节 R-1 / R-10，以及「媒体文件放在哪」的 README 段 |
| `policy.ts` | 第二节全部边界、第三节 R-2 |
| `outbound.ts` | 第二节「出站唯一通道」——新增发送类型必须走 `dispatchSend` |
| `config.ts` | 第三节 R-1、README 配置表 |
| `gateway/*` | 第二节「控制命令硬执行」、第三节 R-6 |
| `voice-*.ts` | 第三节 R-4、第二节「语音临时文件」 |
| `types.ts` / `openclaw.plugin.json` | 第三节 R-11：`npm run manifest:check` 必须过；新字段要同时进顶层和 `$defs.account` |

改了 `openclaw.plugin.json` 之后，**只跑 `npm test` 不够**——测试能过、字段名能对上，但 schema 仍可能在校验时拒掉合法配置（v0.3.1 就是这样漏的）。`manifest:check` 与 ajv 用例要一起跑。
