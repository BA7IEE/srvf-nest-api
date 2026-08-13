# 语义门收口报告 —— 架构治理 Phase 5(R14 / R11 / FE client)

> 性质:交付收口记录(观测型)。规则权威源见 [`AGENTS.md`](../../AGENTS.md);
> 判定规则的**唯一实现**在各自脚本头注,本文件只做索引与取证留痕,不复制判定表。
> 拍板记录见 [`DECISIONS-2026-08-13.md`](../archive/reviews/architecture-governance-v4/DECISIONS-2026-08-13.md)。

## 0. 给业务 lane 的新规(一行)

> **改动端点授权声明或破坏契约 = 需维护者审批,不能自批。**

已同步进 [`docs/reference/swagger.md §8`](../reference/swagger.md)(触碰即读的细则层)。

三门上线时点:R14 = PR #988(2026-08-13 合入);R11 = PR #992;FE client = 本刀。
`pull_request_target` 恒跑 **base 分支**的 workflow 定义 ⇒ 每道门都在**合入后的下一个 PR** 起真跑,
提出它的那个 PR 自己不会被它拦(base-trusted 的固有性质,不是缺陷)。

## 1. 三门结构

| 门 | 层 | 比对对象 | 判据实现 | 裁判 |
|---|---|---|---|---|
| R14 授权语义 | L4 | `ROUTE_AUTHZ.md` 内嵌 manifest | `scripts/authz-semantic-diff.ts` | `.github/workflows/authz-trusted-judge.mjs` |
| R11 契约语义 | L6 | `docs/handoff/openapi.json` | `scripts/contract-semantic-diff.ts` | `.github/workflows/contract-trusted-judge.mjs` |
| FE client 新鲜度 | L6 | `docs/handoff/clients/**` | `scripts/generate-fe-client.ts --check` | Fast checks(Docs guards 同链) |

**两级结构(R14 与 R11 逐字相同,不是两套)**:

1. **申报完整性 = 硬闸**。缺申报 ⇒ `Red-zone trusted scan` 失败 ⇒ `approval` job 被跳过 ⇒
   **没有可点的审批按钮**,点头也盖不掉。
2. **Environment 审批 = 人闸**。申报齐全后才轮到维护者在 `harness-review` 点批。

顺序不可颠倒。**申报只构成记录,不构成批准**(DECISIONS 2026-08-09 第 10 条)。

三路裁决(红区 / 授权 / 契约)共用同一次 base checkout 与同一个 `harness-review` 环境,聚合进既有
`Red-zone (trusted)` verdict —— **不新增 required context**(新 context 会卡死所有 base 上没有它的在飞分支)。
verdict 对三路都要求明确的 `true`/`false`,空串一律拒绝(「没查出来」≠「没触碰」)。

## 2. 真实 gate 输出样例

### 2.1 R14 —— 降级被拦(真触发验证,PR #990 第一推,故意不带申报)

`Red-zone trusted scan` **fail**(11s)· `Red-zone trusted approval` **skipping**(无按钮可点):

```
授权语义裁判:base=main · PR #990
[L4/R14] 授权语义 diff —— ROUTE_AUTHZ base ↔ head
  BROADER=1  INCOMPARABLE=0  NARROWER=0  ADDED=0  REMOVED=0  EQUIVALENT=497  (共 498 个端点)

  ── 全量语义迁移清单(升/平/降恒可见)──
  · [BROADER] 降级(须申报+审批)  GET /api/admin/v1/me
      UsersController.getMe
      mode: LOGIN_ONLY → PUBLIC  ⇒ BROADER

[L4/R14] GET /api/admin/v1/me  AdminMeController.getMe
  事实: 授权语义判定 BROADER(保护等级降级):mode BROADER(LOGIN_ONLY → PUBLIC)
  依据: docs/ai-harness/ROUTE_AUTHZ.md 的 base↔head 结构化策略;判定规则见 scripts/authz-semantic-diff.ts 头注
  处置: ① 若非本意 —— 改回声明,让本端点回到 EQUIVALENT/NARROWER;② 若确需放宽 —— 在 changelog.d/ 的
        fragment 里补 authz-downgrade 申报块(route/reason/impact/migration 四行),并由维护者在
        harness-review 环境点批。申报是记录载体,不构成批准(DECISIONS 第 10 条),AI 不得自批。
##[error]授权语义门:存在降级 / 不可比端点却没有完整申报
```

