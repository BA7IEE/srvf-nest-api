### Changed

- 🔴 **判据类闸的实质逻辑全部搬进 selfGuard —— 八条一起收口(修类不修实例)。**

  **缺陷**:`src/**/*.criteria.spec.ts` 这一族是近期各刀的**主交付物**(活动 v1.1 单一切换闸、
  权限元数据决策锁、seed 单向权威、报名准入、复合锚点闭合、冻结稿台账、可写 DTO 扫描、
  合并失败原因)。而 `src/**/*.spec.ts` **不在 selfGuard** —— 立项时实测八条 `harness:needs`
  **全部报「0 个需要授权」**。⇒ 执行位本身可以被任何 PR 顺手改成恒绿,零授权、零审批、零痕迹。

  🔴 **根因不是谁写错了一次,是一条被推广过的范式。** 仓内 memory 曾把这个形态当**优点**推荐
  ——「闸做成 criteria.spec + 非裁判命名 script,红区授权成本归零」。对判据类闸,
  「授权成本归零」恰恰是缺陷:**判据的价值就在于「改松它很麻烦」**。
  P2-8 的 changelog 里也逐字写着「判据落点刻意选 `*.criteria.spec.ts`,不进 `scripts/`」。

  ⭐ **「搬过去零额外代价」是实测,不是推测**:`generate-authz-manifest.ts` 的 `sourceFiles()`
  只 `visit('src')` ⇒ **`scripts/**` 整个不进** ROUTE_AUTHZ 的 inputDigest;它又排除 `*.spec.ts`
  ⇒ 判据 spec 也不进。两种形态都不占串行道,差别只剩「受不受保护」——
  既然如此,**没有理由选弱的那个**。

- **「什么算实质逻辑」的判据形态(先定标准,再逐条套,不逐条拍脑袋)**:

  > **实质逻辑 = 决定「红还是绿」的那部分。**
  > 薄运行器 = 只负责 `import` + `it(...)` 把结论喂给 jest,自身不含判定分支 / 扫描 / 阈值。

  机械化成五条 typed-AST 规则(即新闸的判据本体,不是文字要求):
  ① **能力型 import**(`node:fs` / `typescript` / `node:path` / `child_process` …)——
  薄运行器**永远不需要**读文件或遍历 AST,出现即证明结论是在无保护文件里算出来的;
  ② **正则字面量**(正则就是判定口径本身,改一个字符即可放行);
  ③ **≥2 的数字字面量**(阈值 / 地板锚点是判据的强度旋钮;0 / 1 是结构性取值,不算);
  ④ **控制流**(`if` / `for` / `try` / `throw` / 三元 —— 有分支就有「哪条路算红」的判定);
  ⑤ **非测试回调的块体函数**(`describe` / `it` / `before*` / `after*` 的回调除外)。

  ⚠️ 规则 ③ 是**刻意从严**的:`expect(x).toHaveLength(4)` 这类写死计数会被判违规。
  逃生门是「把它变成裁判里的具名常量」,**不是**关掉闸 —— 这与仓内「地板锚点优于恰 N 条」
  的既有口径同向。八条搬完后 9/9 全绿,实测无误伤。

### Added

- ⭐ **防复发闸 `scripts/check-criteria-spec-purity.ts`** —— **本刀的主交付物**。
  只搬八条而不加闸 = 修实例不修类,下一条判据又会掉回去。

  - 发现面**结构性**扫 `src/` 下所有 `*.criteria.spec.ts`,**不写死任何文件名**;
  - 🔴 判据本体放在 `scripts/check-*.ts`(selfGuard 内)—— 放 spec 里就是**递归的坑**:
    把它改成恒绿,八条判据立刻又回到无保护状态;
  - 它的薄运行器 `src/criteria-spec-purity.criteria.spec.ts` **自己也在管辖内**
    (「守护判据纯度的那份判据」若自己夹带逻辑,就没资格要求别人纯);
  - **自证**:扫描面地板 `MIN_CRITERIA_SPECS`(防「目录挪走 / 后缀改名 ⇒ 零命中 ⇒ 自动全绿」)
    + 两条内联对照每次运行都跑。

  **变异对拍(三条,基线 0 红 / exit 0)**:
  | 变异 | 读数 |
  |---|---|
  | 把 `merged-failure-diagnostics` 的实质逻辑搬回 spec | **exit 1**,点名该文件 9 处、命中全部五条规则,其余 8 条**不受牵连**仍绿 |
  | 新建一个夹带判定逻辑的 `.criteria.spec.ts` | **exit 1**,五条规则各命中(1/2/1/1/1) |
  | 纯薄运行器形态(**假阳性对照**) | **绿** —— 闸若在正确形态上报红,只会逼人把它关掉 |

