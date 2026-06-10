# srvf-nest-api AI Harness Review 总报告

> **快照性质**:本报告是 2026-06-10 全仓系统性 Review 的冻结产物(HEAD `18229ed`,v0.15.0 post-release),合入后**不回改**;后续事实变化以 [`docs/current-state.md`](../current-state.md) 为准。
> 审查方法:5 路并行静态扫描(模块架构 / Prisma / RBAC / 测试 / API-Swagger)+ 关键数字逐项人工复核 + 本地门禁实测。所有结论附证据;本地未能执行的检查显式标注。

---

## 1. 总体判断

**本项目已经适合 AI Agent 持续开发,且成熟度显著高于一般仓库——它缺的不是"建底座",而是把已有底座的最后四块缺口(读写分区地图、RBAC 对照表、测试矩阵、人工确认点单页)补齐并接线**;本次 Review 已随 PR 补齐(`docs/ai-harness/` 9 文档 + 3 模板)。

支撑证据:权威源分层 + 冲突判定制度已成文(AGENTS.md 21 节 / current-state.md / process.md PR 五档);门禁与检查已脚本化(`agent:preflight`、`agent:check:{quick,api,full}`、`docs:codemap:check`,本次实测可用);接口契约由 148 条路由白名单 + ~36k 行 OpenAPI snapshot + "Route B 四前缀终态"断言锁定;行为护栏有 72 e2e suites / 1664 tests + 6 个 god/large-service characterization spec;5 个 `.claude/skills/srvf-*` 已覆盖最高危的任务剧本。

## 2. 当前仓库现状

### 2.1 结构(详 [`CODEMAP.md`](./CODEMAP.md))
根目录 6 大文档(AGENTS / ARCHITECTURE / CLAUDE / CODEMAP / CHANGELOG / TASKS)+ `docs/`(active 文档 + `archive/**` 冻结历史)+ `src/`(bootstrap / common / config / database / modules)+ `prisma/`(schema + 12 migrations + seed)+ `test/`(unit/e2e/contract 三套 jest)+ `scripts/`(preflight + codemap check)+ `.claude/skills/`(5 个项目 skill)+ `.github/workflows/`(ci + docker-smoke)。结构清晰,文档治理已在 v0.15.0 周期完成收口(49 份历史档案归档)。

### 2.2 模块(详 [`MODULE_MAP.md`](./MODULE_MAP.md))
19 个业务模块平铺(`ai/` 为占位)+ `common/storage` 事实模块,合计 32 个 controller class,~43.5k 行业务源码。依赖关系健康:**无循环依赖**,横向业务依赖仅 `activity-registrations → activities`;枢纽为 PermissionsModule(RbacService,扇入 9)与 AuditLogsModule(扇入 ~10)。3 个 god-service(attendances 1157L / attachments 827L / activity-registrations 750L)+ 3 个 large(607/556/544L),state-machine / audit-recorder / calculator / time-policy 等职责类已按 architecture-boundary 抽离,拆分本身刻意挂起待立项。未发现绕过 DI、controller 直连 Prisma(health 探针除外)、死代码或命名违例。

### 2.3 数据模型
25 model / 12 enum,主键 100% cuid,字段 camelCase + 表名 snake_case 统一。软删除覆盖一致(Permission / Attachment / RolePermission / UserRole 四表硬删均有成文决议注释);3 处 partial unique 以手工 SQL 落地(Prisma DSL 限制,有注释可溯);高频过滤字段索引覆盖完整;onDelete Cascade 仅限 RBAC 自身关联表(软删主导使其实际不触发);敏感字段(passwordHash / documentNumber / tokenHash / secret*Encrypted)全部 hash/加密/掩码设计在位。12 个 migration 历史干净,无临时字段。seed 完全幂等(39 处 upsert),创建 SUPER_ADMIN + 76 条 Permission + ops-admin(绑 54 条)+ member 占位角色。

### 2.4 权限(详 [`RBAC_MAP.md`](./RBAC_MAP.md))
双轨迁移中期、边界清晰:管理面/配置面/System 已收紧为 Service 层 `rbac.can()`(P0-F);7 个业务模块(48 处 `@Roles`)按既定决议挂起(Slow-4 等 Slow-3 业务决议);App surface 15 endpoint 走 self-scope。**无 `@Permissions` 装饰器**(确认不存在,判权唯一入口 `RbacService.can()`);全仓 0 处 `@UseGuards`、0 处 service 散落 `role ===` 比较;seed 权限码与代码调用双向对齐(无孤码)。保护不变式(最后 SUPER_ADMIN / 最后 ops-admin / 自我保护 / 防枚举 timing 防御)实现与铁律一致。

