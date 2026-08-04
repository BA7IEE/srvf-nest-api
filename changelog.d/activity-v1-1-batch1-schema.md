### Added

- **活动业务改造 v1.1 第 1 批第一刀:场次 / 参与身份 / 容量 schema expand**(第 **71** migration
  `20260804020000_activity_v11_slice1_sessions_participation_capacity`;合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §3.1 / §3.2 / §3.3 / §3.8 / §3.9 / §3.10,批次划分见 §14「第 1 批」建议拆分第 1 项)。

  净新 **6 张空表**:`ActivitySession`(场次,时间窗与定位策略在此冻结最终值)、
  `ActivitySessionPosition`(场次级岗位)、`ActivityParticipationIdentity`(P0-04 核心:
  一队员×一场次的**永久**身份)、`ActivityParticipationRevision`(不可变状态修订)、
  `ActivityCapacityBucket` + `CapacityReservation`(容量桶与占位事实)。
  既有表只动 `Activity`,**只加 12 列**(全部可空或带 default)+ 1 条 RESTRICT FK
  (`terminatedByUserId`→`User`);其余仅 Prisma 反向 relation,零标量字段。

  **expand-only:零 DROP / 零 RENAME / 零既有列语义变更 / 零回填 / 零删数 / 零 enum。**
  合同 §3.1 另要求删 `attendanceDeclaredCompleteAt` 两列并把 `completed` 移出活动状态闭集 ——
  那属 expand→migrate→contract 的 **contract 阶段**,`completed` 全仓 376 处引用,
  在建表 PR 里动它会打穿半个仓库,故本刀不做,`statusCode` 取值闭集一并不动。
  既有 `ActivityPosition` / `ActivityRegistration` 一列不动、一行不迁,**不写任何双写双读**
  (合同 §0.4);两表退场同归 contract 阶段。

  **零 runtime**:六张新表**零调用方 / 零端点 / 零 DTO / 零权限码 / 零 audit / 零 seed**
  —— 纯 schema 刀,契约 snapshot 一字未动。生产未 deploy。

  末尾 **34 条手写约束**(Prisma DSL 表达不了 CHECK 与 partial unique 的 WHERE):
  29 条 CHECK + 5 条 partial unique(场次 live `(activityId,code)`/`(activityId,name)`、
  岗位 live `(sessionId,code)`/`(sessionId,name)`、占位 `(identityId,bucketId) WHERE status='active'`)。
  逐条在真实 PostgreSQL 上跑过**双向**阳性对照(违规被拒 + 合法放行),
  判据钉在 `test/e2e/activity-v11-slice1-schema-constraints.e2e-spec.ts`(42 例)。

  两处值得记的落点:

  - **`ActivityParticipationIdentity` 的 `(activityId, sessionId, memberId)` 是普通 unique,
    不带删除条件**(合同 §3.8)。取消重报只追加 Revision 并改当前指针,**永不再建身份行** ——
    spec 里把身份置为 `cancelled` 后再插第二行,**仍然**必须被 23505 拒;
    换成带删除条件的 partial unique 该用例立刻红。
  - **`capacityReservationId` 指针**不加 FK(与 `CapacityReservation.identityId` 互指会成
    循环外键,并凭空多一条隐式死锁边 —— 本仓已有「audit 外键是看不见的死锁边」前科)。
    代价是悬空指针 DB 不挡,已用 LEFT JOIN 对账查询把「怎么发现失同步」显式钉成判据,
    并反向断言指针正确时该查询查不出行(否则是恒真的假对账)。