### Fixed

- ⭐ **`scripts/frozen-drafts-ledger.ts` 改名收编为 `scripts/check-frozen-drafts-ledger.ts`。**

  它放在 `scripts/` 下,但实测 `harness:needs` **同样是 0 需授权** —— 因为
  **selfGuard 的 glob 钉在「文件名」上**(`check-*` / `generate-*` / `replay-*` / `*.selftest.*`),
  不是「在不在 `scripts/` 目录里」。⇒ 「把判据搬进 `scripts/`」这句话**本身不够**,
  必须是「搬成 `check-*.ts`」。这条已写进新闸的报错文案,防止下一个人照着
  「放 scripts/ 就受保护」的直觉搬完仍是零保护、且**没有任何症状**。

  ⚠️ 连带两处:
  ① 该脚本生成的读数块注释里**嵌着生成它的脚本路径**,而判据逐字节比对 ⇒ 改名必须同 PR
  重生成读数块(实测 diff **恰好 1 行、只有路径**,12 条读数值一个没变 —— 计算侧零改动);
  ② 它的入口判别式原为 `process.argv[1].endsWith('frozen-drafts-ledger.ts')`,改名后
  **仍然匹配**(新名的后缀恰好包含旧名)。那是巧合不是设计 —— 换个名字入口会当场失效,
  而脚本会**静默什么都不做并退 0**,在 CI 里表现为「判据跑了、全绿」实为根本没执行。
  已换成 `require.main === module`。

### 落点与保护(实测前后对照)

搬家前承载判定逻辑却零保护的五个文件(四份 `*.criteria.ts` 兄弟 + 一份错名 script,共 1724+ 行),
以及八条 spec —— `harness:needs` 全为 **0 需授权**。搬家后 9 个裁判**逐个都是「1 个需要授权」**。

| 判据 | 裁判(selfGuard 内) |
|---|---|
| 判据纯度(新) | `scripts/check-criteria-spec-purity.ts` |
| 活动 v1.1 单一切换闸 | `scripts/check-activity-workflow-gate.ts` |
| 报名准入锁后重验 | `scripts/check-participation-admission-gate.ts` |
| 合并失败原因 | `scripts/check-merged-failure-diagnostics.ts` |
| 权限元数据决策锁 | `scripts/check-permission-catalog-metadata.ts` |
| seed 单向权威 | `scripts/check-seed-description-authority.ts` |
| 复合锚点闭合 | `scripts/check-composite-anchor-closure.ts` |
| 冻结稿台账 | `scripts/check-frozen-drafts-ledger.ts` |
| 可写 DTO 图片引用 | `scripts/check-activity-image-reference.ts` |

**只搬家,不改任何判据的判定口径。** 九条 spec 逐条跑过、`it()` 条数逐个对拍,
结论全部不变(9 suites / 80 tests 全绿)。搬运中未发现任何判据自身的缺陷。

⚠️ **本刀确实占串行道**(与立项时的预判相反):八条里有四条的实质逻辑早在同目录的
`*.criteria.ts` 兄弟文件里,它们**不是** `.spec.ts` ⇒ 在 `computeControllerInputDigest()` 的
734 个 sourceFiles 内,搬出 `src/` 必然改 ROUTE_AUTHZ 的 inputDigest。绕不开
(digest 连内容一起哈希,原地改或留 re-export shim 一样动它),已随本 PR 重生成。

### 已知边界(不吹判据能力)

新闸保证的是「**判据的结论来自受保护的裁判**」,不保证「spec 里每一个自证夹具都受保护」——
它不禁止字符串字面量,所以 `runCriteria(overrides)` 这类**变异夹具**仍可能留在 spec 侧被改动。
本刀已把八条里能搬的夹具一并搬走,但这是**执行结果不是机器保证**;
真正的机器保证是:主断言的输入恒来自 `scripts/check-*.ts`。
