# AGENTS.md — SRVF AI 协作铁律(Harness 2.0)

> 所有 AI 编码助手(Claude Code / Codex / Cursor / Copilot / 其他 Agent)的**唯一恒读规则入口**。
> Harness 2.0 起(T0:[`docs/archive/reviews/harness-2.0-t0-review.md`](docs/archive/reviews/harness-2.0-t0-review.md)):实现细则移 [`docs/reference/`](docs/reference/)(触碰才读,§6 索引);v1 全文冻结于 [`docs/archive/harness-v1/AGENTS.md`](docs/archive/harness-v1/AGENTS.md)。
> 本文件体积由 `pnpm docs:readtax:check` 守护(≤18,000 字符);**决策语义零放宽,只改投递方式**。

---

## 0. 读取协议与权威源(全仓唯一副本;别处只留指针)

**分层读取**:

- **恒读层**(每会话开工必读):本文件 → [`docs/current-state.md`](docs/current-state.md)(当前事实唯一权威源)→ [`docs/process.md §2/§3`](docs/process.md)(门禁 + 五档)。Claude Code 另读 `CLAUDE.md`。
- **触碰才读**(改到哪个主题读哪篇):
  - [`docs/reference/`](docs/reference/) 细则九篇(§6 索引)
  - 模块级 `CLAUDE.md`(12 个,动模块时顺手校准)/ [`CODEMAP.md`](CODEMAP.md)
  - [`docs/ai-harness/RBAC_MAP.md`](docs/ai-harness/RBAC_MAP.md)(改权限**必读**)
  - 边界四篇:[`api-surface-policy`](docs/api-surface-policy.md) / [`architecture-boundary`](docs/architecture-boundary.md) / [`participation-bounded-context`](docs/participation-bounded-context.md) / [`attachment-config-boundary`](docs/attachment-config-boundary.md)
  - [`docs/handoff/`](docs/handoff/)(改契约必同 PR 更新)/ process 其余节
- **背景层**(不主动读):`ARCHITECTURE.md` / baseline / V2 红线 / `docs/archive/**`(历史证据,不当当前事实)。
- **勿整读**:contract snapshot(~3.6 万行,用 diff)/ `pnpm-lock.yaml` / archive 正文。

**权威源冲突顺序**(高 → 低):

1. 当前事实:[`docs/current-state.md`](docs/current-state.md) + 代码 + GitHub 当前状态
2. 本文件(长期铁律)
3. [`baseline`](docs/srvf-foundation-baseline.md) > [`V2 红线`](docs/V2红线与复活路径.md) > [`api-surface-policy`](docs/api-surface-policy.md)
4. [`process`](docs/process.md) > `ARCHITECTURE.md` > `archive/**`(仅历史证据)

高低冲突低让步;**发现文档-代码冲突 / 权威源互冲 → 暂停上报,不擅自调和**。

**六大红区文档**(非用户授权不改):本文件 / `ARCHITECTURE.md` / `CLAUDE.md` / baseline / V2 红线 / api-surface-policy。`archive/**` 与已发布 CHANGELOG 段**不回改**。

---

## 1. 铁律速查(主题 → 一句话;细则在出处,改到才读)

