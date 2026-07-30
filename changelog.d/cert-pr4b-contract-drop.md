- **旧证书事实物理删除与约束收紧(2026-07-30;证书标准库 PR-4b,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §20 / §21)**:第 **67** 个 migration,**contract 且不可逆**。与 PR-2(expand-only)成对收口:那一刀只加列不写,这一刀把 PR-4a 三刀切完写路径后剩下的过渡状态删干。Endpoint 恒 **435** · Controller 恒 **84** · 权限码恒 **222** · BizCode 恒 **306** · AuditLogEvent 恒 **129**。

  **DROP 七列**:

  | 表 | 删掉的列 | 为什么 |
  |---|---|---|
  | `Certificate` | `certTypeCode` · `certSubTypeCode` | 类别与等级由 `standardId` 唯一决定(§6 数据权威表明令禁止实例侧副本);留着就是「按 category 猜 Standard」的现成入口 |
  | `Certificate` | `isInternal` | 本会颁发与否是**标准**的性质,权威在 `CertificateStandard.isInternal` |
  | `Certificate` | `imageKeys` | 证据改读 `sourceClaim.imageKeys`(§13.5),blob 单一属主是 Claim |
  | `recruitment_applications` | `certificateImages` · `certificateReviewStatus` · `certificateIssuanceInfo` | 「按类别一格」的产物,结构上表达不了同类别多张证书 |

  **三列转 NOT NULL**:`standardId` / `recognitionPolicyId` / `sourceCode`(§20.2「nullable 过渡字段不得进入 release」)。`recognitionIssuerId` **仍可空** —— FREE_TEXT 认定规则下本就没有 issuer 实体,机构名在 `issuingOrg` 快照里;把它一起收紧会逼出一个假的「自由文本 issuer 行」。

  **新增来源 CHECK** `certificate_source_claim_consistency_check`:`sourceCode=RECRUITMENT` → `sourceClaimId` 非空;`ADMIN` → 为空。它挡的是「RECRUITMENT 却没有 sourceClaimId」那种行 —— §13.5 的证据读取会无处取 key,而这种坏行只在有人点开它时才显形。双向阳性对照已跑(ADMIN 无 claim 放行 / RECRUITMENT 无 claim 被 23514 拒)。

  **⚠️ 两处对外契约破坏:**

  1. **小程序 `GET /api/app/v1/my/certificates`**:出参 `certTypeCode` / `certSubTypeCode` → `standardId` + `standardName` + `certCategoryCode` + `certLevelCode`(字段数 12 → 14);`isInternal` 保留字段名但值取自 Standard;查询参数 `certTypeCode` → **`certCategoryCode`**(值域不变,仍是 cert_type 字典 code,只是过滤落到 `standard.categoryCode`)。
  2. **管理端报名 DTO 的 `certificates` 证书摘要字段移除**。它原本由三个 JSON 列的类别并集拼出来。替代者是 PR-4a-1 已上线的专用端点 `GET /admin/v1/recruitment/applications/:applicationId/certificate-claims` —— 那里有正确的敏感分级。不在报名 DTO 里再拼一份:两个读路径必然出现两套掩码规则,而其中一套迟早松。

  **两处「typecheck 抓不到」的真实隐患**,是本刀最值得记的部分:

  - `where` 用**展开**语法时,TypeScript 的多余属性检查**不穿透 spread** —— App 列表的 `{ certTypeCode: ... }` 在列删掉之后**依然编译通过**,只会在真实请求打到 Prisma 时才炸;
  - `notDeletedWhere(...)` 入参是宽类型,§10.5 **资质判定**(全系统最关键的一次读)里的 `certTypeCode` 同理。

  两处都改成经关联走 `standard: { categoryCode }`,并各加**正向 + 反向**双断言(断言新落点在、旧 key 不在)。少了反向断言,回退到旧写法不会红 —— 而 typecheck 也不会红。

  **审计快照两处改动**:`certificate.expire`(到期 cron)与 `certificate.create/update/...` 的 before/after 里,类别副本 `certTypeCode` 改为 `standardId` / `recognitionPolicyId` / `sourceCode` 引用。记引用而不是记副本:事后要看类别就 join,不必让审计自带一个会漂移的字符串。

  **新增共享测试夹具** [`test/fixtures/certificate-standard.fixture.ts`](test/fixtures/certificate-standard.fixture.ts)。冻结稿 §5.6 末条要求「任何测试 fixture 或直接 Prisma 写都必须提供 Standard 和 Policy」,本刀把它从「应该」变成 DB 层强制 —— 十四个 spec 的直插证书都需要一对 id。做成一份共享夹具而不是十四份拷贝:拷贝迟早分叉,而它们描述的是同一件事。

  **写集扩展一处**(维护者 2026-07-30 同意):`src/modules/notifications/expiry-reminder.service.ts` 读 `Certificate.certTypeCode`,不动它 4b 编译不过。改动限于「类别副本换成 standardId 引用」,不碰 cron 谓词或提醒语义。

  **上线 SOP** 见 [`docs/ops/certificate-standard-library-go-live.md`](docs/ops/certificate-standard-library-go-live.md):执行前必跑的七条只读探针、迁移后三条结构复核、**无列级回滚**的处置边界(若 4b 完不成则回滚 4a 不发版)、以及初始化硬前提(库里必须先有 Standard + ACTIVE Policy,否则任何建证都失败)。

  §20.1 探针在 head schema 干净库上**八项全 0**,空库切换、零回填。**这不能替代生产库的探针** —— runbook 里写明了这一点。