### 2.5 测试(详 [`TEST_MATRIX.md`](./TEST_MATRIX.md))
三套 jest 配置职责分明;e2e 串行 + TRUNCATE 级隔离 + `app_test` 子串护栏,无并行污染、无真 sleep、无全局 seed 依赖;异常路径/权限边界/状态机/审计 characterization 覆盖系统化(非 happy-path-only);contract 测试以 148 条路由白名单 + schema 白名单 + 终态前缀断言充当"接口防漂移锁"。CI 全链(lint→typecheck→build→unit→contract→e2e→docker-smoke)可直接作为 AI 的自动验收反馈。

### 2.6 API / Swagger
4 前缀终态(admin 70 / system 59 / app 15 / auth 4 = 148 路由),零 v2 / 零裸前缀 / 零 legacy;`@ApiOperation` 全覆盖,151 处 wrapped 响应装饰器,零裸 `@ApiOkResponse`;App DTO 物理隔离零派生违规;~125 个 BizCode 段位有序;417 处 BizException,业务代码零裸 HttpException。仅存 2 处冻结的 Mixed 形态(rbac `me/permissions` 方法级、dictionaries 同文件双 class)。

### 2.7 文档
权威源分层制度本身就是本仓库最大的 AI 友好资产;发现 1 处漂移(testing.md 引用已删除 spec,见 §3 P2)。

## 3. 关键风险

### P0(不解决会阻碍 AI Harness 落地)——均已在本次 PR 内缓解
| # | 风险 | 缓解 |
|---|---|---|
| P0-a | **RBAC 双轨中间态是 AI 最大误判源**:AI 容易"好心"给 7 个 @Roles 模块补 `rbac.can()`(= 越权启动 Slow-4),或反向把已收紧模块当缺权限 | [`RBAC_MAP.md`](./RBAC_MAP.md) 对照表 + §6 硬规则 |
| P0-b | 全仓读写分区(红区清单)散落多文档,AI 需要拼装才能知道"哪里不能动" | [`CODEMAP.md §2`](./CODEMAP.md) 单页化 |
| P0-c | e2e/contract 强依赖本地 Docker PostgreSQL,无 Docker 环境的 AI 会误判"测试失败"或谎报全绿 | [`TEST_MATRIX §1`](./TEST_MATRIX.md) 环境前置 + 降级路径成文 |

### P1(影响长期维护)
1. 业务面 RBAC 接入挂起(Slow-4 ⇐ Slow-3 业务决议)——工程侧无动作,人工确认点(NEXT_TASKS P1-3)。
2. 3 个 god-service 拆分待逐个立项(护栏 characterization 已全覆盖,条件成熟)(P1-4)。
3. 本次新增的地图是手工快照,会漂移——提案 `check-rbac-map` 脚本固化(P1-1)。
4. `docs/testing.md` 漂移(引用已删 spec)(P1-2)。
5. 部门级权限(`finalReviewerUserId` 终审矩阵)字段在、语义与 e2e 缺——是否属当前业务范围**不确定**(P1-5)。

### P2(可优化)
`member-profiles.dto.ts` 769L enum 混杂(P2-1);Swagger 权限要求无机读格式(P2-2);分页换算两行式重复(P2-3,不建议主动收敛);`common/storage` 超语义(P2-4,current-state 已记 P3);contract snapshot 1MB 单文件(P2-5,已接受)。

## 4. AI Harness 底座设计

详 [`AI_HARNESS_DESIGN.md`](./AI_HARNESS_DESIGN.md)。要点:**复用优先**——规则面(AGENTS/process/current-state)与执行面(skills + agent:check:* + CI)已存在,新增层只做"索引 + 补缺";**否决**新建 `.ai/` 平行树(goals/checks 职能已由 `.claude/skills/` 承载,memory 长期态已有权威承载,避免双源漂移);11 类任务 × 档位 × 检查矩阵成文;8 步反馈闭环(门禁→定位→定档→实施→检查→修复≤2 轮→报告→确认点停机)。

## 5. 模块地图

见 [`MODULE_MAP.md`](./MODULE_MAP.md)(模块 × 前缀 × 鉴权模式 × 依赖 × e2e spec × 风险级 全表 + 依赖枢纽图 + AI 改造分区)。

## 6. RBAC 地图

见 [`RBAC_MAP.md`](./RBAC_MAP.md)(双轨现状、32 controller 鉴权对照、76 权限码全集、保护不变式、缺口与冻结存量、AI 硬规则、重新生成口径)。

## 7. 测试矩阵