| 主题 | 一句话 | 细则 |
|---|---|---|
| 包管理 | pnpm-only,禁 npm / yarn / bun(lockfile 防漂移) | — |
| 跨文件改动 | 先符号 / 引用链确认再动手;grep 同名只定位候选,禁凭同名盲改 | — |
| 模块结构 | 4 文件基线平铺 `src/modules/`;禁嵌套子目录 / `*.entity.ts` / 跨模块 util grab-bag;已解锁例外见边界文档 | [naming-dto-validation](docs/reference/naming-dto-validation.md) · [architecture-boundary](docs/architecture-boundary.md) |
| 命名 | `passwordHash` / `key` / `createdAt` / cuid 主键;enum 从 `@prisma/client` 导入;username / email 入库查询前 trim + lowercase | [naming-dto-validation](docs/reference/naming-dto-validation.md) |
| 响应格式 | 一律 `{code,message,data}` 包装,业务只 return data;分页固定 DTO,禁 limit/offset/cursor;Swagger 路径不包装 | [response-pagination-errors](docs/reference/response-pagination-errors.md) |
| 错误码 | `BizCode` 三字段 `as const` 集中一处;段位锁死(每模块 200 号段);禁自创 token 类 100xx;新码先说明场景 | [response-pagination-errors](docs/reference/response-pagination-errors.md) |
| Swagger | 100% 覆盖;分页必用 `@ApiWrappedPageResponse`;禁裸 `@ApiOkResponse` | [swagger](docs/reference/swagger.md) |
| 校验 | 全局 ValidationPipe(whitelist + forbidNonWhitelisted + transform);禁局部重复;DTO 白名单是第一道防线;`:id` 一律 `IdParamDto` | [naming-dto-validation](docs/reference/naming-dto-validation.md) |
| 鉴权 | Guard 全局注册禁 `@UseGuards`;`@Public` 与 `@Roles` 互斥;判权单轨见 §2;JwtPayload 仅 `{sub,username}`;身份有效性每请求查库不缓存 | [auth-jwt-refresh](docs/reference/auth-jwt-refresh.md) |
| 密码 / token | `passwordHash` 永不出响应;bcrypt 落库;refresh token 行为冻结(§2 P0-E) | [auth-jwt-refresh](docs/reference/auth-jwt-refresh.md) |
| 软删除 | 禁 `delete()` / 全局软删中间件;`notDeletedWhere` 统一过滤;唯一性预检查用 `findUnique`(含软删);详情用 `findFirst` | [soft-delete-transactions](docs/reference/soft-delete-transactions.md) |
| 事务 | 多写 / 先查后写 / 管理员保护操作必 `$transaction`;计数守护类不变式必须同事务 | [soft-delete-transactions](docs/reference/soft-delete-transactions.md) |
| 角色保护 | 三层 Role 不是 RBAC;`assertCanManageUser` 统一入口;自我保护 + 最后 SUPER_ADMIN 事务内计数;禁加 SA 互斥 | [roles-admin-protection](docs/reference/roles-admin-protection.md) |
| 配置归属 | env 归 `*.config.ts` 注入,禁散落 `process.env`(seed `SUPER_ADMIN_*` 唯一例外);业务判断只用 `APP_ENV`;production fail-fast 禁默认值兜底 | [config-env](docs/reference/config-env.md) |
| DTO 边界 | App DTO 禁从 Admin DTO 派生(extends / Pick / Omit / …Type);出参 DTO 与 safeSelect 同步维护;Prisma 类型不出 service | [naming-dto-validation](docs/reference/naming-dto-validation.md) + §2 D-6 |
| API surface | 新 endpoint 只落 `admin/v1` · `app/v1` · `auth/v1` · `system/v1` · `open/v1`;禁新增 Mixed Controller;App 永不返回 L3 字段 | [api-surface-policy](docs/api-surface-policy.md) |
| 测试纪律 | 新 e2e 复用 `test/{setup,fixtures,helpers}`;错误断言同核 HTTP status 与 BizCode;改 service 编排先跑 characterization,行为差异 = 停下报告;禁删测试 / 放宽断言 | [testing-discipline](docs/reference/testing-discipline.md) |
| snapshot SOP | contract snapshot 仅随拍板范围内接口 PR 更新,diff 逐行可解释;EXPECTED_ROUTES 增删显式登记;禁盲 `-u`;L3 字段出现 = 拒 | [testing-discipline](docs/reference/testing-discipline.md) |
| 受影响范围 | 改哪个模块跑哪组 e2e + 横切组;动依赖枢纽(permissions / audit-logs / `common/*`)或全局横切 → 先列引用链、直接 `agent:check:full` | [process §3/§4](docs/process.md) |
| 机器守护 | `docs:counts:check` / `docs:readtax:check` / `docs:codemap:check` / `docs:rbacmap:check`;派生文档**无守护不留** | [process §6](docs/process.md) |
| git 安全 | 禁 `reset --hard` / `push --force` / 批量 `-D` / `remove --force` / 动 unrelated worktree(会话内二次授权才可);squash 清理走 patch-equivalence 五项 | [process §5.4](docs/process.md) |
| 协作纪律 | 授权清单内连续推进,清单外停;必须输出"本次未做";判断给证据(路径:行号);审计发现不顺手修;不输出 secret;不确定不写成事实 | [process §7](docs/process.md) |

---

## 2. 决策锁与行为冻结(重开任一条前,必须先暂停声明本节存在)

