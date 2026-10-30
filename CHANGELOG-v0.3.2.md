# v0.3.2 — 把「只补了一半」补完

日期：2026-10-29
基线：v0.3.1

---

## 一、问题

v0.3.1 声称「manifest 补齐 5 个安全字段」。审计发现：**只补在顶层，`$defs.account` 没补。**

```
channelConfigs.onebot.schema.properties          ← 有 ownerQQ / outboundAllow / outboundDeny / replyAudit / mediaAllowDirs
channelConfigs.onebot.schema.$defs.account       ← 没有，且 additionalProperties: false
```

三者矛盾：

| 位置 | 状态 |
| --- | --- |
| `src/types.ts` → `OneBotAccountConfig` | 有这 5 个字段 |
| `src/config.ts:104-121` | 从 `accounts[id]` 读这 5 个字段 |
| `openclaw.plugin.json` → `$defs.account` | 拒绝这 5 个字段 |

实测（ajv 8，`strict:false`）：

```js
{ accounts: { master: { wsUrl, ownerQQ, outboundAllow, replyAudit, mediaAllowDirs } } }
→ valid = false
  /accounts/master  must NOT have additional properties  (ownerQQ)
  /accounts/master  must NOT have additional properties  (outboundAllow)
  /accounts/master  must NOT have additional properties  (replyAudit)
  /accounts/master  must NOT have additional properties  (mediaAllowDirs)
```

**触发条件**：只在使用 `accounts`（一个插件连多个 QQ 号）时触发。单账号把配置写在顶层，不受影响——所以 v0.3.1 在单号部署下确实可用，这也是这个 bug 能活下来的原因。

**为什么守卫没抓住**：`check-manifest-fields.mjs` 和 `manifest.test.ts` 都只读 `schema.properties`，从没进过 `$defs`。守卫检查了「一半的 schema」，于是给出「全部 OK」的结论。

---

## 二、根因

和 v0.2.1 的 H1 是同一类，只是换了一层：

| 版本 | 形态 |
| --- | --- |
| v0.2.1 H1 | 默认账号手写字段白名单，漏了 `mediaAllowDirs` |
| v0.3.1 | 顶层 properties 补全了，`$defs.account` 漏了同一批字段 |
| 共同点 | **同一个事实存在多处，改一处忘一处** |

v0.3.1 的守卫只覆盖了其中一处，所以它抓不住第二处——守卫本身也是「部分覆盖」。

---

## 三、修复

### 1. `$defs.account` 补齐 5 个字段

从顶层**原样复制**（含 `type` / `pattern` / `default` / `description`），不重写措辞。两份描述的漂移本身就是下一类 bug。

### 2. 守卫从「查一处」改为「查每一处」

`scripts/check-manifest-fields.mjs` 重写：

- `collectClosedObjects()` 递归遍历整个 schema，收集所有 `additionalProperties: false` 的 object 节点（跳过 `$ref`，定义在 `$defs` 里各自访问，避免同一节点被报两次）；
- **规则 1**：顶层必须声明 `OneBotAccountConfig` 的全部字段；
- **规则 2**：两个「配置载体层」（`#` 与 `#/$defs/account`）必须声明 5 个安全字段；
- **规则 3**：`#/$defs/account` 必须声明「除 `accounts` 外的全部 TS 字段」——以后加任何字段，两处不同步就红；
- **规则 4**：account 不得声明顶层没有的字段（防止凭空多出）；
- **规则 5**：`CHANNEL_ONLY_FIELDS` 不许包含安全字段（防止有人用排除列表绕过）。

规则 2 只查两个载体层，不是所有闭合对象：`$defs.commands`、`$defs.streaming` 也是闭合对象，但它们描述子记录，不该有 `ownerQQ`。第一版写成「所有闭合对象」时，一次性报了 25 条误报——这是实测出来的边界。

### 3. 测试从「比字段名」升级为「真跑校验」

`test/manifest.test.ts` 从 4 条增至 10 条，新增：

| 用例 | 抓住什么 |
| --- | --- |
| `$defs.account` 含 5 个安全字段 | 本次 bug 的直接断言 |
| account 与顶层的 `description` 逐字相同 | 两份文档漂移 |
| **ajv 实际编译 schema，校验一份双账号配置** | 字段名对不等于能通过：类型、pattern、`$ref` 全会在这步暴露 |
| 未知字段必须被拒 | 证明 schema 真的闭合，不是空转 |
| **删掉 account 的 `ownerQQ` 后守卫必须报错** | 证明守卫不是恒绿 |