见 [`TEST_MATRIX.md`](./TEST_MATRIX.md)(实测命令清单、档位 × 必跑、模块 × spec、高风险最低测试集、e2e 复用清单、snapshot SOP)。

## 8. AI Agent 工作规则

见 [`PROJECT_RULES.md`](./PROJECT_RULES.md)(铁律索引 + 修改权限三档:允许自动 / 谨慎(C/D 档拍板) / 禁止自动)与 [`HUMAN_REVIEW_RULES.md`](./HUMAN_REVIEW_RULES.md)(14 个触发即停 + 暂不启动清单 + 发现类暂停 + 确认请求格式)。

## 9. 建议新增文件

| 路径 | 用途 | 优先级 | 状态 |
|---|---|---|---|
| `docs/ai-harness/`(9 文档 + `templates/`×3) | harness 操作层 | P0 | ✅ 本 PR 创建 |
| `docs/README.md §1` 登记行 | 入口可发现性(docs/README §5 规则要求) | P0 | ✅ 本 PR 修改 |
| 根 `CLAUDE.md` 或 `AGENTS.md` 指向行 | 入口接线 | P0 | ⏸ 需用户授权(二者非授权不动) |
| `scripts/check-rbac-map.ts` + script | 地图防漂移 | P1 | 提案(NEXT_TASKS P1-1) |
| 新任务剧本(如需) | 以 `.claude/skills/srvf-*` 形式新增 | 按需 | 规则成文于 AI_HARNESS_DESIGN §1.3 |

**不建议新增**:`.ai/` 目录树(理由见 AI_HARNESS_DESIGN §1.3);模块级 CLAUDE.md 的大规模补全(现有 7 个覆盖了全部高危模块,其余模块结构简单,根 CODEMAP 行内即可;按需逐个加,避免文档面积无谓扩大)。

## 10. 下一步任务拆解

见 [`NEXT_TASKS.md`](./NEXT_TASKS.md):P0×3(本 PR / 入口接线授权 / CI 补验)、P1×5(rbac-map 脚本、testing.md true-up、Slow-4 挂起、god-service 拆分、部门权限确认)、P2×5。每项含目标 / 范围 / 验收 / 风险 / 人工确认标记。

## 11. 本次 Review 的不确定项(全部需要人工确认)

1. **入口接线**(P0-2):是否在根 `CLAUDE.md` §1 表 / `AGENTS.md` 权威源表追加 `docs/ai-harness/` 一行——两文件均"非用户授权不动"。
2. **Slow-3 / Slow-4 启动时机**(P1-3):业务方对 ADMIN 内置角色边界的决议进度,工程侧无法推断。
3. **部门级权限语义**(P1-5):`finalReviewerUserId` 是否需要部长/副部长细粒度权限与专项 e2e,属业务范围问题。
4. **本目录维护协议采纳**:README §2 的"AI 可自动更新"矩阵与 release 收口时 true-up 的安排,是提案,以维护者合入本 PR 视为采纳。
5. **本地未验证项**:`pnpm test:contract` / `pnpm test:e2e` / `agent:check:{api,full}` 本次因本机 Docker daemon(OrbStack)未运行而未执行(错误:`failed to connect to the docker API at unix:///…orbstack…/docker.sock`);**由本 PR 的 CI 验证**(CI 含全量)。本地已实测通过:`agent:preflight` / `agent:check:quick`(lint + typecheck + unit)/ `docs:codemap:check`(0 FAIL)。
6. **数字口径**:权限码 76 = 75 条 `code: '…'` 字面量 + 1 条常量声明(`PR_3B_USER_UPDATE_ROLE_CODE`,seed.ts:819);路由 148 以 `EXPECTED_ROUTES` 解析为准(此前会话中两个扫描代理分别报 167/172,均不准确,已人工复核纠正)。

## 12. 最终建议(最小可行落地路径)

1. **本 PR(A 档,docs-only)合入** → harness 操作层即生效,AI 可按 `agent:preflight → 地图定位 → 档位矩阵 → check:{quick|api|full} → process §8 报告` 闭环工作。
2. **用户拍板 P0-2**(一行入口接线,5 分钟)→ 以 CLAUDE.md 为入口的会话可发现本层。
3. **下一个工程 PR 做 P1-1**(check-rbac-map 脚本)→ 地图获得与 CODEMAP 同级的防漂移能力。
4. **P1-2 顺手归入任意 A 档 docs true-up**。
5. 其余(Slow-4 / god-service / 部门权限)维持挂起,等业务/维护者按 NEXT_TASKS 逐个立项——**不要并行多开**(沿 process §7 单 PR 节奏)。
