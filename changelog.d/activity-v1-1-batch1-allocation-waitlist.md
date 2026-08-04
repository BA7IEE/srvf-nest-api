### Added

- **活动业务改造 v1.1 第 1 批第五刀:分配 / 志愿 / 候补 / 预留名额 schema expand**
  (第 **75** migration
  `20260804100000_activity_v11_slice5_allocation_waitlist_reserved_quota`;合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §3.11)。

  ⚠️ **本刀的存在本身是在补合同的洞。** §3.11 这四张表**没有被 §14「第 1 批」建议拆分的
  任何一条列入**(那四条是 Activity/Session/Participation/Capacity、
  Form/Qualification/Invitation、Punch/Evidence、Settlement/Ledger/Correction/Closure/Job),
  而 §14「第 4 批」的交付清单里明写要用 Allocation 与 Waitlist —— 这是合同的**第四处内部
  矛盾**。维护者 2026-08-04 拍板**单独第五刀补齐**,不并进第四刀(账本链语义像钱,
  不与不相干的分配表混刀)。

  净新 **4 张空表**(全部 §3.11):`ActivityPositionPreference`(岗位志愿)、
  `ActivityAllocationBatch`(分配批次)、`ActivityAllocationCandidate`(候选人评分与结果)、
  `ActivityReservedQuotaGroup`(预留名额组)。

  既有表加 **1 列(可空)**,是**兑现第一刀欠下的最后一个跨切片外键列**:
  `ActivityParticipationRevision.allocationBatchId` → `ActivityAllocationBatch`,
  连列带 FK,并补上 §11.3「必需索引」逐字点名的 `(allocationBatchId, statusCode)`。
  至此「不占位」范式在本批次内走完全程。

  **expand-only:零 DROP / 零 RENAME / 零 ALTER COLUMN / 零既有列语义变更 / 零回填 /
  零删数 / 零 enum。** 四张新表**零调用方 / 零端点 / 零 DTO / 零权限码 / 零 audit / 零 seed**
  —— 纯 schema 刀,契约 snapshot 一字未动;消费方在第 4 批。**零新增 cron**(全仓终态仍恰 2)、
  零 Redis / queue、零新 worker 进程。**特别地,抽签只落了 `randomCommitment` 一个列,
  不实现任何随机数逻辑。** 生产未 deploy。

  末尾 **4 条手写 CHECK**(零 partial unique、**零 trigger**)。判据钉在
  `test/e2e/activity-v11-slice5-schema-constraints.e2e-spec.ts`(**41 例**)。
  既有 spec **零改动** —— 开工探针 `grep -rn "allocationBatchId" test/e2e/` 命中为空,
  第三刀那条到期判据在第四刀就已收窄完毕,本刀不需要再动它。

  五处值得记的落点:

  - 🔴 **一条 CHECK 的初版是"有条件地对",在合入前被变异实测抓出并改掉。**
    `activity_allocation_batch_committed_shape_check` 初版写成朴素 OR
    `"statusCode" <> 'committed' OR "committedAt" IS NOT NULL`,注释里断言"两侧恒二值,
    不可能塌成 NULL"。**那句话依赖的是 `statusCode` 的 NOT NULL —— 而那是别处的列声明,
    不是本式的结构性质。** scratch 库实测:`DROP NOT NULL` 之后插
    `statusCode=NULL, committedAt=NULL`,`NULL <> 'committed'` 求值成 NULL、
    `NULL OR FALSE` = NULL ⇒ **CHECK 判通过,该行真的入库**。改成**守卫前置**
    `"statusCode" IS NOT NULL AND (… OR …)` 后同一行被 23514 拒(AND 是 FALSE-主导,
    塌成 FALSE 而不是 NULL)⇒ 结构免疫。这是第四刀那条教训(「守卫必须前置,不能靠别处的
    NOT NULL 声明兜底」)的**同型复发**。
  - ⚠️ **一条诚实的负面结论,与上一条正好构成对照。**
    `capacity IS NULL OR capacity >= 1` 的 `IS NULL` 守卫是**自证文档而非行为**:
    变异实测换成朴素 `capacity >= 1` 后,capacity=NULL 照样入库(NULL 是**合法**的"不限")、
    capacity=0 照样被拒,两种写法在全部输入上判定完全相同。保留显式写法只为可读性 +
    与既有两条姊妹约束逐字同形,**不是**因为它挡住了什么。
    **两条的区别就是守卫本身是不是 `IS [NOT] NULL` 谓词** —— 是,则结构免疫;
    不是(比如 `<>` 比较),则会随判别列的可空性静默失效。
  - 🔴 **`ActivityAllocationCandidate` 刻意不装 append-only trigger**,理由不止先例:
    ①**先例**:合同说的是「结果 **committed 后**不可改」,**没有**像 §3.23.8 那样点名
    "DB 角色层禁 UPDATE/DELETE";§3.17 `EvidenceSeal`(第三刀)与 §3.19
    `SettlementReviewAction`(第四刀)都按「合同没点名 ⇒ 不装」处置,**本刀沿的就是这两条**。
    ②**更硬的正面理由**:这里是**条件不可变**,不是 append-only —— 批次 preparing 期正要往
    候选行里写评分 / 抽签序号 / 结果 / 候补序号,一条无条件 append-only trigger 会把合法
    写路径直接堵死,**装上就是错的**。③那么"按父批次 statusCode 判"的条件 trigger 呢?
    那是**跨行**判据,行级 trigger 里读父批次在并发下会骗人(两事务互相看不见对方未提交的
    status 变更),与第四刀「日合计求和 trigger 在并发下骗人」同型。执行位归第 4 批 service
    (Activity 锁内重读批次状态)。用两条会变红的 e2e 钉住"刻意":preparing 期 UPDATE
    **必须放行**;本表 `pg_trigger` **必须为空集**。
  - 🔴 **`ruleSnapshotId` 不建 —— 本刀新欠下的唯一一笔账。** 合同 §3.11 字段表给了这一列,
    但它指向 §3.4 的 `ActivityRuleSnapshot`,而那张表**至今没有建**(§14 第 3 批
    「Template snapshot」才实现)。沿「跨切片外键列不提前占位」:提前建一列指向不存在的表,
    既加不了外键也无人写入。由**建 `ActivityRuleSnapshot` 的那一刀连列带 FK 补齐**;
    已用「该列必须不存在 + 目标表此刻确实不存在」两条 e2e 钉住前提。
  - 🔴 **DoD 5(可空列进唯一索引)的答复是"本刀无处可加也不该加"。**
    本表**唯一的**唯一索引键是 `operationKey` 单列(NOT NULL);可空的 `positionId`
    **没有进任何唯一索引** —— §3.11 与 §11.3 都没有为本表要求岗位维度的唯一,按"合同没给的
    不发明"处理。已用结构断言钉住;哪天有人补了含 `positionId` 的唯一索引这条会红,
    **那时必须同时决定要不要 `NULLS NOT DISTINCT`**(否则岗位级为 NULL 的行可无限重复,
    索引恰好在最该生效的那类行上完全失效 —— 第二刀邀请那条的原型)。
  - 🔴 **幂等键唯一取 `operationKey` 单列不取复合**:复合唯一恰好**放行**「同一个 key 配
    不同 payload」,而那正是幂等键最该拦的冲突(第二刀实测)。单列唯一严格蕴含复合唯一,
    故同时满足合同字面;已用"同 key 不同 payload 仍须被拒"的用例钉住。

  与合同的偏离(逐条在 PR body 展开):`ActivityAllocationBatch.committedAt` **改可空**
  (合同字段表未标 `?`,但 §3.11 自己的 `statusCode` 闭集里就有 `preparing`,NOT NULL 会让
  该状态根本写不进来 —— 并配了 shape CHECK 把"committed 却没有提交时刻"重新关上,
  放宽不是净损失);`requestHash` 可空、`createdBy` 落为 `createdByUserId` 且可空
  (沿全仓既有范式,9 处无一例外)。**`candidateSnapshotHash` 保持 NOT NULL** ——
  同一条 bullet 里作者对 `positionId` 与 `randomCommitment` 显式标了 `?`,说明"未标 = 必填"
  是刻意的,且找不到任何合同条款定义"该哈希此刻不存在"的合法形态。

  合同**未给**的一律不发明,并全部用「任意取值必须放行 + 该列零 CHECK」钉成会变红的判据:
  `ActivityAllocationCandidate.resultCode` 不落闭集(§3.11 说了"最终结果"却没给取值集)、
  该表**零 unique**(§3.11 与 §11.3 一条唯一都没给);
  `ActivityReservedQuotaGroup.scopeTypeCode` / `fallbackMode` 不落闭集
  (⚠️ 照搬 §3.10 容量桶的 scope 闭集看着"很自然",但那是**另一张表**的闭集,
  写进来等于替维护者定口径);`ActivityPositionPreference.preferenceOrder` 不落范围
  (§3.11 没给 0-based 还是 1-based,姊妹列 `ActivityParticipationRevision.waitlistRank`
  在第一刀同样没有范围 CHECK)。上述四处已作为**合同缺口**登记,待补定义后由行为批次补。

  §3.11 对 `ActivityAllocationCandidate` 与 `ActivityReservedQuotaGroup` **只给散文不给
  字段表**,故只落散文**明确点到**的项,逐列命名与类型依据在 PR body 给对照表;
  "散文提到但刻意未建"的清单同样在 PR body 列出。
