### Added

- **活动业务改造 v1.1 第 1 批第二刀:报名表 / 资格 / 邀请 schema expand**(第 **72** migration
  `20260804040000_activity_v11_slice2_form_qualification_invitation`;合同
  [`docs/archive/reviews/activity-business-overhaul-v1.1/`](docs/archive/reviews/activity-business-overhaul-v1.1/)
  §3.6 / §3.7 / §3.12 / §3.13 / §3.14,批次划分见 §14「第 1 批」建议拆分第 2 项)。

  净新 **10 张空表**:`ActivityRegistrationRevision`(§3.7 不可变报名修订)、
  `RegistrationFormVersion` / `RegistrationFormField` / `RegistrationFormAnswer` /
  `RegistrationUploadSession`(§3.12 报名表版本、题目、答案与上传会话)、
  `ActivityQualificationRuleSet` / `ActivityQualificationRule` /
  `QualificationEvaluationSnapshot`(§3.13 资格规则与评估快照)、
  `ActivityInvitation` / `ActivityVisitor`(§3.14 邀请与现场访客)。
  既有表只加 5 列:`ActivityRegistration` 四列(`currentRevision` NOT NULL DEFAULT 0 +
  `currentFormVersionId` / `statusSummaryCode` / `sourceCode` 可空)、
  `ActivitySessionPosition` 一列 `qualificationRuleSetId` —— 后者是**兑现第一刀的欠账**:
  第一刀按「跨切片外键列不提前占位」把它暂缓,而它指向的 §3.13 规则集表正是本刀建的,
  故本刀连列带 FK 一起补上。其余仅 Prisma 反向 relation,零标量字段。

  **expand-only:零 DROP / 零 RENAME / 零既有列语义变更 / 零回填 / 零删数 / 零 enum。**
  十张新表**零调用方 / 零端点 / 零 DTO / 零权限码 / 零 audit / 零 seed** —— 纯 schema 刀,
  契约 snapshot 一字未动;消费方在第 4 批。生产未 deploy。

  末尾 **24 条手写约束**:21 条 CHECK + 3 条 partial unique
  (一活动至多一个 active 报名表版本、`requestKey` 幂等唯一、邀请 active 去重)。
  逐条在真实 PostgreSQL 上跑过**双向**阳性对照,判据钉在
  `test/e2e/activity-v11-slice2-schema-constraints.e2e-spec.ts`(46 例)。

  三处值得记的落点:

  - **`RegistrationFormAnswer` 的 exactly-one 用计数式**
    (`CASE WHEN … IS NOT NULL THEN 1 ELSE 0 END` 求和 `= 1`)而不是 AND/OR 串。
    `IS NOT NULL` 是二值谓词 ⇒ 和恒为非 NULL 整数 ⇒ 整条 CHECK **结构上不可能求值成 NULL**,
    天然免疫「表达式为 NULL ⇒ CHECK 判通过」那个第一刀真踩过的坑。
    拒绝用例覆盖「零个非空」「两个非空」(三种组合)「五个全非空」,外加五种合法单值正对照。
  - **`activity_invitation_active_unique` 带 `NULLS NOT DISTINCT`**(PG15+;沿
    `role_bindings_active_unique` 先例)。键含**可空**的 `sessionId`(NULL = 活动级邀请),
    PostgreSQL 默认把 NULL 视为互不相等 ⇒ 不带该子句时同一人可被重复发出任意多张活动级邀请
    而一条都不被拦 —— **索引恰好在它最该生效的那一类行上完全失效**,而场次级邀请
    (`sessionId` 有值)照样被拦,漏写在只测场次级的用例里**完全看不出来**。
    已跑变异 A/B:去掉子句后两条重复行全部入库。
  - **`ActivityVisitor` 刻意零 Member 外键**(合同 §3.14:「与 Member、Participation、Ledger
    无 relation;禁止通过访客创建贡献分」)。`invitedByMemberId` 是裸留痕列。
    「没有外键」用两条判据钉成可执行的:填不存在的 memberId 仍能入库(行为判据)+
    直查 `information_schema` 断言外键目标集恰为 `{Activity, ActivitySession}`(结构判据)——
    哪天有人顺手补上 FK,两条都会立刻变红。

  与合同的偏离(均因合同自身要求而必需,PR body 逐条列):
  `QualificationEvaluationSnapshot` 的 `identityId` / `registrationRevisionId` 改可空 ——
  §3.13 明写「**展示**、提交和审核三次评估分别留快照」,展示发生在报名之前,
  那一刻两个锚点都不存在,NOT NULL 会让这条合同明写的形态根本写不进来。
  合同**未给**闭集的三处(`RegistrationFormField.visibilityCode` /
  `RegistrationUploadSession.statusCode` / `ActivityQualificationRuleSet.statusCode`)
  与未给的 RuleSet unique 一律**不自行发明**(AGENTS §2)。
