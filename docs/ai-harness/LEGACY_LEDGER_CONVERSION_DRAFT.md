# 存量考勤账本化 —— 转换刀评审稿(草案,未冻结)

> **性质**:第 7 批②「账本桥」A 案的**设计稿**。2026-08-27 维护者拍板「按推荐」(= A 案)后起草;
> 维护者评审通过后另立冻结件入 `docs/archive/reviews/`,本稿随之停更。
> 拍板链:2026-08-19 三次拍板(见 `NEXT_TASKS` P1-28)→ **2026-08-27 四次拍板:A 案**。
>
> ⚠️ 本稿在维护者签收前**不构成施工授权**;D1–D13 是「带推荐的待评审项」,不是已定案。

---

## 0. 一句话终态

闸关期间 runtime **零改动**;§16.3 停写窗口内跑一次受控转换,把**存量已审批考勤**合成为
v1.1 事实链(报名头 / 参与身份 / 结果修订 / 结算版本)并提交**真** `LedgerPostingBatch`;
②-b 四数字读面换源随闸翻面。开闸后:新链唯一真相,存量与新增在同一账本口径里。

## 1. 为什么是 A 案(锚点证据,2026-08-27 实查 `prisma/schema.prisma`)

| 账本侧锚点(必填) | 旧链 `AttendanceRecord` 现状 |
|---|---|
| `LedgerPostingBatch.settlementVersionId` → `AttendanceSettlementVersion`(Restrict) | 无 |
| `ParticipationLedgerEntry` 锚 `(activityId, sessionId, memberId)` 复合 FK | **无 `sessionId` 列** |
| 同上 `identity` → `ActivityParticipationIdentity`(锚 activity+session+**registration**+member) | 无 identity;`registrationId` **可空** |
| 同上 `resultRevision` → `ParticipantSettlementResultRevision` | 无 |

⇒ **B 案(过渡期双写)结构性不可行**:往现有账本表插旧链分录,必须先有整套 v1.1 上游事实;
松复合外键 = 推翻第六轮锚点闭合成果,不做。**C 案(读面并集)** 不达合同终态
「统计只读 committed batch」(详细开发文档 v1.1 §对照表),只把债推后。
2026-08-19 实测两链人群零相交(镜像读数,见 NEXT_TASKS P1-28 探针表)⇒ A 案转换是唯一
既守住锚点闭合、又让存量进账本口径的形状。

**初步结论:零 schema 让步可行**(所有必填锚都能通过合成事实满足);D2/D3 在实施首日复核,
若推翻则停下走 §4.1(届时才涉及 migration token)。

## 2. 转换范围与不变式

- 只转换 `statusCode='approved'` 且未软删的 `AttendanceSheet` 及其 records;
  pending / rejected / final_rejected / 软删一律不转(明细清单导出留档)。
- `recognized* = calculated* = 旧链 approved 值`(不做重算;认定=计算,免 `adjustmentReason` 必填触发)。
- 转换**只增不改**:不碰 `AttendanceRecord` / `AttendanceSheet` 任何既有列;
  approved 语义与 K3 里程碑 / 通知 / 入队门槛(C4 反向闸)零漂移。
- 转换批次 = **普通 committed 批次** ⇒ 天然纳入更正(`CorrectionApplication.newBatch`)与
  关账(closure 读 committed)口径,不造第二套语义。

## 3. 设计决策(带推荐,待维护者评审)