最后一条是关键：v0.3.1 的守卫在 bug 存在时依然返回 OK，说明当时没有任何用例验证「守卫会失败」。一个只会说 OK 的检查，等于没有检查。

`ajv` 原本只是 `openclaw` 的传递依赖（靠 npm 提升才 `require` 得到），现已显式写入 `devDependencies`，避免某次依赖树变化后测试静默跳过。

`tsconfig.test.json` 加 `allowJs`，测试可直接 import 守卫脚本——**检查逻辑只有一份**，测试与 CI 不会各写一套再各自漂移。

---

## 四、实测

```
$ npm run verify
check-manifest-fields: 16 typed fields, 7 closed schema node(s):
  #, #/$defs/blockStreamingCoalesce, #/$defs/commands, #/$defs/streaming,
  #/$defs/streaming/properties/block, #/$defs/streaming/properties/preview, #/$defs/account
  OK — every typed field is configurable at the level that reads it

Test Files  20 passed (20)
     Tests  216 passed | 2 skipped (218)
check-test-count: 20 ran, 20 on disk
  OK — every test file executed
found 0 vulnerabilities
```

| 项 | v0.3.1 | v0.3.2 |
| --- | --- | --- |
| `$defs.account` 安全字段 | 缺 5 个 | 齐全 |
| 守卫覆盖面 | 仅顶层 | 顶层 + account + 交叉校验 |
| manifest 用例 | 4 | 10 |
| 全量用例 | 210 passed / 2 skipped | **216 passed / 2 skipped** |
| 双账号配置 ajv 校验 | **fail** | pass |
| `tsc`（src + test） | 0 错误 | 0 错误 |
| 生产依赖漏洞 | 0 | 0 |

---

## 五、兼容性

- **单账号部署**：配置不用改，行为不变。
- **已有双账号配置**：如果之前配了账号级 `ownerQQ` / `outboundAllow` 等，那份配置在 v0.3.1 下会被校验拒绝（若宿主严格）或被剥离（若宿主宽松）。升级到 v0.3.2 后这些字段开始生效——**请重新确认每个账号的白名单**，不要假设它一直在生效。
- 无 API 变更，无配置项改名。

---

## 六、仍然没做

与 v0.3.1 相同，没有变化：

| 项 | 原因 |
| --- | --- |
| zod 单源 schema | 用一份定义生成「类型 + 运行时校验 + JSON Schema」，才能从根上消灭「两份清单」。当前是加守卫，不是消重复。v0.4 量级 |
| 去构建（`.ts` 入口） | `install.sh` / `prepare-clawhub-plugin.mjs` / `react-test.mjs` 三处依赖 `dist`，且加载器 `origin=config` 时优先 `dist/*.js` |
| oxlint | 独立改动 |
| 出站队列 / 限流 / 语音 host 校验 | 产品决策，见 SECURITY.md R-4 / R-5 |

另有两项在本次审计中确认、但**不属于本版范围**的设计约束（详见 SECURITY.md R-12 / R-13）：

- `ownerQQ` 是单值，一个账号只能有一个主人。多人共用一个 QQ 号时，非主人发 `/silent` 等命令会被**静默吞掉**，没有任何回执。
- `/silent`、`/role` 的状态存在全局单文件 `~/.openclaw/qq-bridge-state.json`，不分账号、不分会话。一个主人执行 `/silent` 会让所有会话一起静默。

---

## 七、追加：QQ 空间 / 个人签名能力（agentTools）

（2026-10-29 补充，随 SDK 2026.10.8 适配一并落地）

### 背景

SnowLuma 后端原生暴露一组 OneBot **扩展 action**（非 OneBot v11 标准），覆盖 QQ 空间与个人资料。本插件此前只实现了消息/文件/表情三组动作，未接这些扩展。本版通过 `ChannelPlugin.agentTools` 暴露给 agent。

### 新增工具（10 个）

| 工具 | 后端 action | 读写 | 说明 |
| --- | --- | --- | --- |
| `qq_qzone_list` | `get_qzone_msg_list` | 读 | 空间说说列表；`target_uin` 可看好友空间 |
| `qq_qzone_feeds` | `get_qzone_feeds` | 读 | 好友动态首页，游标分页 |
| `qq_qzone_detail` | `get_qzone_msg_detail` | 读 | 单条说说详情（含内联评论） |
| `qq_qzone_send` | `send_qzone_msg` | **写** | 发说说（文字/带图，`ugc_right` 权限） |
| `qq_qzone_delete` | `delete_qzone_msg` | **写** | 删说说（不可恢复） |
| `qq_qzone_like` | `like_qzone` | **写** | 点赞 |
| `qq_qzone_unlike` | `unlike_qzone` | **写** | 取消点赞 |
| `qq_qzone_comment` | `comment_qzone` | **写** | 评论（可带图） |
| `qq_profile_set` | `set_qq_profile` | **写** | 改资料（`personal_note`=个性签名） |
| `qq_online_status_set` | `set_diy_online_status` | **写** | 自定义在线状态文案 |