§10 五要素齐备:①`[L4/R14]` ②`GET /api/admin/v1/me AdminMeController.getMe` ③事实句
④依据(指到具体判据文件)⑤修复路径(两条合法出口 + 「AI 不得自批」)。

**第二推(补上申报)**:`scan` **pass**(15s)、`approval` **pending**:

```
授权语义裁判:base=main · PR #990
  本 PR 改动的 changelog fragment:1 份
  BROADER=1  INCOMPARABLE=0  NARROWER=0  ADDED=0  REMOVED=0  EQUIVALENT=497
⚠️ 本 PR 含授权降级 / 不可比端点,申报已齐全 —— 需要维护者在 harness-review 环境点批
```

### 2.2 R14 —— 收紧放行(反向对照,PR #991)

`scan` **pass**(8s),`authzRequired=false`:

```
  BROADER=0  INCOMPARABLE=0  NARROWER=1  ADDED=0  REMOVED=0  EQUIVALENT=497  (共 498 个端点)
  ── 全量语义迁移清单(升/平/降恒可见)──
  · [NARROWER] 收紧(放行,恒可见)  GET /api/open/v1/contents
      mode: PUBLIC → LOGIN_ONLY  ⇒ NARROWER
  ✓ 无阻断项。
✓ 无授权降级 / 不可比端点(收紧与新增已列在上方全量迁移清单里)
```

⚠️ 该 PR 的 `approval` 仍 pending —— 但日志确认它**只**来自红区那一路
(`触碰受保护路径 1 处,命中 architecture-governance-phase0-artifacts`)。因为 `ROUTE_AUTHZ.md`
本身在 selfGuard 内,**任何**授权声明改动都已经会触发红区审批。
**R14 的边际贡献因此不是「触发审批」**,而是:把变化分类成升/平/降、**降级强制申报**、
**申报缺失时硬失败**(最后一条审批盖不掉)。

### 2.3 R14 —— 日常无变化(PR #992,门已在真 PR 上运行)

```
授权语义裁判:base=main · PR #992
  BROADER=0  INCOMPARABLE=0  NARROWER=0  ADDED=0  REMOVED=0  EQUIVALENT=498  (共 498 个端点)
✓ 无授权降级 / 不可比端点(收紧与新增已列在上方全量迁移清单里)
```

### 2.4 R11 —— 无契约变更(PR #993,裁判首次真跑)

真实 CI 输出(`Red-zone trusted scan` **pass**,14s):

```
契约语义裁判:base=main · PR #993
  契约来源:未改动(HEAD == BASE)
  本 PR 改动的 changelog fragment:1 份
  (比较器取自 base checkout;未装依赖、未执行 PR 内脚本)

[L6/R11] 契约语义 diff —— docs/handoff/openapi.json base ↔ head
  breaking=0  additive=0

  契约无语义变化。
  ✓ 无阻断项。
✓ 无破坏性契约变更(additive 变更已列在上方报告里)
```

破坏形态的五要素输出(探针实测,`B2` 响应字段删除):

```
[L6/R11] POST /api/probe
  事实: 破坏性契约变更 1 处:[B2/response-field-removed] response title — 响应字段被删除,依赖它的调用方会拿到 undefined
  依据: docs/handoff/openapi.json 的 base↔head 语义分类;判定表见 scripts/contract-semantic-diff.ts 头注
  处置: ① 若非本意 —— 改回契约,或用兼容写法(新增可选字段 / 并行新端点)让它变成 additive;
        ② 若确需破坏 —— 在 changelog.d/ 的 fragment 里补 contract-breaking 申报块
        (operation/reason/impact/migration/rollback 五行),并由维护者在 harness-review 环境点批。
        申报是记录载体,不构成批准;rollback 填真回滚手段(revert / feature gate / 兼容层),
        changelog 文件本身不是回滚。
```

### 2.5 FE client 新鲜度

```
[L6/R11] 前端 client 产物已陈旧,与当前契约不一致:
  · docs/handoff/clients/admin/types.ts
事实: 重新生成后与仓内产物逐字不符 —— 契约改了而 client 没刷新,或产物被手改。
依据: docs/handoff/clients/**(生成物,禁手改;新鲜度由本检查守护)
处置: 跑 `pnpm docs:feclient` 重新生成并提交;不要手改产物。
```

## 3. selftest 阳性对照清单

`pnpm harness:selftest` 的 guards 段(`scripts/harness-guards.selftest.ts`),Phase 5 新增 **81 条**:

