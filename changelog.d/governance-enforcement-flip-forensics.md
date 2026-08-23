### Fixed

- 状态机登记表的一处**假读数**:`ParticipantSettlementResultRevision.statusCode` 的 `governedBlockers` 原为空,于是它是全仓唯一一条被 `pnpm docs:boundaries` 报成 `upgradeCandidates`(「零 blocker,够得着 governed 门槛」)的条目。实测把它升 `governed` 跑 `pnpm docs:boundaries:check`,**判据自己当场拒绝**:

  ```
  state entry ParticipantSettlementResultRevision.statusCode: edge endpoint "committed"
  never appears as a string literal in src/modules/activities/ledger-preparation.service.ts
  (registry declares an edge the named module does not mention)
  ```

  根因是这台状态机**物理散在 4 个文件**(`settlement-draft` 建 `draft` / `ledger-posting` 裸 SQL 写 `committed` / `correction-application` 裸 SQL 写 `superseded` / `ledger-preparation` 只读校验),L2 声明闸要求的单一 `implementationFile` 结构上给不出。⚠️ 该事实**当时就写在 `STATE_MACHINE_INVENTORY.md` §10.6 的散文里**,只是没写进机器读的那个字段 —— 同一份文件里散文与机器字段对同一件事给出相反答案,又一例「**描述文本 ≠ 执行位**」。按实测补 `impl-scattered`(仓内既有取值)。⚠️ 另有三个文件恰好同时含 `draft`/`committed`/`superseded` 三个字面量,填进去闸会绿,但那些字面量属于**兄弟模型**(`ActivitySettlementClosureRevision` / `ParticipantServiceSegmentRevision` 同为三值闭集)—— 「挑一个能让闸变绿的文件」= 为凑绿放宽口径,**已否决**。A/B 读数:`upgradeCandidates` `["ParticipantSettlementResultRevision.statusCode"]` → `[]`,`blockerHistogram["impl-scattered"]` 1 → 2,`byStatus` 8/50 与 findings 634 均不变,`docs:boundaries:check` 前后 exit 0。⇒ **Phase 4 当前真实升格候选 = 0 条**;要恢复候选只能靠还债,不能靠调登记表。

- `NEXT_TASKS.md` P1-29 的状态行原为裸 `待办`,而**同一条的标题自述「执行中」** —— 自相矛盾,且标题写的「Phase 0 拍照·登记」早已收口(v4 11 阶段已落 7)。既有台账状态闸对它**结构性失明**:判据 C 只对「有交付类 commit 点名本条编号」的条目开火,而实测**点名 `P1-29` 的 commit 数 = 0**(v4 各阶段提交写的是 `feat(harness)` / `ci(governance)`,从不带编号)—— 正是那条闸自己登记的已知缺口①的实例。订正标题与状态行。

### Changed

- 架构治理 v4「把 report 模式的规则翻成执法」的**翻闸取证**落账(`NEXT_TASKS.md` P1-29 + `STATE_MACHINE_INVENTORY.md` §10.7)。**本次零闸翻成**,判据是「这条规则失败时 CI 那一步会不会让 PR 变红」,不是「文件里有没有 `report` 字样」。三条负结果比一条新闸值钱,逐条记下:

  1. ⭐ **「看起来像逃生门、实际什么都没关」**:全仓 workflow 恰两处 `|| true`(`ci.yml:253` / `:271`),而 `:253` 兜的脚本**根本不会失败** —— `runViolations()` 只写 stdout、从不设 `exitCode`,实测 634 条 finding 仍 `EXIT=0`。`docs/ai-harness/README.md` §2 末句「末两条……脚本本身有发现即退出 1」对 `:271` 成立、**对 `:253` 不成立**。读代码相信 ≠ 实跑退出码。
  2. **授权预算内零个 CI 侧闸可翻**:两处 `|| true` 都在 `.github/workflows/ci.yml`(红区 `ci-workflows`),且 `:253` 那处被 `scripts/harness-guards.selftest.ts:1121` 逐字钉住(`ci.includes('pnpm docs:boundaries || true')`)。本刀两条红区授权(`check-boundaries.ts` + `state-machines.json`)一条也不覆盖它们 —— **开关不在被授权的那两个文件里**,这是立项 goal 的前提缺口。
  3. **`harness-guards.selftest.ts:1817` 把 `governed` 条数硬编码成 8**(`governedEntries.length === 8`)⇒ **任何一条状态列升格都必然打红它**,与该条能否过闸无关。属「写死 N」缺陷类(`docs/ai-harness/README.md` §4 刚因同一形态从「恰 4 文件」true-up 过)。

  澄清一处此前的疑似矛盾:台账说「Phase 6-B 尺寸棘轮仍 report」与注册表说「5 条棘轮全部由 base-trusted 裁判执法」**不矛盾,两句都为真** —— 前者说的是 `ci.yml:271` 的扫描步骤被 `|| true` 兜住(判磁盘上的代码),后者说的是裁判守基线**文件**的单调性(判 `harness/*-baseline.json`)。**两个不同的执行位。**

  同时确认 **Phase 3 的 R2/R3/R5/R15「新增违规才阻断」已经有执行位**:`docs:boundaries:newdebt:check`(#1131,无 `|| true`)覆盖 `scan()` ∪ `scanCommon()` 的全部 finding,实测 `scanned 641 / unknown 0`。剩下仍是 report 的只有 R6(v4 §5.2 明写「**长期 report**」,不是欠账)与 R8(规则默认 `'off'`,只有 `SRVF_AUTHZ_R8_REPORT=1` 才 `'warn'`,而 `lint:authz:report` **未接任何 CI**;实测翻成 error 会红 **160** 条)。

- 三条翻不动的闸登记为 B 档(`NEXT_TASKS.md` P1-29):**B-1** 尺寸棘轮转 blocking(实测 14 条违规,且 `SERVICE_SIZE_RATCHET.md` §4 专属 EC 2026-08-21 复测严口径 35 > 判据线 30);**B-2** Phase 4 晋升棘轮接执行位 + 去掉 `:1817` 的硬编码 + 补常驻阳性对照(需 `harness-guards.selftest.ts` 授权 —— **没有常驻阳性对照的新闸是在给债务台账添条目,不是还债**);**B-3** ⭐ 边界扫描面漏掉 `src/modules/**` 与 `src/common/**` 之外的 **19 个非 spec `.ts`**(`moduleOf()` 只认 `^src/modules/`,R15 当年就是为堵这条逃生通道而建、却只堵了 `src/common/` 一个目录),实测真有 Prisma 触点的只有 2 个、摩擦极小,但扩扫描面 = 改判定口径 + 动 `architecture-debt-baseline.json`(红区 + `set-monotonic` 棘轮),故另立项。

  零 `src/**` 改动、零端点、零权限码、零 migration;`prisma/schema.prisma` 未动 ⇒ `state-machines.json` 的 `inputDigest` 不受影响。
