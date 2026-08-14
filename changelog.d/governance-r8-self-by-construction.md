### Changed

- 架构治理:R8 新增第六个断言族 `self-by-construction`,给 `scope: self` 出**结构性**判据。前五族证的是「判权发生过」(调用形态 + 后果分支);这一族证的是**「不可能冒充」** —— self 的「资源 ⋂ 身份」是 where 子句不是调用,没有可观测的调用点,可证的只有「handler 没有任何调用方可用来指定别人的输入面」。判据取**默认拒绝**:handler 的每个参数必须被白名单归类为框架注入的身份(`@CurrentUser`)或可枚举名字的调用方输入(`@Param`/`@Query`/`@Body`);`@Req`/`@Headers`/自定义装饰器/无装饰器一律**落 T3**,因为它们把整个 request 交给 handler,没有名字集可查、也就没有诚实的放行理由。DTO 携带的字段名由 TypeScript `TypeChecker` 展开(继承 / `PickType` / `OmitType` 由编译器负责,不在 R8 里重写第二个解析器);拿不到 typed program 一律落 T3,不回落字符串解析。

- 实测:43 条声明 `scopes:['self']` 的端点里 **25 条 self 轴闭环**,18 条拒(8 条 `@Req` / 7 条 `@Param` 携带 `id` / 2 条 `@Body` 携带 `phone` / 1 条 `@UploadedFile`)。**但全仓 T3 只从 113 降到 110** —— 那 25 条里有 22 条同时被**另外两轴**挡着:`admission app-member has no AppIdentityResolver.resolve deny branch` 与 `engine authz-scoped has no authz-can-explain assertion`。两者都属于既有五族,本刀的硬边界明写不得改动,故如实留在 T3 并逐条记录。**「self 轴闭环」与「端点转出 T3」是两件事**,报告按前者计数。

- 判据的正确性由变异对拍绑定,三条子句各自独立:变异「可控输入携带主体标识即拒」→ 4 条负样例翻红;变异「未登记装饰器即落 T3」→ 1 条负样例翻红;两红集**不重叠**。另有一条**结构自保**用例:把 registry 里的主体名字集改空后,连正样例也必须落 T3 —— 变异掉这条守卫后实测正样例变成 T1/closed,即名字集写漏会从「少拒一条」升级成「整族盖章」,方向正好反了。正样例覆盖 DTO 展开通道(无主体字段的 DTO 必须放行),否则「一律拒绝」也能让负样例全绿。

- R8 仍恒 report-only,本次不转闸;零 `src/**` 业务改动、零 schema、零既有测试断言变更。`AUTHZ_ASSERTION_PATTERNS` 的单源仍在 `src/common/authz/authz-context.ts`,`harness/authz-assertion-patterns.json` 由 `pnpm docs:authz` 投影产出。
