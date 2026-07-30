- **首批初始化指引订正 + 文档可执行 smoke(2026-07-31;证书标准库第二轮跨模型评审 findings G4)**:`docs/ops/certificate-standard-library-initialization.md` 的建标准示例此前带着 `"levelCode": null` / `"parentId": null`,而 `certificate-standards.service.ts` 的判据是 `!== undefined` —— 显式 `null` 会掉进字典查询 / 父节点查询分支。**照着这份文档做首批初始化,第一步就撞墙**(实测返 500,连清晰的业务错误码都没有)。示例改为**直接省掉这两个可选字段**,并补一段「可选字段要么给真值、要么整条省掉」的说明。

  同时删掉第五节那句过期表述:「`parentId` 只能在 create 时设,事后想挂只能删掉重建」。它与 [amendments A-3](docs/archive/reviews/certificate-standard-library-t0-amendments.md) 直接冲突 —— DRAFT 且从未启用过的标准,`PATCH /:id` 是接受 `parentId` 的。改成「两个顺序都行」并说明补设条件。

  **加了一条按文档示例原样执行的 e2e**(`test/e2e/certificate-standard-library-initialization-doc.e2e-spec.ts`,4 条):它**解析文档里的请求示例并真的发出去**,而不是照抄一份等价请求 —— 抄件在文档漂移时不会红。覆盖建标准 → 启用 → 建认定规则 → 启用 → 文档第四节 smoke 的第 1、2 步,外加一条真请求证明「DRAFT 期可补设 `parentId`」不是纸面规则。解析器另有一条对账用例(断言恰好抽到两段、路径与本仓路由一致),防止「抽到 0 个块也全绿」这种最坏的假绿。

  已验证反向:把示例改回带显式 `null` 的旧版本,该 smoke 立刻红(create 返 500)。