| 组 | 条数 | 覆盖 |
|---|---:|---|
| R14 四态比较器 | 41 | 六类降级各一例;`all`/`any` 码集方向各一例 + **两条负样例**(方向判反即红);`LOGIN_ONLY ↔ PUBLIC` 相邻级正反各一;engine 变化(两侧有判定面)不可比 + 惰性 engine 不误判;换码空图不可比 / 有边可定向 / 反向降级;复合变更不可比;码绑定 scope 去除=降级;收紧进迁移清单且不阻断;申报四态;蕴含图五类结构校验;manifest schemaVersion fail-closed;真 manifest 自比全等价 |
| R11 判定表 | 20 | 九类 breaking 各一例;**四条反方向 additive**(方向写反即红);契约无变化零 finding;申报四态(含缺 `rollback`);判定表 9 类齐全且 id 唯一;真 openapi 自比零 finding |
| FE client | 12 | digest 形状 / 确定性 / 输入变化必翻转;产物头部无时间戳 SHA;**五 surface 十一文件**;**全仓零重复定义** + 共用类型确实在 shared;产物代码部分无传输层/鉴权头/硬编码端点 + **剥注释有效性双向正对照**;自校验阳性对照(坏产物必被抓)+ 真产物零诊断 |
| F3 裁判禁令 | 17 | 授权裁判 8 条 + 契约裁判 9 条:脚本取自 base 固定路径 / 只 import `node:` / 判据登记表取自 base / 走 API 给的 URL / 翻页对账 / 只 parse 不执行 / 申报缺失是硬失败 / 异常 fail-closed / verdict 三路聚合 |
| 红区收编 | 1 | `scripts/*-semantic-diff.ts` 的正反样例(反样例含 `.mjs` 旁路形状) |

**变异 A/B 取证**(改判据 → 看红分布,证明断言不是空绿):

| 变异 | 红数 | 红分布 |
|---|---:|---|
| `any→any` 方向判反 | 3 | 恰好 any 两条 + 负样例 |
| mode 降级判成收紧 | 4 | 四条 mode 降级 |
| `PUBLIC` 与 `LOGIN_ONLY` 拉平 | 2 | 相邻级正反两条 |
| 去 admission 判成收紧 | 2 | admission + 复合变更 |
| engine 闸拆掉 | 1 | 精准 |
| 申报完整性闸拆掉 | 2 | 精准 |
| 蕴含闭包恒可达 | 8 | 全部码集方向 |
| verdict 去掉 authz 那一路 | 1 | 精准 |
| 申报缺失降级成 `failClosed` | 1 | 精准 |
| 蕴含图改从 head 取 | 1 | 精准 |

> `PUBLIC`/`LOGIN_ONLY` 拉平那条最初 **0 红** —— 原「任何模式→PUBLIC」样例起点是 RBAC、跨了两级。
> 缺口由变异测试查出并当场补齐,不是读代码读出来的。

## 4. 已知性质与缺口

### 4.1 `WRITE-GUARD-LITERAL-ONLY`(定性:已知性质,非漏洞)

写侧 hook 按**命令文本里的字面路径**匹配,不做数据流分析:

| 命令 | 拦截 |
|---|---|
| `echo x > AGENTS.md` | 是 |
| `node -e "require('fs').writeFileSync('AGENTS.md','x')"` | 是 |
| `node -e "const p='AGENTS'+'.md'; …writeFileSync(p,'x')"` | **否** |
| `pnpm docs:authz` / `docs:codemap`(路径在程序内) | **否** |