| 锁 | 内容(一句话版) | 全文 |
|---|---|---|
| D-1 | `contribution-rules` 归 System surface | [api-client-boundary](docs/reference/api-client-boundary.md) |
| D-5 | App 准入 = `memberId != null ∧ User.ACTIVE ∧ Member.ACTIVE`;capabilities ≠ raw permission code;`/me/*` 与 `/my/*` 物理分离 | 同上 |
| D-6 | App DTO 禁派生自 Admin DTO;Mobile 默认 `scope = self`;L3 字段(passwordHash / \*token\* / secret\* / 完整 signed URL)永不返回 | 同上 |
| D-7 | 六类职责边界(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect)boundary-aware | [architecture-boundary](docs/architecture-boundary.md) |
| D-9 | Route B 终态 = 5 canonical 前缀,老前缀已物理删除,contract 断言锁定(取代 D-2;D-3 / D-4 / D-8 为已履行的设计期流程锁) | [api-client-boundary](docs/reference/api-client-boundary.md) |
| P0-E | refresh token 冻结:opaque random + sha256 入库;rotation always / family revoke / 90d absolute 不延期;失败统一 10007 不细分;logout 幂等无限流;access 15m 自然过期不主动吊销;联动撤销五场景同事务;`LoginDto` / `LoginResponseDto` / `JwtPayload` zero drift | [auth-jwt-refresh](docs/reference/auth-jwt-refresh.md) |
| 判权单轨 | 全仓活跃 `@Roles` = 0;业务判权 Service 层 `rbac.can()`(SA 短路,拒权 30100);participation 三模块已切 authz(GLOBAL 语义逐字等价);`RolesGuard` 保留兜底不删;scope 不进权限码;`RbacService` 只读 GLOBAL | [auth-jwt-refresh](docs/reference/auth-jwt-refresh.md) |
| 防枚举 | 登录失败四场景统一 10004 + dummy bcrypt 抗 timing;SMS / 微信绑定沿 24010 泛化 200;refresh 失败不细分;任何 message / 错误码 / 耗时差异都算枚举漏洞 | 同上 |
| 身份不缓存 | `JwtStrategy.validate` 每请求查库(`deletedAt = null ∧ ACTIVE`);唯一例外 = `RbacCacheService`(权限解析缓存:TTL 注入 / 三档失效 / 保守降级) | 同上 |
| 永久铁律 | 不引入 `LocalStrategy`;不建 `*.entity.ts`;不用 Prisma 全局软删中间件 / client extension | — |
| 基础设施冻结 | cron 全仓终态**恰好 2 个**,第 3 个起 = 新 D 档评审;Redis / queue / LLM / vector / 多租户不引入(评审解锁制,触发条件见 ARCHITECTURE §9);数据清理走手动 SOP 不上 cron | [current-state §3](docs/current-state.md) |
| 敏感字段三问 | 入 schema / DTO / 草案前必答:业务用途?查看角色与掩码?保存期限与退队清理?"先占位以后再用"视作越权;不假设合规方案;字典真实内容私下提供不进公共仓库 | [api-client-boundary](docs/reference/api-client-boundary.md) §18.4 |
| 业务行为冻结 | 由各冻结评审稿 + e2e 行为锁承载(`docs/archive/reviews/`);**改既有断言 = 改行为契约 → 停下报告** | — |

---

## 3. 红区与触发即停(不可逆项;动手前按 process §4.1 人话简报拍板)

**读写分区**:

- 🟢 自由区:docs(权威源外)/ `test/**` 新增 / ai-harness 目录 true-up
- 🟡 谨慎区:`src/**` / 配置 / snapshot / 工具链 —— 按 process §3 定档;C 档 goal 内免二次确认
- 🔴 红区:非用户授权不动,清单如下

**红区精确清单**:六大红区文档(§0)+ `.github/workflows/**` + `prisma/{schema.prisma, migrations/**, seed.ts}` + `src/common/{guards,filters,interceptors}/**` + `src/modules/auth/**`(P0-E 冻结)+ `src/modules/storage/storage-crypto.service.ts` + `docs/archive/**` + 已发布 CHANGELOG 段。

**触发即停**(拍板才动;goal 已含范围的 C 档免二次确认):

