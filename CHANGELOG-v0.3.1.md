# v0.3.1 — 不重构，而是把"看不见的错误"变成可见

日期：2026-10-29
基线：v0.3.0（208 用例 / 无 CI 以外的类型检查 / manifest 缺 5 个安全字段）

---

## 一、为什么不做完全重写

`rewrite/` 骨架（490 行）证明了四件事可行：zod 单源、无构建、纯决策层、manifest 生成。

但它是**骨架**，不是实现：真正的 IO 层（WebSocket 连接、HTTP API 调用、媒体暂存、silk 转码、NapCat 上传）一行都没有。所谓"重写"，实际工作量是 2000+ 行，而其中 90% 是**对着真实 QQ 环境试出来的行为**——1.5s 聚合窗口、语音格式协商、上传路径规则。

这些不是设计出来的，是试出来的。重写等于重交一遍学费。

**结论**：保留 v0.3.0 的业务实现，把 `rewrite/` 的**格式决策**逐项移植回来。这一版做的是其中风险最低、收益最高的三项。

---

## 二、这次改的

### 1. 测试纳入类型检查（60 个错误 → 0）

`tsconfig.json` 的 `exclude` 里有 `"test"`，所以 208 个用例从未被编译器看过。强制纳入后：

```
60 errors:
  29 × TS2739/2741  fixture 缺必填字段（groupAutoReact / replyAudit / …）
  23 × TS2722/18048/2532  调用可选成员未断言
   4 × TS2554        isConfigured(account) 少传 cfg（API 早就加了这个参数）
   1 × TS2790        delete 一个必填属性
```

那 29 处**正是 H1 的成因现场**：测试自己拼 account 对象，少字段编译器不报，所以 `mediaAllowDirs` 丢了三个版本都没人知道。

修法不是逐个补字段，而是新建 `test/helpers/fixtures.ts`：

```ts
export function makeAccount(overrides = {}): ResolvedOneBotAccount { … }
```

32 处字面量替换成 `makeAccount({ … })`。以后给 `ResolvedOneBotAccount` 加必填字段，只需要改这一个文件，编译器会告诉你还差谁。

新增 `tsconfig.test.json`（`noEmit` + 含 `test/**`），`npm run typecheck` 现在跑两个工程。

### 2. manifest schema 补齐 5 个安全字段

`openclaw.plugin.json` 声明 `additionalProperties: false`，而那五个字段（`ownerQQ`、`outboundAllow`、`outboundDeny`、`replyAudit`、`mediaAllowDirs`）**从来不在里面**——插件对外宣称的全部硬化能力，在运行时校验器眼里都不存在。

已补齐，每个字段都带 `description`（这同时是用户唯一能在配置界面读到的文档）。

并加两道守卫：

| 守卫 | 位置 | 作用 |
| --- | --- | --- |
| 脚本 | `scripts/check-manifest-fields.mjs` | TS 字段 ⊆ schema 字段，否则退出码 1 |
| 测试 | `test/manifest.test.ts` | 4 条用例，含五个安全字段与默认值断言 |

检查方向是**单向**的：schema 可以有 TS 没有的字段（宿主注入的 `commands`、`streaming`），但 TS 有而 schema 没有的一律失败。

### 3. 测试结果不再随调度变化

并行跑时每次文件数不同：17 / 18 / 20，用例 176 / 193 / 212，而 **exit code 始终是 0**。

根因是 Windows 上 worker 竞争 SSR 模块缓存，失败者抛 `EPERM`，vitest 归到 "Unhandled Errors" 但仍然打印 "passed"。一个静默丢掉三个测试文件的绿，比一个红的测试危险得多。

三处修正：

- `vitest.config.ts` 加 `fileParallelism: false`（串行 70s，可接受）；`npm run test:fast` 保留并行给日常开发；
- `dangerouslyIgnoreUnhandledErrors: false`；
- `scripts/check-test-count.mjs`：跑过的文件数必须等于磁盘上的文件数，否则失败。

### 4. sourceMap + inlineSources

`declaration: true` 却 `sourceMap` 缺省，正好搞反了——给消费者生成 `.d.ts`（没人读），不给自己留行号映射（最需要）。

现在 `dist/src/policy.js.map` 里 `sources: ["../../src/policy.ts"]`，`sourcesContent` 内嵌源码。一个卖点是"我在源码第 N 行拦住了你"的插件，最该保留的就是这条映射。

顺带删掉 `"noImplicitAny": false`——实测打开后 0 错误，那行是废配置，不是漏洞。

### 5. symlink 用例改为能力探测

`policy.test.ts` 的两条符号链接用例直接 `symlinkSync`。Windows 无开发者模式时 `EPERM`，会让我上一轮加的 Windows CI 变红——为环境限制而红，会训练人忽略 CI。

改成一次性探测 + `it.skipIf`，本机现在是 `206 passed | 2 skipped`。

---

## 三、实测

| 项 | v0.3.0 | v0.3.1 |
| --- | --- | --- |
| `tsc --noEmit`（仅 src） | 0 错误 | 0 错误 |
| `tsc`（含 test） | **未检查**（60 错误） | **0 错误** |
| 测试文件 | 19 | **20** |
| 用例 | 208 | **210 passed / 2 skipped** |
| 文件数确定性 | 17~20 抖动 | **固定 20** |
| manifest 缺字段 | **5 个安全字段** | 0 |
| `npm audit --omit=dev` | 0 | 0 |
| sourceMap | 无 | 有，含内嵌源码 |

```
$ npm run verify
  OK — every typed field is configurable
  Test Files  20 passed (20)
       Tests  210 passed | 2 skipped (212)
check-test-count: 20 ran, 20 on disk
  OK — every test file executed
found 0 vulnerabilities
```

---

## 四、没做的

| 项 | 为什么没做 |
| --- | --- |
| zod 单源 schema | 需要改 `types.ts` / `config.ts` / 生成脚本三处，是 v0.4 的量级。当前的两道单向守卫已经堵住了 H1 那一类，收益递减 |
| 去掉构建步骤 | `.ts` 入口是官方支持的（`package-entry-resolution` 源码确认），但还有 `install.sh`、`prepare-clawhub-plugin.mjs`、`react-test.mjs` 三处依赖 `dist`，且加载器在 `origin=config` 时优先 `dist/*.js`——迁移需要一次完整的安装回归，不适合夹在类型检查改造里 |
| oxlint | 独立改动，`no-unused-vars` 能拦住 N3 那类死代码，但会和这次的文件改动混在一起 |
| 出站队列 / 限流 / 语音 host 校验 | 产品决策，见 SECURITY.md R-4 / R-5 |

---

## 五、下一步建议

按"能否独立验证"排序：

1. **oxlint**（半天）：零配置接入，先只开 `no-unused-vars` + `no-floating-promises`，跑出当前问题清单再决定规则集。
2. **zod 单源**（1~2 天）：`accountSchema` 一份出三个产物（类型、`safeParse`、JSON Schema），把 `check-manifest-fields.mjs` 从"比对两份手写约定"降级为"生成唯一那份"。
3. **去构建**（1 天 + 一次安装回归）：删 `dist` 链路的前提是验证「无 dist 时加载器走 `.ts`」——`VERIFY-TS-ENTRY.md` 的 E1/E5 就是为此写的。