| # | 议题 | 推荐 | 备注 |
|---|---|---|---|
| D1 | **session 映射**(record 无 sessionId) | 按 `checkInAt` 落入 live session 时间窗;恰落一窗→该窗;零窗→活动最早 live session 兜底并记 flag;多窗→含 checkInAt 的最早窗 | 兜底分支必须在报告里逐条点名,不静默 |
| D2 | **`registrationId` 为 NULL 的存量** | 为该 (member, activity) 合成一条 legacy 来源永久报名头(第 81 migration 全局唯一;同 member+activity 已有头则复用) | 实施首日核对头唯一约束与 statusCode 取值 |
| D3 | **`evidenceSealId` 必填**(version 锚) | 合成一条「legacy-conversion」EvidenceSeal(证据集为空) | 实施首日核对 EvidenceSeal 模型可空性;若不可行→停,上报 |
| D4 | **与既有 run 并存**(`AttendanceSettlementRun` 一活动一行) | 只向既有 run **追加** version;无 run 则创建(run/version statusCode 取「已过终审」的合法值,闭集以 schema CHECK 为准) | 实施首日核对两闭集 |
| D5 | **幂等 / 可重跑** | `entryKey` 幂等键 + `(settlementVersionId, batchRevision)` unique + operationKey 三重防重;重跑先查后写 | 转换刀必须可安全重跑(探针 P0 判据) |
| D6 | **规模** | 复用 `runMemberLinearizedTransaction` 与 slot 机制;30/500/2000 档判据已有,万人档豁免沿用 | 不新增耗时阈值类断言 |
| D7 | **回滚** | 转换前对涉及表 `pg_dump` 快照 + 逆操作 SOP;运行期撤销用批次 void 原语 | 物理写数据 ⇒ 维护者执行,SOP 写明 |
| D8 | **audit** | 复用既有伞事件 + `extra.operation='legacy-ledger-conversion'`,**零新 AuditLogEvent** | 与 T6-1 replay 同范式 |
| D9 | **执行时机** | §16.3 顺序「停旧写之后、开闸之前」;转换后跑探针:四数字 approved 口径 == committed 口径(逐人)才允许开闸 | 探针不过 ⇒ 不开闸,SOP 写死 |
| D10 | **②-b 换源** | C8 闭包(现读 3 文件 / 4 函数)四数字由闸控制:闸关 = approved 逐字恒等现状,闸开 = committed | `②-a 不变量 2` spec 按自述协议改写(闸关恒等 + 闸开 committed),断言变更在 PR 内逐条揭示 |
| D11 | **D1 悬案收口** | 「参与活动数 / 记录条数」的账本口径对着转换后真实数据定案,写回 NEXT_TASKS | 不在无数据时凭空发明 |
| D12 | **team-join** | 零触碰(C4 反向闸:入队门槛恒 approved) | 禁止域 |
| D13 | **第 6 批收口宣告** | 逐 SHA 核对 B6-1 / B6-2 / 收口刀合并与 CI 状态后在 NEXT_TASKS 宣告(或如实列缺口) | 与本刀同一 goal 的 DoD,不混入同一代码 PR |

## 4. DoD(转换刀 + 换源,合并核验)

1. 重跑 2026-08-19 双链探针:转换后两侧**同人群**(镜像归零消除);
2. 转换后探针:四数字 approved 口径 == committed 口径(逐人逐数);
3. `cutover:check` 6a(C1–C8)仍 ✅,C8 读数按换源后形状由其现算更新;
4. `②-a 不变量 2` 协议化改写落地,闸关下四数字逐字恒等;
5. K3 里程碑 / 通知 / audit 零漂移(characterization 对拍);
6. 转换刀幂等:同一输入重跑零新增行;
7. D11 定案落台账;D13 第 6 批宣告落台账;
8. 全量结论以 PR CI 冷跑为准(本机只跑定向 spec)。

## 5. 基线读数(2026-08-27,`9c8be487`)

- P0 双链探针:`activity-full-chain` + `attendance-final-approve-*` 3 套件 **11 用例全过**(本机 Docker PG);
- 人群镜像读数沿用 2026-08-19 实测(见 NEXT_TASKS P1-28 探针表),转换后须复测消除。

## 6. 禁止域 / 写集(沿 goal 声明)

- 禁止域:`src/modules/team-join/**` · `prisma/schema.prisma`·migrations·seed(如需→停,另走 D 档拍板 + migration token)· `scripts/check-activity-workflow-gate.ts`(selfGuard)· `auth/**` · 闸值与 CUTOVER_SIGNOFF · 不顺手修 P2-19 / P2-20。
- 写集:`src/modules/attendances/**`(转换服务 + characterization)· `src/modules/activities/**`(ledger / 结算读面、四数字换源)· C8 闭包点名的读面文件 · 相关 `test/e2e/activity-*` 族 · `docs/ai-harness/NEXT_TASKS.md` / `docs/current-state.md` / `changelog.d/`。
