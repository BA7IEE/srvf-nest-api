### Changed

- 队员模块抽出 `members.presenter.ts` 与 `members.policy.ts`(Phase 6-B 第三刀,架构边界 §3.1/§3.3):对外 DTO 的账号字段拼装(`attachAccountInfo`)与两个域判定(`normalizeMemberNo`、`assertGradeCodeValid`)改为纯自由函数,入参即全部依赖,不持有 Prisma、不开事务、不判权。判权、P2002 错误映射与 memberNo 唯一性预检查仍留在 service。对外行为逐字不变。
