### Changed

- 架构治理 Phase 3 前置：R5/R6 边界扫描器改为 **typed-AST** 判定（`ts.Program` + `TypeChecker`，作用域复用仓库 tsconfig）。Prisma 访问的识别锚点从「接收者叫不叫 prisma/tx/client/db」换成「该成员访问的**类型**是否恰好解析到一个生成的 `<Model>Delegate`」，`$queryRaw`/`$executeRaw` 通道同改为按类型判定。实仓读数 511 → 512 条（0 条消失），能力差距由 selftest 对抗样例证明：import 别名 / 解构 / 变量中转 / re-export / tx 参数改名 / 窄口 client 六类，名字启发式 0/6、类型解析 6/6；两条 lookalike 负样例名字启发式全误报、类型解析全正确。债务身份 `callSiteId` 升级为归一化 AST 路径哈希，201 条 call-site 条目经 `supersedes` 迁移（21 条域级 undeclared-edge 条目不适用），条目集恒等、无碰撞；新增 `pnpm docs:boundaries:ids:check` 作为身份漂移的常驻判据。零 `src/**` 改动、零业务行为变化、规则仍恒 report。
