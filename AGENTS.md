# SRVF — AI 协作规则

维护者依靠 AI 长期维护本项目。优先保证稳定、清晰、可维护；用代码检查和行为测试验证结果。
任务授权内连续推进，范围外的问题先报告。已有授权无需重复申请。

## 工作方式

- 阅读本文件；涉及业务或部署现状时读 `docs/current-state.md`，进入模块时读当地 `CLAUDE.md`。
  细则按需读 `docs/reference/`、`docs/api-surface-policy.md` 和相关 `docs/ops/`。
- 先查实际代码、引用链和测试，再改动。当前事实以代码、GitHub 状态和现场证据为准；
  历史文档只作证据。规则与事实冲突时说明冲突，不默默选一边。
- 不要求固定 Goal、PR 分级、lane、开工令牌或台账更新。多任务使用独立工作树，避免交叉改动。
- 不输出密钥、JWT、完整签名 URL 或个人敏感信息。新增敏感字段先明确业务用途、查看角色/掩码、保存期限/退队清理。
- 报告实际改动、验证结果及未完成项；局部通过不能写成全量通过，合并不能写成上线。

## 命令与验证

使用 Node ≥22、pnpm（版本见 `package.json`）。新工作树先 `pnpm install --frozen-lockfile && pnpm prisma:generate`。

| 场景 | 命令 |
|---|---|
| 日常反馈 | `pnpm agent:check:quick`（缓存 lint、类型、单测） |
| 提交前 / 跨文件类型变化 | `pnpm lint && pnpm typecheck`（冷 lint 为权威口径） |
| API 契约变化 | `pnpm agent:check:api`，审阅 snapshot diff，同步 `docs/handoff/` |
| 行为变化 | 相关单测与定向 `pnpm test:e2e <spec名>` |
| 构建 | `pnpm build` |

全量 E2E 留给 PR CI，避免耗尽共享机器。公共依赖变化须覆盖直接受影响模块。
不删除业务测试或放宽断言来获得绿灯；行为契约变化须在授权范围内。修改服务编排先做 characterization。
snapshot 每一处变化都应可解释，不能盲目 `-u`。

## 实现边界与既定决策

- Service 执行业务判权：`rbac.can()` / `authz.can()`；`AuthzDeclarationGuard` 仅校验访问声明，不替代判权。
  活跃 `@Roles` 保持零，`RolesGuard` 保留兜底；`RbacService` 只读 GLOBAL，scope 不编码进权限码。
  身份和权限每请求查库，禁止跨请求缓存、TTL 或 invalidate 正确性链。
- 多写、先查后写和管理员保护使用同一事务；计数守护与写入同事务。锁后重读权限和业务前置。
  软删查询用 `notDeletedWhere`；唯一性预查用 `findUnique`（含软删），详情用 `findFirst`。
- 沿六类职责边界：Presenter / QueryService / Policy / StateMachine / AuditRecorder / Effect。
  Presenter、Policy 不查库。禁止跨模块深引私有实现；不建 `*.entity.ts`、`LocalStrategy` 或 Prisma 全局软删中间件/extension。
- D-1：`contribution-rules` 属 System。D-5：App 准入为 memberId 非空且 User/Member 均 ACTIVE；
  capabilities 不是权限码，`/me/*` 与 `/my/*` 分离。D-6：App DTO 不派生自 Admin，
  L3 默认不返回（content 读面既有例外见 `docs/api-surface-policy.md` §9.6）。
- P0-E：opaque refresh token + sha256；始终 rotation；family revoke；90 天绝对寿命；
  失败统一 10007；logout 幂等且不限流；access 15 分钟自然过期；
  九种联动撤销与主写同事务；三个 DTO zero drift。详见 `docs/reference/auth-jwt-refresh.md`。
- 防枚举：密码登录四场景统一 10004，缺用户也跑 dummy bcrypt；SMS/微信沿 24010 泛化 200；
  refresh 不细分失败。我方可控耗时分支归一，上游耗时仅有界缓解，残余差异为已接受决策，
  仍须 T6 真机验证，不能用 DEV_STUB 代替。
- 基础设施维持两个 cron；不自行新增 Redis、queue、LLM、vector、多租户或自动数据清理。
  既定业务行为及以上决策需维护者明确授权才能重开。

## 人工边界

- 不自动执行 `prisma migrate dev`、`migrate reset`、`db push`，不自动操作生产数据库、
  物理删除数据、批量回填或启用生产 Gate。已审查 migration 的生产 deploy 由维护者执行。
- 不 force push、`reset --hard`、强删分支/工作树或 `rm -rf` 非构建目录，不覆盖他人改动。
- 数据库、鉴权核心与 CI 控制面由 `harness/redzone.json` 定义最小审批范围。
  `Red-zone (trusted)` 只运行 base 上的裁判，维护者在 `harness-review` 审批；AI 不代点。
  本地设置中的危险命令限制是补充，不假定每个 Agent 都支持 hooks。
- 未获授权不合并、发布或部署。发版按 `docs/process.md` 的两段命令执行。

历史规则与台账全文：`git show harness-v3-final:<原路径>`；恢复时只读所需片段，不将旧流程重新作为现行要求。
