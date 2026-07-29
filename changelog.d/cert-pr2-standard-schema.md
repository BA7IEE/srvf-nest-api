- **证书标准库 / 队内认定规则 / 招新证书申报 schema 骨架(2026-07-30;证书标准库 PR-2,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §5 / §16 / §17)**:第 66 个 migration,**expand-only**,**零业务行为变更**(新模型此刻无任何 controller / service / DTO,写入口在 PR-3 起)。

  **四类事实分表**(D-CERT-001)。合表的代价是冻结稿 §0 的实证:认可机构或有效期一变,同一种证就被迫复制出 v2、v3,最后是 `bsafe_l2_final_final` —— 那不是版本管理,是证书身份被炸碎。
  - `CertificateStandard` —— 「这是什么证」,稳定身份;code 建后不可改不可复用
  - `CertificateRecognitionPolicy` —— 「本队某时期怎么认可它」,规则版本可迭代
  - `CertificateRecognitionIssuer` —— 认可机构;实例认可靠 issuer id **不靠机构文字匹配**(中文机构名匹配不可靠)
  - `RecruitmentCertificateClaim` —— 「申请人拿来了什么」,**一张真实证书一条**;允许审核前未分类(「不知道」是工作流状态,不是一种正式证书)

  **8 个新枚举**;`CertificateValidityMode` 刻意把 `EXPLICIT_REQUIRED` / `EXPLICIT_OPTIONAL` 拆开 —— 旧设计用一个 `MANUAL` 同时表达「必须手填到期日」和「可不填即终身」,两种语义混在一个值里校验写不出来。`CertificateSource` 只有真实存在的 `ADMIN` / `RECRUITMENT`,**不预埋** `APP_SELF` / `IMPORT`。

  **`Certificate` 加 5 个 nullable 列** + 3 索引(`standardId` / `recognitionPolicyId` / `recognitionIssuerId` / `sourceClaimId`(@unique) / `sourceCode`),**本刀零写入**:PR-4a 才开始写,PR-4b 收紧 NOT NULL 并 DROP 4 个重复事实列。`sourceClaimId` 必须本刀加 —— Claim 有 `certificate Certificate?` 反向关系,缺这一侧 `prisma generate` 直接失败,而铁律 11 要求每个 PR 都能 generate。

  **4 条复合 FK 提前到本刀**(维护者拍板,冻结稿原定 PR-4b):`(policyId, standardId)` → Policy`(id, standardId)` 与 `(issuerId, policyId)` → Issuer`(id, policyId)`,Certificate 与 Claim 各一对,锁死「这张证的 Policy 必须属于它的 Standard、issuer 必须属于它锁定的 Policy」。列此刻全 NULL,PostgreSQL MATCH SIMPLE 任一列 NULL 即放行,空表期不受影响;**提前落是收紧不是放松** —— PR-4a 一开始写入就有 DB 兜底,不会写完一轮不合法组合才在 PR-4b 发现。

  **2 条手写 partial unique + 4 条 CHECK**(Prisma DSL 表达不了):每 Standard 至多一个 ACTIVE Policy(激活是「锁 Standard → RETIRE 旧 → 激活新」,READ COMMITTED 下两个并发激活能互相穿透,只靠 service 检查会双 ACTIVE);同 Policy 下 issuer 去重;Claim 的 APPROVED / PROMOTED 完整性、日期区间、`version >= 0`。

  **权限 +8**(权限码 214 → **222**):`certificate-standard.{read,create,update,delete}.record` + `certificate-recognition-policy.{read,create,update,delete}.record`,**全绑 ops-admin**(ops-admin 96 → **104**)。Standard / Policy 是全局主数据配置面(§16.4:走 `RbacService.can()`,不是 Certificate 实例的 scoped Authz),与 `dict.*` / `position.*` / `role-binding.*` 同列 `PR_2A_PERMISSION_SEED`。

  ⚠️ **一处设计订正**:起初按 §16.4 表格「biz-admin Standard read = 是」把两条 read 码同时列进业务面,被 `seed-biz-admin` 用例 5 拦下 —— 那条用例钉着本仓一条**架构不变量:业务面码集与 ops-admin 码集互不相交**。放宽它是 goal 明令禁止的,所以改为 8 码只绑 ops-admin,biz-admin / org-admin 绑定数不变(69 / 47)。§16.4 自己给了这条路:「options endpoint 可以接受 Standard read,**或由持 certificate create/verify、recruitment certificate review 的角色获得专门只读绑定**」。⇒ **PR-3 落 `/certificate-standards/options` 时判权必须接受 `certificate.create.record` / `certificate.verify.record` / `recruitment-application.review.certificate` 作为替代入口码**,否则 biz-admin / org-admin 建证时下拉是空的。

  **AuditLogEvent +4**(123 → **127**):`certificate-standard.change` · `certificate-recognition-policy.change` · `recruitment-certificate-claim.review` · `recruitment-certificate-claim.review-revoke`。本刀只登记常量,消费方在 PR-3 / PR-4a —— 先落是为了让 counts / 契约一次到位,不必在后续刀里再动这类跨模块枚举。

  **验证**:干净库 `migrate deploy` 重放 66 个 migration 全绿 + seed 幂等二跑(0 error、计数稳定);2 条 partial unique、4 条 CHECK、复合 FK **逐条跑过阳性对照** —— 第二个 ACTIVE Policy 被拒而第二个 DRAFT 放行、同名 issuer 被拒、APPROVED 缺字段 / PROMOTED 缺 promotedAt / `expiredAt < issuedAt` / 负 version 全被拒,而「未分类 SUBMITTED Claim」与 `expiredAt == issuedAt` 正确放行,跨 Policy 的 issuer 组合被复合 FK 拒。四条空库探针(含 PR-4b 追加的「旧列全空」)实测全 0。

  ⚠️ `docs:rbacmap:check` 现有一条 **WARN**:8 条新码在 `src/` 无引用(「孤码候选,可能是刻意预埋」)。这是 PR-2 的预期状态(权限骨架先落、消费方在 PR-3),不是 FAIL。