1. schema / migration / seed
2. Role / 权限码 / 绑定 / Guard 语义
3. 登录 / JWT / refresh / throttler
4. Storage / COS / 凭证
5. audit_logs / AuditLogEvent(A-1 不可改删)
6. 新 endpoint · DTO 字段 · BizCode(snapshot diff 逐行解释进 PR)
7. workflows / 依赖 / Dockerfile
8. 全局 Guard · Interceptor · Filter · Pipe
9. 跨模块重构 / 拆 service(characterization 先行)
10. release / tag(E 档强串行)
11. 物理删数据 / 批量回填
12. 敏感字段(三问先答)
13. 红区文档 / archive / 已发布 CHANGELOG
14. 危险 git 操作(§1 git 安全行;会话内二次授权)

`prisma migrate dev|reset|db push` 任何环境**禁自动跑**(reset 恒需用户实时同意,goal 预授权不算);生产只 `prisma migrate deploy` 已审查 migration。

---

## 4. lane 并行协议(摘要;全文 [process §8](docs/process.md))

- **总控**(与维护者对话的会话):出 goal;按**写集声明**排班(写集相交或同 bounded context → 不并行);持 migration token(schema lane ≤1);串行集成(rebase → snapshot 复核 → `agent:check:full` → diff 白名单核对 → squash 合并 → 通知其余 lane rebase);独占 E 档与 CHANGELOG 归并;**唯一简报流**;不写业务代码。
- **执行 lane**(≤3 条):一 lane = 一可见会话窗口 + 一 worktree + 一 PR,**写者唯一**;B/C 档 goal 内自治,D 档新发现上报总控不顺手修;CHANGELOG 走 `changelog.d/` fragment;开工 `pnpm agent:preflight --lane`;e2e 库自动派生 `app_test_<worktree>`。
- **跨模型互查**:写与查跨模型(Claude 写 → Codex 查,反之亦然;SOP 见 [`codex-review-sop`](docs/ai-harness/codex-review-sop.md));分歧不内部调和,升级进简报。
- **goal = 立项 + 授权**,五要素:DoD / 探针队列 / 授权清单 / 禁止域 / 写集声明。**E 档收口必须 global preflight**(全仓 0 open PR)。

---

## 5. 流程指针

PR 五档与必跑检查 / D 档六步降速与人话简报格式 / release 九阶段收口 / squash 清理八条 / 收尾报告(含"本次未做")→ 全部在 [`docs/process.md`](docs/process.md)。

**C 档及以上 feature 默认以 goal 形态立项**(`srvf-goal-author` 起草)。开工速记:`pnpm agent:preflight` 过 + fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`。

---

## 6. reference 索引与 v1 节号重定向

| 细则 | 何时读 | 承接 v1 |
|---|---|---|
| [naming-dto-validation](docs/reference/naming-dto-validation.md) | 建模块 / 写 DTO / 字段校验 | §2 §3 §7 §11 |
| [response-pagination-errors](docs/reference/response-pagination-errors.md) | 返回结构 / 分页 / 错误码 / P2002 | §4 §5 |
| [swagger](docs/reference/swagger.md) | 写 / 改任何 endpoint 注解 | §6 |
| [auth-jwt-refresh](docs/reference/auth-jwt-refresh.md) | 碰登录 / JWT / 密码 / refresh / throttler | §8 §9 |
| [soft-delete-transactions](docs/reference/soft-delete-transactions.md) | 删除语义 / 事务边界 | §10 §12 |
| [roles-admin-protection](docs/reference/roles-admin-protection.md) | 用户管理 / 角色边界 | §13 |
| [config-env](docs/reference/config-env.md) | 新增 env / 配置 | §14 |
| [testing-discipline](docs/reference/testing-discipline.md) | 写测试 / 动 snapshot | §16 |
| [api-client-boundary](docs/reference/api-client-boundary.md) | surface / App DTO / 决策锁全文 | §18 §19 §21 |

v1 其余节去向:§0 / §1 → 本文件 §0 / §2 / §3 + [current-state §3](docs/current-state.md);§15 / §17(历史归档节)→ [archive/legacy](docs/archive/legacy/agents-historical-design-period.md);§20 git 安全 → 本文件 §1 表 + process §5.4。v1 全文:[archive/harness-v1/AGENTS.md](docs/archive/harness-v1/AGENTS.md)。
