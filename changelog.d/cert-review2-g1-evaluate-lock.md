- **评定接入报名锁 + 门槛复算 + CAS(2026-07-31;证书标准库第二轮跨模型评审 findings G1)**:`RecruitmentApplicationReviewService.evaluate` 此前**无锁、无锁后复读、无 CAS** —— 事务外读到 `pending_evaluation` 就无条件 `update({ where: { id } })`。**Endpoint 恒 438 · 权限码恒 222 · Migration 恒 67 · BizCode 恒 306 · AuditLogEvent 恒 129**,零 schema、零契约变化。

  **修复前能发生什么。** 评定与「整份撤销」/「证书门槛回退」并发时,等锁期间提交的 `withdrawn` 或 `verified` 会被评定按锁前快照覆写回 `publicity`;而发号内核只复核「当前是不是 publicity」、**不要求存在 APPROVED Claim** —— 于是一份用户已经撤销、或门槛已经失效的报名照样能被建 Member/User 并发出永久编号。

  改成 `recruitment-application-lock.ts` 的固定范式:**锁(`FOR NO KEY UPDATE`)→ 锁后复读 → 门槛重算 → 判定 → 带 `expectedStatus` 的 CAS `updateMany`(`count !== 1` 即 28041)**。

  **门槛复算这一步不可省。** 锁保证的是「没人同时改」,不是「我的判断依据还成立」:`thresholdMarks` 对 `redCross` / `bsafe` 只是 Claim 审核结论的**投影**,任何漏调重算的 Claim 写路径都会让它静默落后于事实。所以 `approved=true` 且当前 `pending_evaluation` 时,先调这两个门槛的唯一写者 `recomputeCertificateThresholds` 按当前全部未软删 Claim **重新聚合**,再用重算后的行判定 —— 不另写一套聚合(第二套聚合就是第二个可漂移的真相)。重算与评定同事务:门槛不成立 → 抛 28041 → 重算刚写的修正一起回滚(本方法的职责是「不基于失效依据放行」,不是顺手修数据)。

  行为差异只有一个方向:**原先会放行的失效场景现在返 28041**。`verified + approved=true` 恒拒(门槛未齐)、淘汰路径、正常通过进公示三条逐字不变。

  行为锁:新增 `test/e2e/recruitment-application-write-concurrency.e2e-spec.ts`(11 条,含「两个 app 确实是两条独立连接」元断言 + 全库巡检「`publicity` 报名不得存在证书门槛不完整的状态」,巡检按 **Claim 聚合**判而不是查投影自身)。其中 6 条在修复前红。