与 eslint 那批「变量中转 / 计算属性」缺口同形 —— 这一层是**字面拦截**,不是数据流执法。
生成物必须能被重生成,否则改一次路由声明就永远过不了 `docs:authz:check`。
**兜底仍在**:CI 侧 `check-redzone` 按 diff 如实标红,base-trusted 裁判要求环境审批
(PR #991 实测)。即本地那道闸在 AI 侧靠自觉,**人闸在 CI 侧仍然成立**。

已登记为 selftest 已知缺口,**随每次 `harness:selftest` 打印**,并由真探针证明其仍然存在 ——
缺口一旦被修好,探针翻面 → selftest 红 → 逼人来摘登记。

### 4.2 到期闸:`SEED_CROSS_CHECK_IMPLEMENTED`(维护者 2026-08-13 要求)

「本次未做」不能只躺在报告里等人记得。沿本仓既有范式 —— **「此刻不存在」型判据必须写明
到期条件** —— 把它写成执行位:

- **到期条件 = 有人往蕴含图里加第一条边**。`validateGraph` 判
  `edges.length > 0 && !SEED_CROSS_CHECK_IMPLEMENTED` ⇒ 红;
  `pnpm gate:authz:graph:check` 在 Fast checks 里恒跑,所以这条闸每个 PR 都在岗。
- 错误信息写明「**接法不得破坏比较器的零依赖 / 双运行时**」,并给出可行方向
  (另出一支只在 Fast checks 跑的检查器,把核对结果落成登记表字段)——
  否则下一个人会用破坏地基的接法去补它,而那条地基比这条核对更根本。
- **防「只翻标志位不实现」**:selftest 结构断言要求标志位为 `true` 时必须同时导出并调用
  `crossCheckSeedBindings`,且判的是**剥注释后的源码**(注释里写着函数名不算数)。

真触发实测(2026-08-13):

| 触发 | 结果 |
|---|---|
| 往登记表加第一条边 → `pnpm gate:authz:graph:check` | **exit 1**,事实句点名 Exit Criteria |
| 只把标志位翻成 `true` → `pnpm harness:selftest` | **3 红**(含防翻转那条) |
| 空集(当前状态) | 放行,不误伤 |

### 4.3 与 v4 字面表述的偏离(已拍板)

R14 `engine` 轴收敛为「仅当两侧都有判定面时才恒 `INCOMPARABLE`」。理由、实测依据(498/498)、
被否决的字面版会造成的噪音,见 [`DECISIONS-2026-08-13.md`](../archive/reviews/architecture-governance-v4/DECISIONS-2026-08-13.md) 第 1 条。

R11 判定表在 goal 清单基础上补齐了**响应侧反方向**两类(B6 响应枚举加值 / B8 响应变可空)。
goal 给的「枚举值删除」「nullable 翻转为不可空」是请求侧形状;只做请求侧会漏掉一半破坏面。

## 5. 本次未做

| 项 | 状态 | 说明 |
|---|---|---|
| 蕴含图 ↔ seed 绑定矩阵一致性核对 | **未做,但已装到期闸** | v4 §7 R14 的 Exit Criteria 之一。初始边集为空 ⇒ 当前真空;实现它需要 TS AST 解析 seed 的角色→码矩阵,会破坏比较器「零依赖 / 双运行时」这条地基(那是 base-trusted 裁判与本地共用同一份判据的前提,比这条核对更根本)。**到期条件已写成执行位,不靠人记得** —— 见 §4.2。已实现的是**码存在性 + 自环 + 成环**校验(对着 RBAC_MAP 的 234 码全集) |
| ~~`auth/v1` / `system/v1` / `open/v1` 的 TS client~~ | **已补齐** | 维护者 2026-08-13 拍板全覆盖:部分生成 = 剩下那部分回到手写 = 亲手造第二份真相。现为 5 surface × 2 文件 + 1 份 `shared/types.ts`;共用集**算出来**(≥2 surface 引用)而非硬编码,全仓零重复定义由 selftest 机核 |
| 手写 handoff 的字段/端点复制面收缩 | **未做** | goal 明确留后续,避免与前端适配债耦合 |
| R2/R3/R5/R8 转 blocking · 状态机治理 · authz 倒置 · 大 service 拆分 | **未做** | 均在 goal 硬边界之外(Phase 3 / Phase 4 / Phase 7 另立项) |
| ~~R11 裁判在真 CI 上的首次运行取证~~ | **已完成** | PR #993 首次真跑,输出见 §2.4。FE client 新鲜度门同理,从下一个 PR 起在 Docs guards 里真跑 |

## 6. 判据文件索引

| 文件 | 作用 |
|---|---|
| `scripts/authz-semantic-diff.ts` | R14 四态比较器(零依赖,tsx 与裸 node 双运行时共用) |
| `scripts/contract-semantic-diff.ts` | R11 breaking 判定表 + 分类器(同上) |
| `scripts/generate-fe-client.ts` | FE client 生成器(含产物自校验) |
| `harness/authz-implication-graph.json` | 权限蕴含图(初始空集 = 换码恒不可比) |
| `.github/workflows/authz-trusted-judge.mjs` | R14 base-trusted 接线(仅管道) |
| `.github/workflows/contract-trusted-judge.mjs` | R11 base-trusted 接线(仅管道;契约 3.8MB 走 `raw_url`) |
| `.github/workflows/redzone-trusted.yml` | 三路裁决聚合 + 单一 `harness-review` 审批 |
