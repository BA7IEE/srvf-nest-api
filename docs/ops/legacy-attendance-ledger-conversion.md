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
committed 账本口径下**逐人相等**(贡献值不比较 —— 恒 approved 封顶口径,维护者 2026-08-19 拍板);
超日封顶(>3/日)的成员,超出部分在账本里记为 cappedOut,可在分录读面查到。

全部通过 ⇒ 按 §16.3 继续开闸;任一不一致 ⇒ 停,带读数找实现方。
