- **管理端建证 / 改证切到 Standard/Policy(2026-07-30;证书标准库 PR-4a-3,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §9.1 / §9.2 / §19 / §21)**:**零新增端点**(Endpoint 恒 435 · Controller 恒 84 · 权限码恒 222 · Migration 恒 66 · BizCode 恒 306)。这一刀只换 `POST/PATCH /admin/v1/members/:memberId/certificates` 的入参与写入列。

  **⚠️ 契约破坏性变化(管理端建证表单必须适配):**

  | 旧入参 | 新入参 |
  |---|---|
  | `certTypeCode`(必填)+ `certSubTypeCode` | `standardId`(必填;须 ACTIVE 且 CREDENTIAL) |
  | `issuingOrg`(恒必填自由文本) | `recognitionIssuerId` **或** `issuingOrg` —— 传哪个由该 Standard 当前生效认定规则的 `issuerPolicy` 决定:`ALLOWLIST` 必传 id、`FIXED` 可不传(后端选唯一)、`FREE_TEXT` 必传自由文本 |

  标准来源:`GET /admin/v1/certificate-standards/options`(PR-3 已上线,四条入口码任一可读)。

  **为什么不保留旧字段做兼容**:两套入参就是两个事实源,而「按 category 猜 Standard」是冻结稿明令的硬禁区。旧字段留着,下一个人就会用它。

  **出参新增四列**:`standardId` / `recognitionPolicyId` / `recognitionIssuerId` / `sourceCode`(`ADMIN` = 管理端录入 / `RECRUITMENT` = 招新发号搬运)。它们是队内主数据的**引用**(L1 配置面),不是敏感字段 —— 前端靠 `standardId` 显示「这是哪个标准」,靠 `sourceCode` 决定证据从哪读(§13.5)。PR-4b 后三列恒非空。

  **§9.2 改证的两条规则**,分岔点是「有没有换标准」:

  - **改 Standard** → 重选**当前 ACTIVE** Policy 并完整重校验(换标准就是换规则);
  - **只改事实** → 继续沿该证**已锁定**的 `policyId` 校验,避免规则在录入后移动。原 Policy 已 `RETIRED` 仍允许按该版本修正与复核。

  `standardId` **只在 pending 态可改**(纠正选错的标准),非 pending 传它 → `18033`。这条判断依赖行状态,DTO 表达不了,所以放在**行锁之后** —— 锁前判会被并发的 verify 抢在中间。改核心事实后 verified / expired / rejected 一律回 `pending` 重新复核。

  **一处实现 bug 由单测抓到**:PATCH 是部分更新,没传的字段应保持库内现值。我最初把机构一对直接当 `null` 传给 Resolver,于是「只改 `expiredAt`」会被 `FREE_TEXT` 规则以 `18013` 拒掉一次本来合法的日期修正。改为两个机构入参各自回落到库内值(显式传了哪一个就清掉另一个,它们互斥)。抓到它的是 PR-1 留下的那条「只改 expiredAt 也要与库内 issuedAt 比较」用例 —— 它本来锁的是日期基准,顺带把这个漏洞照了出来。

  **`assertDateSemantics` 退役**:PR-1 加的那两条判断(`issuedAt` 不晚于今天 `18018` / `expiredAt` 不早于 `issuedAt` `18017`)已经在 `CertificateRecognitionResolver.resolveDates` + `assertRange` 里,而且那里还多了按 `validityMode` 的规则校验。留两份日期算法正是 §19 明令要避免的「第二套日期算法」—— 两份迟早会在某次改动里分叉。行为等价由既有 e2e 保证(那几条用例逐字未改,只是现在打在 Resolver 上)。

  **旧列停写**(§21):`certSubTypeCode` / `isInternal` / `imageKeys` 本刀起**根本不出现在写入 data 里**(不是写 `null`),单测用 `not.toHaveProperty` 正向锁住。`certTypeCode` 仍 NOT NULL(4b 才 DROP),按已解析 Standard 的类别回填一次 —— 值派生自 Standard,**不是**第二个事实源。

  **字典校验没有消失,只是搬了位置**:`cert_type` / `cert_sub_type` 的有效性现在由 PR-3 的 Standard 管理面在**建标准时**校验一次,建证时不再重复猜。`GET .../certificates/qualification-flag` 的 `certTypeCode` query 参数**不变**(它是读侧契约,不在本刀范围)。

  **退役测试都换成等价的新格,不是删掉覆盖**:「字典 code 不存在 / INACTIVE / 子类型不存在」三格 → 「Standard 不存在 / 未启用(DRAFT)/ 是 FAMILY 不可持有 / 已收录但无生效认定规则」四格 + 「ALLOWLIST 机构不属于本规则 → 18014」+ 「FREE_TEXT 不传机构 → 18013」;`PATCH certTypeCode 无效` → `PATCH standardId 不存在` 与「非 pending 改 standardId → 18033、pending 可改且 policyId/certTypeCode 跟着重选」。单测净 +2 条(46 → 48)。

  单测注入的是**真实 `CertificateRecognitionResolver`**(它是零依赖纯类)加三张表的 mock,而不是打桩 Resolver —— 打桩会让「机构 / 编号 / 日期按规则校验」在单测里彻底测不到。
