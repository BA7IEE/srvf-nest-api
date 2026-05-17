# SRVF API 当前状态入口

> 本文件是 AI / Claude Code / 维护者进入仓库后的**第一入口**。
> 本文件只记录"当前状态",历史过程请看 [`docs/handoff/`](handoff/) 与 [`CHANGELOG.md`](../CHANGELOG.md)。
> 每次 release / handoff / release 后回填后,**必须**优先更新本文件。冲突时本文件代表"当前事实",架构铁律仍以 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 为准。

---

## 1. 当前版本状态

| 项 | 当前值 |
|---|---|
| 当前版本 | **v0.12.0** |
| `package.json#version` | `0.12.0` |
| Swagger `setVersion(...)` | `0.12.0` |
| 最新 git tag | `v0.12.0`(2026-05-16T09:10:47Z) |
| GitHub Latest Release | `v0.12.0`(标 Latest) |
| `main` HEAD | `f516ae8` `docs(first-release): add bootstrap SOP (#113)` |
| open PR | **0** |
| 工作树状态 | clean |
| 最新 handoff | [`docs/handoff/v0.12.0.md`](handoff/v0.12.0.md)(历史快照,不回改) |

> **复核命令**(任何会话开工前都可以一行跑完):
>
> ```bash
> git rev-parse --short HEAD && \
> grep '"version"' package.json && \
> grep 'setVersion' src/bootstrap/apply-swagger.ts && \
> gh pr list --state open && \
> gh release list --limit 1 && \
> git status --short
> ```

---

## 2. 当前系统已具备能力

> 仅做"清单级"罗列,字段 / 接口 / 错误码细节请回到 [`docs/v2-api-contract.md`](v2-api-contract.md) 与 [`CHANGELOG.md`](../CHANGELOG.md)。

- **v1 基础能力**:NestJS + Prisma + PostgreSQL + JWT 登录 + 三层 `Role` + 用户 CRUD + 软删除 + 统一返回格式 + Swagger 100%(沿 [ARCHITECTURE.md §1-§10](../ARCHITECTURE.md))
- **V1.1 工程加固**:`nestjs-pino` 结构化日志 + 请求 ID + helmet + 登录限流 + 健康检查分层 + 优雅关闭 + Dockerfile 多阶段 + GitHub Actions CI(沿 [ARCHITECTURE.md §11](../ARCHITECTURE.md))
- **V2 数据底座**:`dictionaries`(双表 + 父子树)/ `organizations`(树)/ `members`(全局 `memberNo` 不复用)/ `member_departments`(一人一部门 partial unique)
- **V2 批次 1**:`member_profiles`(1:1 子资源,含敏感字段)/ `emergency_contacts`(N:1 子资源)
- **V2 批次 2**:`certificates`(N:1 + 4 态闭集 + verify/reject)
- **V2 批次 3A**:`activities`(状态机 4 态)/ `activity_registrations`(4 态 + partial unique + CSV export)
- **V2 批次 3B / 4-A / 4-B**:`attendance_sheets`(5 态;含终审)/ `attendance_records` / `contribution_rules`(D14 预填规则;无 CRUD 流水表)
- **V2 批次 6**:`audit_logs` 写入即不可改不可删(A-1 红线);第二波 17 项 `AuditLogEvent` 已全部接入业务写路径
- **V2.x C-6 RBAC**:`RbacRole` / `Permission` / `RolePermission` / `UserRole` 4 表 + `RbacService.can()` + 14 条 `rbac.*` 权限点 + `ops-admin` 内置角色 + bootstrap user_role
- **V2.x C-7 attachments**:多态附件主模块(`@unique` key 已加)+ 配置三表(type / mime / size)+ 业务级 `rbac.can()` 首批接入(目前唯一)
- **V2.x C-7.5 storage**:`StorageSettings` singleton + `LocalStorageProvider` + `CosStorageProvider` + 动态 Router + AES-256-GCM 凭证加密 + 后台 admin API + production fail-fast hook + `APP_ENV=smoke` 专用 CI 形态
- **测试与契约**:Unit 13 spec / Contract OpenAPI snapshot zero drift(单文件 958 KB)/ E2E 51 spec;`ci.yml` 全套 + `docker-smoke.yml` 真实启动回归

---

## 3. 当前明确未做 / 暂不启动

> 这些事项**不**由 AI 自行启动,需要用户拍板。