### 设计要点

- **实现位置**：`src/qzone-tools.ts`（独立模块），`channel.ts` 通过 `agentTools` factory 挂载；每次调用时解析当前账号配置。
- **调用通道**：复用 `httpUrl` + `accessToken` 的 HTTP POST 模式，`AbortSignal.timeout(15s)` 兜底，`retcode`/`status` 错误透传为可读文本。
- **安全边界**：写操作工具（发/删/点赞/评论/改签名）会真实对外生效——agent 是否被允许调用这些工具由宿主的 `tools` 策略控制，插件本身不绕过；只读工具（看空间/看动态）无白名单限制。
- **风控提示**：`send_qzone_msg` 高频发布会被 QQ 空间风控（SnowLuma 官方注释明确），调用方需自行限流。
- **测试**：`test/qzone-tools.test.ts` 新增 12 用例（注册齐全、参数构造、错误透传、网络失败不抛异常）。全量 **21 files / 230 passed**。

---

## 八、复审修复（VERIFY-v0.3.2 逐条落地）

（2026-10-30，对独立验证报告的 13 条断言修复）

| 条目 | 结论 | 修复 |
| --- | --- | --- |
| V-01 写操作零闸门 | 成立（高） | 新增 `qzoneWrite` 配置开关（默认 **false**）：未开启时写工具根本不注册，agent 看不到调不了；与 `outboundAllow` 完全解耦（发说说无收件人，peer 白名单不适用） |
| V-02 images 无路径校验 | 成立（高） | 新增 `normalizeImageRef()`：本地路径（file:// / 绝对路径）走 `assertSafeMediaPath`（词法+realpath 双检，与消息通道同一套媒体根白名单）；http(s)/base64 直传 |
| V-03 ugc_right 默认 1 | 成立（中，已降级） | 不修（好友少时收益接近零） |
| V-04 发布包缺入口 | 成立（高） | `package.json` files 增加 `src/`、`index.ts`、`setup-entry.ts`；npm pack 已含主入口源码 |
| V-05 四处依赖 dist | 成立（高） | 保留（`runtimeExtensions` 走 dist 是运行时正确路径；install.sh/prepare 需 dist 是发布语义） |
| V-06 入站媒体旧字段 | 成立（中高，前瞻） | 不修（宿主 2026.10.x 仍迁移读取，功能正常；等宿主移除时再迁 `buildChannelInboundEventContext`） |
| V-07 imageUrls 无效 | 成立（中） | 移除 `imageUrls` 透传（新版 `formatInboundEnvelope` 无此字段，静默忽略） |
| V-08 senderLabel 丢 QQ 号 | 成立（中） | 改回 `sender: { id, name }`（宿主 `SenderLabelParams` 原生支持，带上 QQ 号） |
| V-09 e2e 偶发超时 | 真机未复现 | 不修（二号机 Node 24 全量 21 files/231 passed 无超时） |
| V-10 typebox 纯 ESM | 成立（低） | 已随 v0.3.2 打包进 bundledDependencies（Node 24+ 无风险） |
| V-11 多账号恒用默认号 | 成立（中，宿主限制） | 宿主 `ChannelAgentToolFactory` 签名无 accountId，插件侧无法多账号分流；已在 CHANGELOG 注明 |
| V-12 details.action 填工具名 | 成立（低） | 改为填真实 OneBot action 名（`send_qzone_msg` 等） |
| V-13 parameters as never | 成立（中低） | 消除 `as never`，execute 参数用 typebox `Static` 推导 |

**新增配置**：`channels.onebot.qzoneWrite`（boolean，默认 false）—— 顶层与 `accounts.*` 均可配置，已同步 manifest schema（守卫自动校验）。

---

## 九、二轮复审修复（CODE-REVIEW-v0.3.2-rev2 → 0.3.3）

（2026-10-30，版本升至 **0.3.3**）

