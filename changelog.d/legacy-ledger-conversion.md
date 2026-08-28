---
"feat(activities)": 存量考勤账本化转换刀(P1-28 第 7 批② A 案,2026-08-27 拍板):只读维护窗内一次性把存量 approved 考勤合成为 v1.1 事实链并提交真 LedgerPostingBatch

- 新增 `LegacyLedgerConversionService`(零端点/零 DTO/零权限码;唯一调用方为 CLI 与 e2e):
  合成 EvidenceSeal / SettlementRun(posting) / SettlementVersion(approved) / D2 历史报名头
  (sourceCode='admin',§3.6 闭集内)/ D1 场次映射(checkInAt 落窗,零窗兜底最早场并逐条点名)
  → resultRevision(recognized=calculated=旧值)→ 日行与分录(与第五/七刀同形状,
  credited 走 allocateDailyCredit 日封顶)→ 批次 ready → commitConvertedBatchWithin
- `LedgerPostingService`:协议体抽为私有 `commitBatchProtocol`(逐字;既有 e2e 为
  行为零变化正对照),新增 `commitConvertedBatchWithin`(判闸位换转换窗口断言;
  跳过 settlement-posted 通知 —— 回填不是新结算)
- 闸新增 `assertLegacyLedgerConversionAllowed()`(20159):唯一放行态 = 只读维护窗
  (§16.3 停旧写之后、开闸之前);运行时两写方在该窗口仍被拒,混合态结构上仍不可能
- CLI `scripts/legacy-ledger-conversion.ts`(幂等:requestKey 单列 unique,重跑即
  already-converted)+ SOP `docs/ops/legacy-attendance-ledger-conversion.md`(维护者执行)
- e2e `legacy-ledger-conversion.e2e-spec.ts`:三态闸 / 转换本体(含 6.50→3.00+3.50 封顶
  分账)/ 幂等重跑零新增

BREAKING: 无(闸关期生产零变化;转换仅在只读维护窗由维护者显式执行)