- **不**自动启动 Slow-3(ADMIN 内置角色 / ADMIN 默认附件权限边界)— 等业务方对"业务管理员边界"补充澄清
- **不**自动启动 Slow-4(14 RBAC CRUD + 79 V2 接口全面接入 `rbac.can()`)— 强依赖 Slow-3 决议
- **不**自动启动 Slow-5(B8 入队同意书正文 / Q8 退队清理 N 值)— 等业务方提供
- **不**自动启动 Slow-7(uploadToken 重放黑名单 / 失败回滚 Provider 文件 / test-connection / multipart / STS / 跨 Provider 迁移)— 等真实使用反馈
- **不**自动启动 L-3(Storage Settings 配置变更 audit_logs)— 等用户授权
- **不**自动启动 `events` / `event_participants` / `member_profiles 扩展敏感字段` 等延后模型(沿 [`docs/V2红线与复活路径.md §4.3`](V2红线与复活路径.md))
- **不**自动引入 LLM / vector / Redis / queue / cron(沿 [ARCHITECTURE.md §9](../ARCHITECTURE.md) 升级路径)
- **不**自动启动新 schema / migration / Permission seed / Role 扩展(A-3 / A-4 红线)
- **不**自动接入运维侧真实 COS(bucket / IAM / CORS / lifecycle / SSE-COS / 真实凭证录入)— 由队组织运维侧执行,系统侧 SOP 见 [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
- **不**自动回改历史 handoff(沿 [`docs/V2红线与复活路径.md §5.1`](V2红线与复活路径.md))
- **不**把历史评审稿(`docs/批次*.md`)当作"当前事实"— 它们是各批次冻结时刻的决策依据

---

## 4. 当前最大风险 / 债务

| 等级 | 债务 | 处理建议 |
|---|---|---|
| P0 | 缺少"当前状态入口" | ✅ 本文件已建立;后续每次 release / handoff 合入后必须回填 |
| P0 | handoff 同时承担"历史快照"与"当前事实",内部前后不一致(`v0.12.0` handoff §0 已打 tag、§6/§10/§11 仍写"未打") | handoff 一律视为**历史快照,合入后不回改**;当前事实以本文件为准 |
| P0 | 权限体系双轨并存(Guard `@Roles(...)` + Service `rbac.can()`),只有 `attachments` 一个业务模块真正接入 RBAC | 等用户拍板 Slow-3 后再启动 Slow-4 全面接入 |
| P0 | release 后 docs 回填无明确 checklist | 已沉淀进 [`docs/process.md §5`](process.md) |
| P0 | `FINAL_REPORT.md` 在根目录顶层但内容是 v0.1.3 时代 | 后续单独 docs PR 加段头或归档,**本 PR 不动** |
| P0 | 第一版前端联调包待齐备 | P0-A 起步包(#110)+ P0-G BizCode 翻译表(#111)+ P0-C bootstrap SOP(#113)已落地;P0-B 上传下载闭环验收 / P0-D 改密评审 等仍待立项,前端在齐备前不宜大规模铺设业务接入 |
| P1 | docs/ 体系庞大(根 6 大文档 + docs/ 30+ 文件) | 长期逐步归档(`docs/v1.3-plan.md` / `v1.4-prisma7-evaluation.md` / `srvf-foundation-data-model-draft.md` 等老草案) |
| P1 | `docs/V2红线与复活路径.md` 顶部"基线版本 v0.7.0"严重滞后于实际 v0.12.0 | 改为滚动维护或明示最后核对版本 |
| P1 | `TASKS.md` 单文件 1742 行,V1.1 历史与 V2.x 当前混排 | 已加范围说明,长期可拆 |
| P2 | `attendances.service.ts` 1413 行(单文件) | 后续功能变更前评估拆分,本期不动 |
| P2 | Contract snapshot 单文件 958 KB,review 困难 | 接受;PR review 时用 diff 工具看 |
| P3 | `common/storage/` 已承载完整 module + controller(超出原 "common = 跨模块基础设施" 语义) | 长期可迁到 `src/modules/storage/`;本期不动 |

---

## 5. 新任务开工前必须检查

> **门禁**:任何一项不满足,**不开新功能**,先与维护者对齐。

- [ ] `git status --short` 工作树 clean
- [ ] `git branch --show-current` 在期望分支(`main` 或 `claude/*` worktree)
- [ ] `gh pr list --state open` 输出为空(open PR = 0)
- [ ] `package.json#version` 与 Swagger `setVersion(...)` 与最新 tag 三方一致
- [ ] 最新 [`docs/handoff/`](handoff/) 文件存在,且本文件 §1 表已反映该 release
- [ ] [`CHANGELOG.md`](../CHANGELOG.md) `## Unreleased` 段不残留与上次 release 重复的未释放变更
- [ ] 本次任务是否涉及 **D 档**(schema / migration / 权限 / 安全 / 存储 / audit / 不可逆变更);若是,先按 [`docs/process.md §4`](process.md) 降速
- [ ] 本次任务是否需要用户拍板(C / D / E 档);若是,先回到对话等用户确认,**不动代码**

详细流程见 [`docs/process.md §2`](process.md)。

---

## 6. 文档阅读顺序

> 不要一次读完所有文档。按"最少必要"读到能完成当前任务为止。

1. **`docs/current-state.md`**(本文件)— 当前事实
2. **用户当前任务说明** — 决定下一步动作
3. [`README.md`](../README.md) — 项目快速概览 / 路由总览 / 必读文档表
4. [`ARCHITECTURE.md`](../ARCHITECTURE.md) — v1 / V1.1 / V2 §12 完整蓝图(铁律最高优先级)
5. [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) — AI 协作铁律(§1-§18)
6. [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) — V2 基线规范(13 项 A 档)
7. [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) — V2 五档红线(A/B/C/D/E)
8. **仅在相关时**:
   - 对应批次评审稿 `docs/批次*.md`(冻结决议)
   - 历史 handoff `docs/handoff/v*.md`(release 时刻快照)
   - 运行 SOP:[`development.md`](development.md) / [`testing.md`](testing.md) / [`deployment.md`](deployment.md) / [`security.md`](security.md) / [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
   - 第一版联调前置 SOP:[`first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md)(zero-to-login 串行清单;P0-C 落地于 #113)

---

## 7. 冲突处理原则

| 维度 | 权威源 |
|---|---|
| **当前事实**(版本 / open PR / HEAD / 已发能力) | 代码、GitHub 当前状态、本文件(`docs/current-state.md`) |
| **架构铁律**(v1 §1-§16、V1.1 §17、V2 §18) | [`ARCHITECTURE.md`](../ARCHITECTURE.md) > [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) > [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) > [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) > 单批次评审稿 |
| **历史过程**(为什么这么做) | [`docs/handoff/v*.md`](handoff/) + [`CHANGELOG.md`](../CHANGELOG.md) |
| **冻结批次决议**(D6 / D7 / Q-* 等) | 对应 `docs/批次*.md`(冻结后不回改) |

**铁律**:遇到冲突 → **不得擅自调和、不得擅自改文件**,先向用户汇报,等拍板。
