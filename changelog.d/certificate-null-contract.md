- **证书域 `null` 契约收口(2026-07-31;第四轮跨模型评审 P1)**:**零 schema**(Migration 恒 67 · Endpoint 恒 438 · 权限码恒 222 · BizCode 恒 306 · Cron 恒 2),**OpenAPI 契约零变化**。

  **⚠️ 行为变更(管理端 / 前端如果曾经显式发 `null`,现在会拿到 400)**:证书域四个 DTO 的可选入参,凡**业务上不可清空**的字段,显式传 `null` 从此稳定 `400`。此前它们的表现是三种里的一种:

  | 端点 · 字段 | 修复前实测 | 现在 |
  |---|---|---|
  | Claim 审核 `issuedAt: null` | **200**,且 `new Date(null)` = **1970-01-01** 作为正式审核事实落库,并**照常参与资质门槛派生** | 400 |
  | Claim 审核 `standardId: null` / `note: null` | 200 / 落一条没有驳回理由的 REJECTED | 400 |
  | Policy PATCH `issuerPolicy` / `certNumberMode: null` | **500**(`null` 进 Prisma 非空列) | 400 |
  | Certificate PATCH `standardId: null` | **500** | 400 |

  **注意**:OpenAPI schema **早就**把这些字段声明成不可空(`type: string`,无 `nullable`)—— 契约一个字都没变,变的是「实现终于执行了契约已经写着的东西」。所以 `openapi.json` 与 contract 快照零 diff。

  **机制**:`@IsOptional()` 对 `null` 与 `undefined` **都**跳过后续校验,而本仓 service 判「传没传」一律用 `=== undefined` / `!== undefined` / `??`。语义错位 ⇒ 显式 `null` 穿过整个契约层。三种后果里最难查的是「200 且什么都没改」—— 没有报错、没有日志、没有异常指标。

  **`@OmittableOnly()` 提为全仓公共装饰器**(`src/common/decorators/omittable-only.decorator.ts`)。它原先只定义在 `certificate-standards.dto.ts` 内部(第三轮 H3),而同一个缺陷在隔壁三个证书域 DTO 里原样存在 —— 这正是「修被点名的实例、下一轮在邻居文件被找到同类」的形状。用法二选一,按字段的**业务语义**选:

  - 业务上真的可以清空 → 保留 `@IsOptional()` + TS 类型标 `T | null` + `@ApiPropertyOptional({ nullable: true, type: X })`,service 显式区分 `undefined`(保持)与 `null`(清空);
  - 业务上必须有值、只是可省略 → `@OmittableOnly()` + 原有校验器,`null` 稳定 400。

  证书域四个 DTO 的 **47 处**真装饰器逐条分类完毕:**8 处判为真可空**(Certificate PATCH 的 `recognitionIssuerId`/`issuingOrg`/`certNumber`/`expiredAt`,Standard 的两处 `description` 与 Update 的 `levelCode`/`parentId`),**39 处判为仅可省略**并改用 `@OmittableOnly()`。

  **两道防御,不只 DTO**。service 侧把判据从 `dto.issuedAt === undefined` 换成**正向类型检查** `typeof dto.issuedAt !== 'string'`。最深的一道放在 `CertificateRecognitionResolver.resolveDates` —— 它是**建证 / 审核通过 / 改证三个入口共用**的那一段,少写一处就是一个新的 1970 入口。配套新增 `parseDateOnlyStrict()`(`src/common/datetime/date-only.util.ts`):`new Date(null)` / `new Date(true)` / `new Date([])` **全都给 1970-01-01 而不是 Invalid Date**,所以「先 `new Date` 再判 `NaN`」这种写法根本拦不住它们,必须在 `new Date` **之前**做正向类型 + 形状检查。

  **两条与评审报告原文不同,已订正**(复审请重点看):`validityMode: null` 修复前返回的是 **400 不是 500** —— `assertValidityCombination(FIXED_MONTHS, null)` 顺手把它拒掉了;`issuers: null` 被 `?? []` 折成空数组,但 issuer 数量检查(FIXED 恰好 1 / ALLOWLIST ≥1)顺手挡住,**当前不是可达的静默清空**。两条仍一并收口:依赖「恰好被别的规则挡住」正是这一轮在修的形状。`validityMonths` 判为**仅可省略** —— 它的 `null` 由 `validityMode` 派生(改 mode 时 service 自动归零),不由客户端独立指定。

  **新 e2e** `test/e2e/certificate-null-contract.e2e-spec.ts`(16 例)分三段:A 段「该 400 的必须 400」+ B 段**反向数据断言**(400 之后 `Claim.status` / `version` / `thresholdMarks` 不变、不新增审核审计、**全表不存在 1970-01-01 的 `issuedAt`**)+ C 段 **5 条正向可 null**(证明没有矫枉过正 —— 真能清空的字段仍然清得掉)。只断言状态码会放过「先写坏再报错」的实现,而那正是 1970 那条缺陷的形态:它压根没报错,直接写成功了。

  **顺带清掉三处「注释≠执行位」**(本项目第五次抓到该形状):`recruitment-certificate-claims.service.ts` 的文件头与 `review()` / `revokeReview()` 都写着「本刀**不重算门槛**」,而 PR-4a-2 早已接线、三个方法结尾都在调 `recomputeCertificateThresholds()`。**只改注释、不改代码**(代码是对的)。
