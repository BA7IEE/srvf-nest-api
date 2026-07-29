# AGENTS.md — SRVF AI 协作铁律(Harness 3.0)

> 所有 AI 编码助手(Claude Code / Codex / Cursor / 其他 Agent)的**唯一恒读规则入口**。
> **Harness 3.0 原则:规则语义零放宽,执法从散文搬到机器。** 本文件只留三类内容 ——
> ①机器执法索引(违反时物理拦截或 CI 红,不靠你记住)②**无机器守护的判断型规则**(靠你自己)③决策锁索引。
> 逐条去向见 [`archive/plans/harness-3.0-p3-rule-classification.md`](docs/archive/plans/harness-3.0-p3-rule-classification.md);v2 全文冻结于 [`archive/harness-v1/`](docs/archive/harness-v1/)。

---

## 0. 读取协议

- **恒读**:本文件 → [`docs/current-state.md`](docs/current-state.md)(当前事实 + 不做清单 + 债务)。Claude Code 另读 `CLAUDE.md`。
- **触碰才读**:[`docs/reference/`](docs/reference/) 九篇(§5 索引)· [`RBAC_MAP`](docs/ai-harness/RBAC_MAP.md)(改权限)· 边界四篇 · [`docs/handoff/`](docs/handoff/)(改契约必同 PR 更新)· [`process`](docs/process.md)(开工 / 分级 / 降速 / 收口)
- **不主动读**:`ARCHITECTURE.md` / baseline / V2 红线 / `docs/archive/**`(历史证据,**不是当前事实**)
- **勿整读**:contract snapshot(~3.6 万行,用 diff)/ `pnpm-lock.yaml`

**权威源冲突顺序**:当前事实(current-state + 代码 + GitHub)> 本文件 > baseline > V2 红线 > api-surface-policy > process > ARCHITECTURE > archive。
**发现文档-代码冲突或权威源互冲 → 暂停上报,不擅自调和。**

---

## 1. 机器执法清单(违反 = 物理拦截或 CI 红,不必背)

> 这些规则**语义与 Harness 2.0 完全一致**,只是不再要求你记住 —— 违反时会被当场拦下并告知正确做法。
> 本地自证:`pnpm lint && pnpm harness:selftest && pnpm test:contract`。

| 域 | 载体 | 管什么 |
|---|---|---|
| **字面语法拦截**(17 条,非语义分析) | `eslint.harness.mjs` + `eslint.config.mjs` 接线 | 禁 `@UseGuards`/`@Roles`/裸 `@ApiOkResponse`/局部 `ValidationPipe`/Prisma `$use`·`$extends`/硬删/重定义 Prisma enum/手工包响应/Mapped Types 派生 DTO/`LocalStrategy`/分页别名/散落 `process.env`/判权路径缓存与定时器/裸 `@Param('id')`;禁引 Redis·queue·cache;App DTO 禁引 Admin;Presenter·Policy 禁碰 DB;禁跨模块深引私有子目录。⚠️ 匹配的是**语法树的字面形状**:`import 别名`(`UseGuards as UG`)、`变量中转`(`const db = this.prisma`)、`computed property` **已知可绕过**(`pnpm harness:selftest` 输出的「已知缺口」段逐条列出);自定义规则另立 goal |
| 红区路径 | `harness/redzone.json`(唯一机读源);**权威判定** = `.github/workflows/redzone-trusted.yml`(base-trusted);本地 `redzone-guard.sh` / `bash-write-guard.sh` = **提前反馈,不是最终边界** | 六大红区文档 · workflows · prisma schema/migrations/seed · 全局 Guard/Filter/Interceptor/bootstrap · auth · storage-crypto · archive · 容器构建 · **CI 控制面**(package.json / lock / eslint 与 tsconfig / jest config)· **生产入口**(main.ts / app.module.ts)· authz 与限流装饰器 · 发版脚本;**执法层自身**(scripts 裁判 / hooks / harness / test setup 与 contract) |
| 开工门禁 | `preflight-gate.sh` + `preflight-required.sh` | 依赖或 Prisma 生成物陈旧、落后 origin/main、门禁不可验证 → **拦写**;工作树脏 / open PR → 只提示 |
| 危险命令 | `.claude/settings.json` deny/ask | `migrate reset`/`db push`(**deny 而非 ask** = 任何预授权都不算,必须人当场执行)· `push --force[-with-lease]` · `reset --hard` · 批量 `-D` · 盲 `-u` 更新快照 · 包管理器 |
| 派生文档 | `docs:{readtax,counts,codemap,rbacmap}:check` + `pnpm docs:rbacmap` 生成 | 恒读层体积 · 事实计数 · 模块地图 · **权限地图(生成物,禁手改)** |
| 契约 | `test/contract` snapshot + `EXPECTED_ROUTES` | 5 canonical 前缀 · 端点白名单 · schema 零漂移 |
| 事故回放 | `pnpm harness:replay` | 历史事故 + 反向案例(不该拦时不拦),已挂 CI。输出**分两组计数**:「真触发」(实跑守护并断言裁决)与「结构断言」(只查源码字符串,发现不了『代码还在但不起作用』)—— 别把两组加起来当同一种保证 |