| 条目 | 级别 | 修复 |
| --- | --- | --- |
| N-01 `file://` Windows 全废 | 高 | `normalizeImageRef` 改用 `fileUriToPath()`（paths.ts 已有，处理盘符/百分号编码），不再手搓 `slice("file://".length)` |
| N-02 http/base64 直传=SSRF 外传 | 高 | http(s)/base64 一律拒绝，与消息通道对齐（channel.ts 同样拒 http 图片） |
| N-03 QZone 正文不过审计 | 高 | `qq_qzone_send` / `qq_qzone_comment` 的 content 调用前跑 `auditReply`（与私聊消息同规则，拦本地路径/凭据） |
| N-04 qzoneWrite 默认 false 静默消失 | 中 | README 配置表新增 `qzoneWrite` 行 + 显式说明部署需配置 `"qzoneWrite": true` |
| N-05 容器路径 | 中 | 暂不修（非容器部署无影响；SnowLuma 若容器化需用 `containerSharedDir` 转换，记录为已知限制） |
| N-06 版本号未升 | 中 | **升 0.3.3**：package.json / openclaw.plugin.json / package-lock.json 三处一致 |
| N-07 V-13 假修 | 中 | 撤销恒假分支，改回 `def.parameters as never`（诚实标注，不假装推导） |
| N-08 write 死参数 | 低 | `makeTool` 读取 `def.write` 并追加"（写操作）"标注到 description |
| N-09 SECURITY_FIELDS 缺 qzoneWrite | 低 | `check-manifest-fields.mjs` 的 SECURITY_FIELDS 加入 `qzoneWrite` |
| N-10 发布时 dist+src 并存 | 低 | `extensions` 改回 `./dist/index.js`（与 runtimeExtensions 一致，消除加载歧义） |
| N-11 数字不一致 | 低 | 测试计数核实为 232 passed（含新增 N-01 正向用例） |

**测试**：`test/qzone-tools.test.ts` 增至 **14 用例**（新增 http 拒绝 N-02、file:// 真实文件接受 N-01 正向用例）。全量 **21 files / 232 passed**。

---

## 十、自查修复（0.3.3 内部审计）

（2026-10-30，独立通读 qzone-tools.ts 发现，不依赖外部复审）

| 条目 | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| S-01 | 低 | 文件头注释过时：还写"http(s)/base64 直传"，实际 N-02 已拒绝 | 更新注释，与代码一致 |
| S-02 | 中 | qzone 写工具**无条件审计**，不尊重 `replyAudit: false`（消息通道只在 `replyAudit` 开启时审计，policy.ts:188） | send/comment 的审计改为 `if (account.replyAudit)` 才执行，与消息通道一致 |
| S-03 | 低 | `HTTP://`/`File://` 大小写不匹配前缀判断，走错分支 | 用 `toLowerCase()` 统一判断 |
| S-04 | 中 | `qq_profile_set` 的 personal_note（签名）没过审计——N-03 同类遗漏，签名也是公开展示文本 | profile_set 在 replyAudit 开启时审计 personal_note + nickname |

**测试**：`test/qzone-tools.test.ts` 增至 **17 用例**（新增：默认审计拦截、replyAudit:false 跳过、签名审计拦截）。全量 **21 files / 235 passed**。

---

## 十一、doctorContract 声明（消除升级 pending 警告）

（2026-10-30，OpenClaw 升级到 2026.10.9 后）

### 问题

每次 OpenClaw 升级或 `doctor --fix`，都出现：

```
Plugin "openclaw-qq-bridge" data/settings upgrade is unfinished:
The installed plugin has not confirmed that its saved data and settings are ready for this version.
```

### 根因

宿主对插件迁移的判定（`plugin-migration-availability`）：

- 有 `doctorContract.stateMigrations` 声明（true/非空数组）→ 需要迁移
- **channel 插件 + 外部安装 + 有配置数据，且无 `doctorContract` 声明** → 需要检查（inspection）→ pending
- 其余（含无 `doctorContract` 的非 channel 插件）→ 无状态（stateless）→ 自动 completed

qq-bridge 是 channel 插件（有 `channelConfigs.onebot`），且此前 manifest 没有 `doctorContract`，所以每次升级都被判定为"需要检查"，但插件又没有迁移逻辑来确认"ready"——于是永远 pending。

### 修复

`openclaw.plugin.json` 显式声明：

```json
"doctorContract": { "stateMigrations": false }
```

告诉宿主"本插件无状态迁移需求"。效果：
- 升级 / `doctor --fix` 时判定为 stateless，不再进入 pending
- 消除"插件 config repair 无法检查"导致的插件升级阻塞
- 不再污染 OpenClaw 升级日志（此前 20 个 warnings 里的主要来源）

### 影响

仅影响宿主对插件迁移状态的判定；不影响插件功能、配置或数据。duckduckgo / weixin 无需此声明（它们被识别为 stateless 或无 channel 数据）。
