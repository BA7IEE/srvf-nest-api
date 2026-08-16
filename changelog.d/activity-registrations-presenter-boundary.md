### Changed

- 活动报名模块响应序列化抽出 `ActivityRegistrationPresenter`(Phase 6-B 第三域第二刀,架构边界 §3.1):详情 / 列表项 / 跨轴列表项(含 `expand` 投影)的 Prisma 行 → DTO 纯字段映射、`extras` 的 Json 收敛、`expand` 白名单与解析,以及 CSV 的 BOM 首 chunk、表头与行格式化迁入该类。文件名走 `*presenter*.ts` ⇒ 落入 `eslint.harness.mjs` 规则 (j) 的结构性守护(Presenter 禁 import `PrismaService`)。事务、判权、状态机判定、audit 与查询构造均不随迁。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