**触碰红区的正确流程**:出人话简报 → 维护者拍板 → **由维护者**跑 `pnpm harness:grant '<glob>' --reason "<出处>"`。
**AI 不得自行发放授权。** 本地令牌只解开「能不能写」,不解开「能不能合」。

---

## 2. 判断原则区(**无机器守护,靠你自己**)

> 这些无法做成确定性检查 —— 它们是本文件真正需要你读进去的部分。

- **授权边界**:已授权清单内连续推进;**清单外停下**。审计 / 调研中发现的问题(即使是明显 bug)**不顺手修**,先汇报。goal 内已写明范围的 C 档免二次确认;goal 外新发现一律按 [process §4.1](docs/process.md) 人话简报上报。
- **诚实**:每次收尾必须输出**「本次未做」**段。所有判断给证据(路径:行号 / 命令输出 / PR 链接),**不凭印象、不确定不写成事实**。无 Docker 时跑 quick 并显式声明「contract / e2e 留给 CI」,**不得谎报全绿**。
- **测试纪律**(⚠️ 当前**无机器守护**,P2c 补):**禁删测试 / 禁放宽断言**;改既有 e2e 断言 = 改行为契约 → **停下报告**。改 service 编排先跑 characterization,行为差异即停。
- **事务**:多写 / 先查后写 / 管理员保护操作必 `$transaction`;计数守护类不变式必须同事务。(AST 判不了 —— 事务常在 caller 或跨方法编排。)
- **跨文件改动**:先用符号 / 引用链确认再动手;**grep 同名只定位候选,禁凭同名盲改**。
- **软删与查询语义**:`notDeletedWhere` 统一过滤;唯一性预检查用 `findUnique`(含软删),详情用 `findFirst`。(lint 只拦硬删,「哪些查询该带过滤」是语义判断。)
- **敏感字段三问**:入 schema / DTO 前必答 —— 业务用途?查看角色与掩码?保存期限与退队清理?**「先占位以后再用」视作越权**;不假设合规方案。
- **snapshot diff 必须逐行可解释**;L3 字段(passwordHash / *token* / secret* / 完整 signed URL)出现即拒。
- **不输出任何 secret**(.env / bucket / APPID / SecretId / SecretKey / signed URL / JWT 内容),调研与报告中亦然。
- **不擅自调和文档冲突**;不主动展开未授权的次要任务。
- **受影响范围**:改哪个模块跑哪组 e2e;动依赖枢纽(permissions / audit-logs / `common/*`)或全局横切 → 先列引用链、直接 `agent:check:full`。(CI 恒跑全量兜底,这条只决定红在本地还是 CI。)

---

## 3. 决策锁索引(**重开任一条前,必须先暂停声明本节存在**)

> 锁 = 维护者已拍板、不得重新质疑的事项。全文见 [`api-client-boundary`](docs/reference/api-client-boundary.md) 与各 reference。

