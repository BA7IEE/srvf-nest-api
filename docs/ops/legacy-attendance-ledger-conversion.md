---
# 存量考勤账本化 —— 维护者 SOP(P1-28 第 7 批② A 案)

> **什么时候用**:合同 §16.3 切换顺序里「**停旧写之后、开闸之前**」的只读维护窗。
> 施工依据与拍板链见 [`docs/ai-harness/LEGACY_LEDGER_CONVERSION_DRAFT.md`](../ai-harness/LEGACY_LEDGER_CONVERSION_DRAFT.md)。
> 判据 e2e:`test/e2e/legacy-ledger-conversion.e2e-spec.ts`(三态闸 / 转换本体 / 幂等)。

## 0. 前置(缺一即停)

1. 全实例 `ACTIVITY_WORKFLOW_READONLY=true` 且 `ACTIVITY_V11_WORKFLOW_ENABLED` 未开
   (只读维护窗;两个都设的实例上 CLI 会被 20159 拒绝 —— 这是判据,不是障碍);
2. 已按 §16.3 完成停旧写(旧考勤终审入口已被只读位拒绝);
3. **目标库已做快照**(涉及表:ActivityRegistration / ActivityParticipationIdentity /
   AttendanceSettlementRun / AttendanceSettlementVersion / ParticipantSettlementResultRevision /
   ParticipantSettlementDay / EvidenceSeal / LedgerPostingBatch / ParticipationLedgerEntry /
   MemberContributionDayState / ActivityBatchJob)。回滚 = 按快照恢复,不做逆向 DML。

## 1. 预检(只读)

```bash
# 候选量 = 有 approved 考勤的活动数(与 CLI 的扫描口径一致)
psql "$DATABASE_URL" -c "SELECT count(DISTINCT \"activityId\") FROM \"AttendanceSheet\" WHERE \"deletedAt\" IS NULL AND \"statusCode\"='approved';"
```

## 2. 执行(维护者本人;AI 对生产库恒无执行权)

```bash
# 单活动试跑(建议先挑一个小活动)
pnpm exec tsx scripts/legacy-ledger-conversion.ts --actor-user-id <你的用户id> --activity-id <活动id>

# 全量
pnpm exec tsx scripts/legacy-ledger-conversion.ts --actor-user-id <你的用户id>
```

- 逐活动一行结论;`[D1 零窗兜底]` / `[D2 合成报名头]` 逐条点名,**留档到本次切换记录**;
- 任一活动失败即整停(fail-closed),修复后可安全重跑(幂等,见下);
- **可重跑**:`requestKey=legacy-conversion:<activityId>` 单列 unique,已转过的活动返回
  `already-converted`,不写第二遍。

## 3. 后检(开闸前的最后一道)

对抽样成员核对「三数一致」:总服务时长 / 参与活动数 / 记录条数在 approved 考勤口径与
committed 账本口径下**逐人相等**（以上为原三数对账；贡献值按下述R5新增前置全量逐人核对）；
超日封顶(>3/日)的成员,超出部分在账本里记为 cappedOut,可在分录读面查到。

任一不一致即停止，带脱敏读数复核；通过本SOP仅完成数据前置，还须完整切换检查、目标制品/实例及演练与维护者现场批准，不自动开闸。

## 4. R5新增硬前置：旧分先账本化，逐人核对贡献

本轮获批口径取代“贡献恒approved不比较”的旧决定：on只读committed credited，故在停旧写后的off+readonly窗口先按原CLI转换。不得先开闸后靠旧考勤回退补分，不得将两来源相加/按天取大值。转换实现和SQL不在本轮修改，生产执行仍NOT_RUN。

1. 对实际目标先盘点所有旧approved且未软删的记录、NULL贡献字段、同人同日跨活动记录、已有新链活动、相关入队cycle及已转换批次；未知不按0计结论。即使零存量也须有实际只读盘点回执，云测试库0不代替生产0。
2. 在维护窗保留每人旧核基线：按checkInAt的北京日聚合、逐日min(日和,3)，记录生涯总分与每个相关cycle北京4-1 exclusive之前的分。账本的ledgerDate是civil DATE，不能拿UTC截止瞬间直接比DATE，必须用同一北京日边界。
3. 转换后对**每个人**复核SUM(creditedPointsDelta)，仅postingBatch.statusCode=committed；分别比较生涯与相关cycle截止分，并确认差异人数为0。包括原账、冲回、重记，不按resultRevision当前状态丢旧行；账本已封顶，读时不再封顶。保留必要的私有对账证据，公开日志不输出个人数据或连接凭证。
4. `skipped-new-chain-history`、`nothing-to-convert`、缺漏/无法解释的NULL与任一分数不一致均不能自动算成功；逐活动点名，确认旧分可追溯到已生效分录。已有新链与旧记录的重复覆盖须先澄清，不能通过双算/回退/改历史SQL掩盖。原三项对账也继续按各自实际定义核查。
5. 在同一冻结人群/无新写条件下完成核对，再交发布评审核验fleet/实际SHA与开关一致、worker排空、稳定窗、10a/10b。发现来源变化则读数作废，停止并重新核实。本轮真实PG转换样本含同日跨活动封顶、生涯5分/cutoff3分及幂等，不能据此宣称生产已转换或一致。
