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