| 锁 | 一句话 | 机器载体 |
|---|---|---|
| D-1 | `contribution-rules` 归 System surface | contract 路由白名单 |
| D-5 | App 准入 = `memberId ≠ null ∧ User.ACTIVE ∧ Member.ACTIVE`;capabilities ≠ 权限码;`/me/*` 与 `/my/*` 物理分离 | contract 断言 + e2e |
| D-6 | App DTO 禁派生自 Admin;L3 默认不返(content-* 读面例外见 api-surface-policy §9.6) | eslint + contract |
| D-7 | 六类职责边界(Presenter / QueryService / Policy / StateMachine / AuditRecorder / Effect) | eslint 禁 Presenter·Policy 碰 DB;归属判断留人 |
| P0-E | refresh token 冻结九条(opaque+sha256 / rotation always / family revoke / 90d 绝对 / 失败统一 10007 / logout 幂等无限流 / access 15m 自然过期 / 联动撤销九场景同事务 / 三 DTO zero drift) | 红区路径 + auth e2e 行为锁 |
| 判权单轨 | 全仓活跃 `@Roles` = 0;业务判权走 Service 层 `rbac.can()`;`RolesGuard` 保留兜底不删;scope 不进权限码;`RbacService` 只读 GLOBAL | eslint + check-rbac-map |
| 防枚举 | 登录失败四场景统一 10004 + dummy bcrypt 抗 timing;SMS / 微信沿 24010 泛化 200;refresh 失败不细分。**任何 message / 错误码 / 耗时差异都算漏洞** | contract 断言(耗时侧信道无法断言 → 判断) |
| 身份/权限不缓存 | 每请求查库;**零跨请求 Map / TTL / invalidate 正确性链** | eslint |
| 永久铁律 | 不引入 `LocalStrategy`;不建 `*.entity.ts`;不用 Prisma 全局软删中间件 / client extension | eslint |
| 基础设施冻结 | cron 全仓终态**恰好 2 个**(第 3 个起 = 新 D 档评审);Redis / queue / LLM / vector / 多租户不引入;数据清理走手动 SOP | counts + eslint 禁引 |
| 敏感字段三问 | 见 §2 判断区 | — |
| 业务行为冻结 | 由冻结评审稿 + e2e 行为锁承载;**改既有断言 = 改行为契约 → 停下报告** | ⚠️ 无(P2c 补) |

**不可逆红线**:`prisma migrate dev|reset|db push` 任何环境**禁自动跑**(reset 恒需用户实时同意,**goal 预授权不算**);生产只 `prisma migrate deploy` 已审查 migration。物理删数据 / 批量回填必须先拍板。

---

## 4. 流程与并行

- **开工**:`pnpm agent:preflight`(Claude 会话已由 SessionStart hook 自动执行并注入结论);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`。
- **分级与降速**:PR 五档(A/B/C/D/E)、D 档六步降速、人话简报格式、release 两段式收口(`pnpm release:prepare` / `release:finish`)、squash 清理八条 → 全部在 [`docs/process.md`](docs/process.md)。
- **C 档及以上默认以 goal 形态立项**(`srvf-goal-author` 起草);goal 五要素:DoD / 探针队列 / 授权清单 / 禁止域 / 写集声明。
- **lane 并行**(≤3 条):写集相交或同 bounded context → 不并行;schema-touching lane ≤1;串行集成;唯一简报流;总控不写业务代码。全文 [process §8](docs/process.md)。
- **跨模型互查**:写与查跨模型(同模型自写自查会一起漏);分歧不内部调和,升级进简报。

---

## 5. reference 索引(触碰才读)

| 细则 | 何时读 |
|---|---|
| [naming-dto-validation](docs/reference/naming-dto-validation.md) | 建模块 / 写 DTO / 字段校验 |
| [response-pagination-errors](docs/reference/response-pagination-errors.md) | 返回结构 / 分页 / 错误码 / P2002 |
| [swagger](docs/reference/swagger.md) | 写 / 改 endpoint 注解 |
| [auth-jwt-refresh](docs/reference/auth-jwt-refresh.md) | 碰登录 / JWT / 密码 / refresh / throttler |
| [soft-delete-transactions](docs/reference/soft-delete-transactions.md) | 删除语义 / 事务边界 |
| [roles-admin-protection](docs/reference/roles-admin-protection.md) | 用户管理 / 角色边界 |
| [config-env](docs/reference/config-env.md) | 新增 env / 配置 |
| [testing-discipline](docs/reference/testing-discipline.md) | 写测试 / 动 snapshot / **e2e 并行纪律** |
| [api-client-boundary](docs/reference/api-client-boundary.md) | surface / App DTO / **决策锁全文** |
