---
"feat(activities)": D11 定案落地 —— 开闸后「记录条数」账本口径 = 账本日行数(维护者 2026-08-28 拍板「按推荐」)

- `LedgerQueryService.countCommittedParticipationForMember`:recordCount 由分录条数
  (COUNT(*),每人每日两条)改为 **COUNT(DISTINCT (resultRevisionId, ledgerDate))**
  —— 与旧「考勤记录条数」最贴近的粒度,开闸前后数字基本连续;活动数口径不变
- 等价锚新增在 `legacy-ledger-conversion.e2e-spec.ts`:转换桥后 committed 计数
  == approved 计数(逐人:1 活动 / 2 日行 == 1 活动 / 2 条考勤记录)
- 台账:P1-28 转换刀交付宣告(#1211)+ 第 6 批代码面收口宣告(D13)+ D1 悬案定案;
  current-state §3 桥已实施更新

BREAKING: 无(闸关期读面零变化;本变更只影响闸开后的 committed 取数语义)
