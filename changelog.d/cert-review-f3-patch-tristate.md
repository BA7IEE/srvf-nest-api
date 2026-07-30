- **PATCH 三态语义 + 日期真实性 + 核验落点状态(2026-07-30;证书标准库跨模型评审 findings F3,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §9.2 / §9.3 / §10.2 / §10.4)**:零新增端点、零新增权限码、零 schema 变更(Endpoint 恒 438 · Migration 恒 67)。⚠️ **契约收紧**,`openapi.json` 同 PR 已刷新。

  ### ① PATCH 三态(V1)

  ```
  字段不出现        → 保持库内现值
  字段出现且为 null → 清空
  字段出现且有值    → 用新值
  ```

  修复前两条都不成立,而且是**双向**失效:

  - `expiredAt` 的回落判据写的是 `dto.standardId !== undefined ? null : 库内值` —— 判的是「传没传 standardId」而不是「换没换」。管理端表单几乎都是「回填 + 整体提交」,于是**带上原样 standardId 却不带 expiredAt 的一次保存,会把一张有到期日的证书静默清成终身有效**。
  - `dto.expiredAt ?? 库内值` / `dto.certNumber ?? 库内值` 里的 `??` 把**显式传来的 null** 当成「没传」,所以到期日清不成终身有效、`OPTIONAL` 编号也改不回无编号。

  三态在**契约层**表达:可空字段类型改为 `string | null`(`@IsOptional()` 对 null 与 undefined 都跳过校验,显式 null 因此能穿过校验层抵达 service)。库内 NOT NULL 的 `issuedAt` 改用 `@ValidateIf` 而非 `@IsOptional()` —— 后者会让 `issuedAt: null` 静默通过再被 `??` 悄悄换成库内值,客户端以为自己清空了;现在稳定 400。

  **一条顺带修掉的、原报告没提的缺陷**:`PERMANENT` / `FIXED_MONTHS` 是**派生型**规则,客户端不得传到期日。所以「不传 = 保持库内现值」对它们不能照字面执行 —— 把库内那个后端自己算出来的值回传给 Resolver 会被拒成 18016。结果是修复前**一张 FIXED_MONTHS 证书只改机构名会 400**。现在按 `expiryIsClientSupplied(mode)` 分流:派生型不回传,让规则按同一个 `issuedAt` 重新派生出同一个值。

  ### ② 真实值变化才回 pending(R6)

  「改核心事实 → 打回 pending 重审」的判据从 `factsTouched`(**字段在不在请求体里**)改为「Resolver 算出的最终值与锁后库内值逐字段比对」。修复前一次零变更的整表单提交就会把已核验证书打回重审 —— 那不是边角情况,是管理端表单的常态。

  ### ③ 核验一张已过期的证书直接落 expired(V7)

  `verify()` 此前写死 `verified`,理由是「`expired` 由每天 09:00 的到期扫描 cron 推动」。但那条 cron 只处理**已经是 verified** 的行,而这里正是产出 verified 行的地方 —— 于是一张最后有效日早于今天的证书被核验后,会一直被资质查询当作有效直到次日 09:00。发号路径(§8.5 第 8 步)早就按同一规则分流了,管理端核验没跟上。边界是「最后有效日当天仍有效」。

  ### ④ 日期真实性补齐(V5)+ 工作台分页边界(V8)

  `@IsDateString({ strict: true })` 此前只在 `certificates.dto.ts` 有,`recruitment-certificate-claims.dto.ts` 与 `certificates-workbench.dto.ts` **各 0** —— `@Matches` 只管形状,拦不住 `2026-02-30` 这类形状合法但不存在的日期。两处各补 4 个字段。

  工作台 `page` / `pageSize` 此前只有 `@IsInt()`,`minimum` / `maximum` 只写在 Swagger 注解里(**文档不是校验**),`pageSize=100000` 会原样进 `take`。而那里的注释当时写着「@Min/@Max 在此复用其常量」—— 描述的规则根本不存在。这是本批第三处「注释写对、执行位没跟上」。现在 Swagger 注解与 `@Min/@Max` 引用同一个常量,文档与执行位不可能再分叉。

  > V8 按 goal 原计划属 F5,实际落在本刀:它与日期校验是同一个文件、同一类缺陷,拆开会让同一个 DTO 在两个 PR 里被改两次。

  ### 测试

  新增 `test/e2e/certificates-patch-tristate.e2e-spec.ts`(38 条):三态矩阵(`standardId` 三态 × `expiredAt` 三态)· 四种 `validityMode` 各自「只改无关字段时到期日不动」· `certNumber` 三态 · R6 正反成对(零变更不打回 **且** 真变更仍打回)· 核验过期/当天到期两个边界 · 5 个不存在日期 × 3 个入口 · 分页 5 个越界 + 1 个恰好上限 · 「三态不等于放开规则」两条(`PERMANENT` 传到期日仍拒、`EXPLICIT_REQUIRED` 传 null 仍拒)。
