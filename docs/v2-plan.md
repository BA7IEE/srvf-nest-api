# V2 第一阶段开发执行计划

> 派生项目:**srvf-nest-api**
> 文档定位:**V2 第一阶段开发执行计划**(D8-2 立项产出物)
> 阶段:**V2-D8 立项中**(2026-05-07)
> 状态:**初稿**,待 D8 立项 5 份产出物全部就位 + 用户拍板才能启动 Step 1
> 依据:`ARCHITECTURE.md §12.8-§12.11`(commit `85cec75`)+ `data-model-draft.md` v0.3 D7-min 决议(commit `4333c31`)+ `TASKS.md` D7-min 同步(commit `281abc0`)+ baseline(commit `16876fe`)

---

## 0. 文档定位

### 0.1 这份文件是什么

- V2 第一阶段开发的**执行级**计划:7 步开发顺序 / 每步范围 / 验收命令 / commit 拆分 / 风险与回退 / v1 兼容性核查清单
- 配合 `docs/v2-data-model.md`(D8-3 待产出)+ `docs/v2-api-contract.md`(D8-4 待产出)+ `TASKS.md §6` 任务卡(D8-5 待产出)使用

### 0.2 这份文件不是什么

- **不是**完整 Prisma schema — schema 实施由 Step 1 任务卡承载
- **不是** migration SQL — migration 由 Step 1 实施期生成
- **不是**完整 API 契约 — 接口契约草案由 `docs/v2-api-contract.md` 承载
- **不是** controller / service / dto 代码 — 由 Step 3-6 实施期编写
- **不是**真实业务数据 — 真实部门名 / 等级名 / 字典内容**不进**本文(沿用 `research.md §7-R13`)
- **不是**已确认开发启动 — V2-D8 标记完成需 5 份立项产出物全部就位(详见 `ARCHITECTURE.md §12.11`)

### 0.3 严守的边界

继承 `ARCHITECTURE.md §12.8.4` 第一阶段绝对禁止清单:

- ❌ 不开发 `member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants` 任一模型
- ❌ 不实装文件上传 Provider / RBAC / Redis / 队列 / 定时任务 / 读审计 / 完整状态机引擎
- ❌ 不引入未登记新依赖
- ❌ 不修改 `docker-compose.yml` / `.github/workflows/ci.yml`(除非 D8 立项后单独评估)
- ❌ 不在本文写 Prisma DSL / migration SQL / 完整 controller class / 真实业务取值

### 0.4 修订纪律

- 修订需用户拍板,**禁止** AI 自行扩张
- 修订 commit message 前缀:`v2-design: v2-plan <章节> <简述>`
- 修订需在附录 B 版本表显式记录

---

## 1. 总览

### 1.1 第一阶段目标

**完成"人员底座闭环"**:字典(neutral-demo 占位)+ 组织树 + 队员主表 + 部门归属。让 V2.x 可以在此基础上扩展业务模块(member_profiles 合规补齐 / events 业务拍板 / audit_logs 第一个增量 等)。

### 1.2 开发范围:4 个模型

由 D7-min 决议锁定(`data-model-draft.md` v0.3 §3.x.10):

| # | 模型 | 关键决策摘要 |
|---|---|---|
| 1 | `dictionaries`(`dict_types` + `dict_items`)| 双表 / `<concept>Code` 字符串引用 / `parentId` 自引用父子树形 / 第一阶段 2 类(节点类别 / 队员等级)|
| 2 | `organizations` | 单根树 / 3 层不写死 / 新增/编辑/停用,不可改父级 / `nodeTypeCode` 走字典 |
| 3 | `members` | 独立 cuid id / **不**复用 `users.id` / `users.memberId` 可空外键 / 主表不挂 `organizationId` / `gradeCode` 走字典 / status 最小集 ACTIVE/INACTIVE / **任何敏感字段禁止** |
| 4 | `member_departments` | 路径 B / 一人一部门 / 独立代理 id / `(memberId)` 唯一(在 `deletedAt = null` 范围内)/ 不引入 isPrimary/joinedAt/endedAt |
| — | v1 `users` 表追加 `memberId` 可空外键 | M-2 决议的不可避免后果 |

### 1.3 延后范围:5 个模型

| # | 模型 | V2.x 复活触发条件 |
|---|---|---|
| 5 | `member_profiles` | 合规依据补齐(详见 `TASKS.md §5.5.4.3`) |
| 6 | `attachments` | profiles / events 解锁 / 用户拍板独立诉求(任一即可) |
| 7 | `audit_logs` | V2.x 第一个增量,接入 V2 第一阶段 4 模型关键写操作 |
| 8 | `events` | 用户拍板需求 → D7-4 评审 |
| 9 | `event_participants` | 跟随 events 复活路径 |

**第一阶段开发期间严禁**触碰以上 5 模型的任何代码 / schema / 测试。

### 1.4 7 步开发顺序

| Step | 内容 | 关键依赖 |
|---|---|---|
| **Step 1** | Prisma schema + migration:4 模型 + `users.memberId` 可空外键 | baseline + v1 schema 不破坏 |
| **Step 2** | seed neutral-demo 字典类型(节点类别 / 队员等级 2 类),**仅占位** | Step 1 完成 |
| **Step 3** | `dictionaries` 模块(`dict_types` + `dict_items` controller / service / dto / e2e) | Step 1-2 完成 |
| **Step 4** | `organizations` 模块(树形 controller / service / dto / e2e) | Step 1-3 完成(依赖字典) |
| **Step 5** | `members` 模块 + v1 `users` 服务侧追加 `memberId` 关系处理 | Step 1-4 完成 |
| **Step 6** | `member_departments` 归属能力(controller / service / dto / e2e + 单归属约束业务规则) | Step 1-5 完成 |
| **Step 7** | E2E 全量回归 + 契约快照更新 + 文档收口(README / CHANGELOG / TASKS.md 收尾) | Step 1-6 全部完成 |

### 1.5 commit 拆分原则

- **每步独立 commit**,**禁止**两步合并(防止回滚粒度变粗)
- **每步内部如交付较大**(例如 Step 3 dictionaries 模块涉及 dict_types + dict_items 双表),允许拆 2-3 个子 commit(prefix `feat: dict_types CRUD` / `feat: dict_items CRUD` / `test: dictionaries e2e`)
- commit message 前缀:
  - `feat:` — 新模块 / 新功能(Step 3-6 主体)
  - `chore: prisma` — Step 1 schema/migration
  - `chore: seed` — Step 2 seed
  - `test: e2e` — 单独测试 commit
  - `docs:` — 文档收口(Step 7)
  - `v2-dev: <step-编号> <简述>` — 通用前缀(类比 v1.1 的 `v1.1: 15.x` 风格)
- **禁止** `--no-verify` / `--amend` / 跳过 hook

---

## 2. 步骤详解

### 2.1 Step 1 — Prisma schema + migration

#### 状态

⏳ 待启动(D8 立项 5 份产出物全部就位 + 用户拍板后启动)

#### 前置条件

- ✅ baseline / data-model-draft v0.3 / D7-min TASKS 同步全部就位
- ✅ ARCHITECTURE.md §12.8-§12.11 开发蓝图(commit `85cec75`)
- ⏳ docs/v2-plan.md(本文)+ docs/v2-data-model.md + docs/v2-api-contract.md + TASKS.md §6 任务卡 全部就位
- ⏳ V2-D8 标记完成

#### 本步范围

按 `docs/v2-data-model.md`(D8-3 产出)实施:

- 新增 4 个 Prisma model:`DictType` / `DictItem` / `Organization` / `Member` / `MemberDepartment`(注:`DictType` + `DictItem` = `dictionaries` 模块的 2 张表)
- 修改 v1 `User` model:追加可空 `memberId` 字段 + 关系到 `Member`
- 生成 migration 文件(命名按现有 `prisma/migrations/` 时间戳风格,例如 `<timestamp>_v2_foundation`)
- 跑 `pnpm prisma:generate` 同步 client 类型
- 跑本地 `pnpm prisma:migrate dev`(开发库)/ CI `pnpm prisma:deploy`(测试库)迁移就位

#### 本步不做

- ❌ 不写任何业务代码(`src/modules/dictionaries/` 等不创建)
- ❌ 不写 seed 业务数据(留给 Step 2)
- ❌ 不修改 `users.service.ts` / `users.dto.ts` / `users.controller.ts`(留给 Step 5)
- ❌ 不实装 5 个延后模型的 schema(member_profiles / attachments / audit_logs / events / event_participants)
- ❌ 不修改 `docker-compose.yml`(数据库容器名 / 端口不变)

#### 交付物

| # | 交付物 | 验证 |
|---|---|---|
| 1 | `prisma/schema.prisma` 改动 | git diff 显示新增 5 model + User 追加 memberId |
| 2 | `prisma/migrations/<timestamp>_v2_foundation/migration.sql` | 文件存在 + 内容仅含 V2 改动(不动 v1 已有表结构) |
| 3 | Prisma client 重新生成 | `node_modules/.prisma/client/` 含新 model 类型 |
| 4 | 本地开发库迁移成功 | `pnpm prisma:migrate dev` 退出码 0 |
| 5 | CI 测试库迁移成功 | `pnpm db:test:reset` 然后 `pnpm prisma:deploy` 退出码 0 |

#### 验收命令

按 baseline §13 A 档(必跑):

```
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e         # v1 既有 19 suites / 162 tests 零退化
pnpm test:contract    # OpenAPI 不变(本步不动 controller),快照应通过
```

B 档(本步涉及 schema 变更,但不动 controller / 全局行为,B 档轻量):

```
pnpm start:dev          # 服务能启动(不报 schema 错误)
curl /api/health/live   # 200
curl /api/health/ready  # 200(DB 连通)
SIGTERM 关停            # 优雅关闭
```

#### 回滚风险

| 风险 | 评估 |
|---|---|
| migration 反向(`pnpm prisma migrate reset`)| **影响 app_dev 库**(本地)+ **app_test 库**(测试);需用户授权(Prisma 安全机制) |
| 数据丢失 | 本步无业务数据 → 风险**极低** |
| v1 表结构破坏 | migration 仅 ADD COLUMN(`users.memberId`)+ 新表;**无** ALTER 既有字段;v1 表结构**完全保留** |
| 回滚操作 | `git revert <commit>` + `pnpm prisma migrate reset`(需用户授权)+ `pnpm prisma:deploy`(回到上一个 migration)|

#### 建议 commit message

```
chore(prisma): add V2 foundation schema (4 models + users.memberId)

V2-D8 第一阶段 Step 1 交付:Prisma schema + migration 就位。

- 新增 5 个 Prisma model(dictionaries 模块拆 2 张):
  - DictType / DictItem(双表字典 + 父子树形)
  - Organization(单根树 + nodeTypeCode 走字典)
  - Member(独立 id + gradeCode 走字典 + status 最小集)
  - MemberDepartment(路径 B + (memberId) 唯一约束在 deletedAt=null)
- v1 User model 追加可空 memberId 字段 + 关系到 Member
  - v1 已有字段 / 索引 / 外键完全保留
  - v1 接口契约不变(UserResponseDto 不新增必返字段)
- 生成 migration 文件 prisma/migrations/<timestamp>_v2_foundation/

按 baseline §10 软删除约定:所有新模型预留 deletedAt 字段
按 baseline §1.1 BizCode 段位:错误码段位预留(本步无 throw)
按 baseline §11 v1 兼容性:零破坏

验收(全过):
- pnpm lint / typecheck / test / test:e2e(v1 162 tests 零退化)
- pnpm test:contract(OpenAPI 不变)
- B 档:start:dev / health/live / health/ready / 优雅关闭

参考:docs/v2-plan.md §2.1 Step 1 / docs/v2-data-model.md
```

---

### 2.2 Step 2 — seed neutral-demo

#### 状态

⏳ 待启动(Step 1 完成后启动)

#### 前置条件

- ✅ Step 1 完成(`prisma:deploy` 通过 / Prisma client 就位)
- ✅ docs/v2-data-model.md 字典类型 / 字段集说明已就位

#### 本步范围

修改 `prisma/seed.ts`,**新增**两类 neutral-demo 字典类型 seed,**不动**已有 SUPER_ADMIN seed 逻辑:

| 字典类型 code | 用途 | seed 内容(neutral-demo) |
|---|---|---|
| `node_type` | 节点类别(`organizations.nodeTypeCode` 引用) | 占位 items(例:`demo-type-1` / `demo-type-2`),**不写**真实部门类别名 |
| `grade` | 队员等级(`members.gradeCode` 引用) | 占位 items(例:`demo-grade-1` / `demo-grade-2`),**不写**真实等级名 |

#### 本步不做

- ❌ 不写真实节点类别名(具体业务上的部门 / 小组 / 编组类别取值 — 由运营在部署后通过运营后台 / 私有 seed 录入)
- ❌ 不写真实等级名(具体业务上的等级 / 资质取值 — 同上)
- ❌ 不预填业务数据(无 seed organizations / members / member_departments 数据)
- ❌ 不修改 SUPER_ADMIN seed 逻辑(`SUPER_ADMIN_*` 环境变量读取 / bcrypt 哈希 / 创建 super admin 等全部不动)
- ❌ 不写 5 延后模型的 seed
- ❌ seed 不强制 SUPER_ADMIN 绑 member(`memberId` 默认 null)

#### 交付物

| # | 交付物 | 验证 |
|---|---|---|
| 1 | `prisma/seed.ts` 改动 | git diff 显示 dict_types + dict_items 写入逻辑追加 |
| 2 | seed 幂等(跑两次结果一致) | 跑两次 `pnpm prisma:seed`,第二次不产生重复 / 不报错 |
| 3 | seed 后字典 items 可查 | `pnpm prisma:studio` / 直接 SQL 查询验证 |

#### 验收命令

A 档:

```
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:contract
```

B 档(seed 改动不影响运行时,仅启动验证):

```
pnpm prisma:seed         # 第一次
pnpm prisma:seed         # 第二次(幂等校验)
pnpm start:dev           # 服务能启动
SIGTERM 关停
```

#### 回滚风险

| 风险 | 评估 |
|---|---|
| seed 数据写错 | 重新跑 `pnpm db:test:reset` + `pnpm prisma:seed` 即可 |
| 真实业务数据被覆盖 | **不可能** — 本步只写 neutral-demo,不读取 / 不修改任何业务数据 |
| 回滚操作 | `git revert <commit>` + `pnpm prisma:seed`(回到上一版 seed 状态) |

#### 建议 commit message

```
chore(seed): add V2 foundation neutral-demo dict seed

V2-D8 第一阶段 Step 2 交付:字典 neutral-demo seed 就位。

- 新增 2 类字典类型 seed(neutral-demo 占位):
  - node_type(节点类别 — organizations.nodeTypeCode 引用)
  - grade(队员等级 — members.gradeCode 引用)
- 真实部门类别名 / 真实等级名不进 seed(沿用 R13 红线)
- 真实取值由运营在部署后通过运营后台 / 私有 seed 录入
- seed 幂等(跑两次结果一致)
- 不动 SUPER_ADMIN seed 逻辑(v1 兼容)

验收(全过):
- pnpm prisma:seed 跑两次幂等
- pnpm lint / typecheck / test / test:e2e / test:contract
- B 档:start:dev 服务正常

参考:docs/v2-plan.md §2.2 Step 2
```

---

### 2.3 Step 3 — dictionaries 模块

#### 状态

⏳ 待启动(Step 1-2 完成后启动)

#### 前置条件

- ✅ Step 1 schema 就位
- ✅ Step 2 字典 seed 就位(2 个 dict_types + 占位 items)
- ✅ docs/v2-api-contract.md §2 dictionaries 接口契约已就位

#### 本步范围

新建 `src/modules/dictionaries/`,4 文件结构:

- `dictionaries.module.ts`
- `dictionaries.controller.ts`
- `dictionaries.service.ts`
- `dictionaries.dto.ts`

实施 dict_types + dict_items 双表 CRUD 接口(按 v2-api-contract.md 锁定):

- `dict_types`:list / detail / create / update / 启停(可能不做软删,沿用 baseline §10)
- `dict_items`:按 type 列表 / detail / create / update / 启停 / 软删
- 父子树形查询能力(items 按 parentId 拼接树形)
- BizCode 段位:`120xx + 121xx`(对齐 baseline §1.1)
- Swagger 100% 覆盖(对齐 baseline §6)
- DTO 白名单(对齐 baseline §4)
- 软删除显式封装(对齐 baseline §10,使用 `notDeletedWhere` helper)
- e2e 测试覆盖(test/e2e/dictionaries.e2e-spec.ts)

#### 本步不做

- ❌ 不写真实字典内容(运营录入,不进代码)
- ❌ 不开发 organizations / members / member_departments 模块(留给 Step 4-6)
- ❌ 不开发 5 延后模型
- ❌ 不接入 audit_logs(audit_logs 已延后)
- ❌ 不实现 dict_items 复杂查询(全文搜索 / 多语言 / metadata 高级查询等)— 仅基础 CRUD
- ❌ 不实现字典缓存(沿用 v1 §1 不主动加缓存)

#### 交付物

| # | 交付物 |
|---|---|
| 1 | 4 文件模块就位(`dictionaries/`) |
| 2 | controller 接口与 v2-api-contract.md 一致 |
| 3 | service 软删除显式封装(用 `notDeletedWhere`) |
| 4 | DTO 白名单纪律(`forbidNonWhitelisted: true` 已全局配置)|
| 5 | Swagger 100% 覆盖 |
| 6 | BizCode 新增条目按段位 `120xx + 121xx` |
| 7 | e2e 用例覆盖典型成功路径 + 错误路径 |
| 8 | OpenAPI 契约快照更新(`pnpm test:contract -u`)|

#### 验收命令

A 档(必跑):

```
pnpm lint
pnpm typecheck
pnpm test                    # 含 dict_types/items 单测(若有)
pnpm test:e2e                # 19 v1 suites + 新 dictionaries suite
pnpm test:contract           # 快照更新后通过
```

B 档(涉及 controller / Swagger,**必跑**):

```
pnpm start:dev
curl /api/docs               # Swagger UI 含 dictionaries 接口
curl /api/docs-json          # OpenAPI JSON 含 dictionaries 路径
spot check 一个 dict_types 列表接口
spot check 错误路径(权限拒绝 / 资源不存在 等)
SIGTERM 关停
```

#### 回滚风险

| 风险 | 评估 |
|---|---|
| 模块代码缺陷 | e2e 失败即捕获;`git revert` 即可 |
| 接口契约破坏 v1 | 不可能 — 新模块路径与 v1 14 接口完全独立 |
| Prisma 类型错误 | typecheck 即捕获 |
| 回滚操作 | `git revert <commit>`,模块整体撤回(schema 不动 — Step 1 已固化)|

#### 建议 commit message

```
feat(dictionaries): add V2 foundation dictionaries module

V2-D8 第一阶段 Step 3 交付:字典模块就位。

- 新建 src/modules/dictionaries/ 4 文件结构
- dict_types CRUD + 启停
- dict_items CRUD + 父子树形 + 启停 + 软删
- BizCode 段位 120xx/121xx(baseline §1.1)
- Swagger 100% 覆盖 + DTO 白名单 + 软删显式封装
- e2e 覆盖典型成功 / 错误路径
- OpenAPI 契约快照更新

红线沿用:
- 真实字典取值不进 seed / 不进代码(R13)
- 不主动加缓存(v1 §1)

验收(全过):
- pnpm lint / typecheck / test / test:e2e / test:contract -u
- B 档:start:dev / Swagger UI / 接口 spot check / SIGTERM

参考:docs/v2-plan.md §2.3 Step 3 / docs/v2-api-contract.md §2
```

---

### 2.4 Step 4 — organizations 模块

#### 状态

⏳ 待启动(Step 1-3 完成后启动)

#### 前置条件

- ✅ Step 1-2 schema + seed 就位
- ✅ Step 3 dictionaries 模块就位(organizations 依赖 nodeTypeCode 字典)

#### 本步范围

新建 `src/modules/organizations/`,4 文件结构。

实施树形 CRUD 接口(按 v2-api-contract.md 锁定):

- list / detail / create / update / 启停 / 软删
- 树形查询(按 parentId 拼接子树)
- **不**支持改父级(严格按 D7-min O-1 决议)
- nodeTypeCode 走字典(联动 §3.1 字典模式)
- 节点撤销:启停 status + 防御性 deletedAt
- BizCode 段位:`110xx + 111xx`
- Swagger 100% 覆盖 + DTO 白名单 + 软删显式封装
- e2e 测试覆盖

#### 本步不做

- ❌ 不支持改父级(D7-min 锁定)
- ❌ 不实施跨部门小组 / 临时编组(D7-min 锁定延后)
- ❌ 不实施节点负责人 / 节点扩展属性(简介 / 联系方式 / 内部编号 等)
- ❌ 不写真实部门名(seed neutral-demo,真实取值由运营录入)
- ❌ 不接入 audit_logs(audit_logs 已延后)

#### 交付物

| # | 交付物 |
|---|---|
| 1 | 4 文件模块就位(`organizations/`) |
| 2 | 树形查询接口能力 |
| 3 | nodeTypeCode 字典 code 校验(创建 / 更新时校验存在性) |
| 4 | 启停 + 软删显式封装 |
| 5 | 错误码段位 `110xx + 111xx` |
| 6 | Swagger 100% 覆盖 |
| 7 | e2e 覆盖典型成功 / 错误路径(含树形查询 / 不可改父级 等) |
| 8 | OpenAPI 契约快照更新 |

#### 验收命令

A 档:同 Step 3。

B 档(涉及 controller,必跑):同 Step 3 + spot check 树形查询接口。

#### 回滚风险

同 Step 3(模块整体可 revert,schema 不动)。

#### 建议 commit message

```
feat(organizations): add V2 foundation organizations module

V2-D8 第一阶段 Step 4 交付:组织树模块就位。

- 新建 src/modules/organizations/ 4 文件结构
- 单根树 / 3 层不写死 / nodeTypeCode 走字典
- 新增 / 编辑 / 停用 / 软删;**不可改父级**(D7-min O-1)
- 树形查询能力(按 parentId 拼接子树)
- BizCode 段位 110xx/111xx
- 跨部门小组 / 临时编组 / 节点负责人 / 扩展属性 全部延后
- 真实部门名不进 seed(R13)

验收(全过):
- pnpm lint / typecheck / test / test:e2e / test:contract -u
- B 档:start:dev / Swagger / 树形查询 spot check / SIGTERM

参考:docs/v2-plan.md §2.4 Step 4 / docs/v2-api-contract.md §3
```

---

### 2.5 Step 5 — members 模块

#### 状态

⏳ 待启动(Step 1-4 完成后启动)

#### 前置条件

- ✅ Step 1-2 schema + seed 就位
- ✅ Step 3 dictionaries 模块就位(members 依赖 gradeCode 字典)
- ✅ Step 4 organizations 模块就位(members 在 Step 6 才挂部门归属,Step 5 暂不挂)

#### 本步范围

新建 `src/modules/members/`,4 文件结构。

实施 members CRUD + v1 users 服务侧 memberId 关系处理:

- members CRUD:list(管理员)/ detail / create / update / 状态切换(ACTIVE↔INACTIVE)/ 软删
- v1 `users.service.ts` 追加 `memberId` 字段处理逻辑(创建 / 更新 / 查询;**不**改 v1 接口契约)
- gradeCode 走字典(联动 §3.1 字典模式)
- BizCode 段位:`150xx + 151xx`
- Swagger 100% 覆盖 + DTO 白名单 + 软删显式封装
- 角色权限:沿用 v1 三层 Role(SUPER_ADMIN / ADMIN / USER)+ Service 层 `assertCanManageMember` 显式校验
- e2e 测试覆盖

#### 本步不做

- ❌ **不开发任何敏感字段**(身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 等;m_profiles 已延后)
- ❌ **不**在 members 主表挂 organizationId(完全走 member_departments,Step 6 实施)
- ❌ **不**在 v1 `UserResponseDto` 出参中**新增必返**字段
  - `memberId` 是否作为可选返回:本步**默认不返回**;若决定可选返回,需在 Step 5 内显式说明并更新 OpenAPI 契约快照
- ❌ **不**修改 v1 `auth.service.ts` / `auth.controller.ts` / `auth.dto.ts`(登录路径不动)
- ❌ **不**修改 v1 `health/` / `bootstrap/` / `database/prisma.service.ts`
- ❌ 不实现资质维度(D5 未触及,延后)

#### 交付物

| # | 交付物 |
|---|---|
| 1 | 4 文件模块就位(`members/`) |
| 2 | v1 `users.service.ts` 追加 memberId 处理(仅服务侧;v1 接口出参不变) |
| 3 | gradeCode 字典 code 校验 |
| 4 | 状态切换 + 软删显式封装 |
| 5 | `assertCanManageMember` Service 层显式校验(沿用 v1 §13 模式) |
| 6 | BizCode 段位 `150xx + 151xx` |
| 7 | Swagger 100% 覆盖 |
| 8 | e2e 覆盖管理员路径 + 角色边界 + v1 接口零退化 |
| 9 | OpenAPI 契约快照更新(仅 V2 新接口;v1 14 接口快照不变) |

#### 验收命令

A 档:同 Step 3,**重点验证 v1 14 接口零退化**。

B 档(涉及 v1 兼容性,**必跑**):

```
pnpm start:dev
curl POST /api/auth/login(v1 登录路径)→ 200,响应不含 memberId
curl GET /api/users/me(v1 用户路径)→ 200,响应不含 memberId(本步默认)
curl GET /api/members(V2 新接口)→ 200(若管理员)/ 403(若 USER)
spot check v1 用户 CRUD 完整路径
SIGTERM 关停
```

#### 回滚风险

| 风险 | 评估 |
|---|---|
| 修改 v1 users.service.ts 引入回归 | e2e + B 档 spot check 即捕获;`git revert` 即可 |
| memberId 关系污染 v1 接口出参 | 严守 §M-2 红线;OpenAPI 契约快照对比即捕获 |
| 回滚操作 | `git revert <commit>`(模块 + v1 users 改动一并撤回) |

#### 建议 commit message

```
feat(members): add V2 foundation members module + v1 users.memberId hook

V2-D8 第一阶段 Step 5 交付:队员模块就位。

- 新建 src/modules/members/ 4 文件结构
- members CRUD + 状态切换(ACTIVE/INACTIVE)+ 软删
- gradeCode 走字典(联动 dictionaries)
- BizCode 段位 150xx/151xx
- assertCanManageMember Service 层显式校验(沿用 v1 §13)

v1 兼容性追加:
- src/modules/users/users.service.ts 追加 memberId 处理
- v1 UserResponseDto 不新增必返字段(默认不返回 memberId)
- v1 14 接口契约 / 路径 / DTO 全部不变(e2e 162 tests 零退化)

红线沿用:
- 任何敏感字段禁止进入(member_profiles 已延后)
- 主表不挂 organizationId(走 member_departments,Step 6 实施)
- v1 auth / health / bootstrap / database 不动

验收(全过):
- pnpm lint / typecheck / test / test:e2e / test:contract -u
- B 档:start:dev / v1 14 接口 spot check / V2 接口 spot check

参考:docs/v2-plan.md §2.5 Step 5 / docs/v2-api-contract.md §4
```

---

### 2.6 Step 6 — member_departments 归属能力

#### 状态

⏳ 待启动(Step 1-5 完成后启动)

#### 前置条件

- ✅ Step 1-5 schema / seed / 字典 / 组织 / 队员模块全部就位
- ✅ docs/v2-api-contract.md §5 部门归属接口契约已就位

#### 本步范围

实施部门归属能力(嵌套在 members 下的子接口 vs 独立模块路径,由 v2-api-contract.md 拍板;**默认嵌套**):

- 队员归属部门:create(给队员关联部门)/ 解除归属(软删中间表行)/ 查询当前归属
- 单归属业务规则:同一 memberId 只能有一行 active(`deletedAt = null`)
- 唯一约束实现:Prisma 部分唯一索引(若支持)/ 否则全局唯一约束 + 业务规则保证
- BizCode 段位:`170xx + 171xx`
- 错误码:`MEMBER_DEPARTMENT_ALREADY_EXISTS`(撞唯一约束)/ `MEMBER_NOT_FOUND` / `ORGANIZATION_NOT_FOUND`
- e2e 测试覆盖典型成功 / 错误路径(含一人一部门约束验证)

#### 本步不做

- ❌ **不**实施一人多部门能力(D7-min MD-6 锁定不做)
- ❌ **不**引入 isPrimary / joinedAt / endedAt / 进出原因 字段(D7-min MD-5 锁定不引入)
- ❌ **不**支持跨部门角色 / 等级独立性(默认全队统一)
- ❌ **不**实施部门变更历史保留(D5 Q18 ② 锁定不保留)
- ❌ **不**接入 audit_logs(audit_logs 已延后)

#### 交付物

| # | 交付物 |
|---|---|
| 1 | 部门归属接口实施(嵌套或独立,由 v2-api-contract.md 锁定) |
| 2 | 单归属唯一约束业务规则 |
| 3 | 软删时旧记录由 deletedAt 区分,新归属不撞约束 |
| 4 | BizCode 段位 `170xx + 171xx` |
| 5 | Swagger 100% 覆盖 |
| 6 | e2e 覆盖一人一部门 / 一人不能挂两个部门 / 软删后可重新归属 等 |
| 7 | OpenAPI 契约快照更新 |

#### 验收命令

A 档:同 Step 3。

B 档:同 Step 3 + 一人一部门约束 spot check(尝试给同一人挂两个部门 → 应失败)。

#### 回滚风险

| 风险 | 评估 |
|---|---|
| 唯一约束冲突 | Prisma 部分唯一索引若不支持需降级,降级方案在 schema migration 已设计;Step 6 内部应有备用路径 |
| 历史 / 变更被误处理 | D7-min 锁定"不保留历史",Step 6 不做历史 → 风险**极低** |
| 回滚操作 | `git revert <commit>` |

#### 建议 commit message

```
feat(member-departments): add V2 foundation member-departments capability

V2-D8 第一阶段 Step 6 交付:队员部门归属能力就位。

- 路径 B(中间表保留 + 单归属约束)实施
- 一人一部门唯一约束:(memberId) 在 deletedAt=null 范围内唯一
- 部门归属接口(嵌套在 members 或独立模块,见 v2-api-contract.md §5)
- BizCode 段位 170xx/171xx
- 错误码:MEMBER_DEPARTMENT_ALREADY_EXISTS / MEMBER_NOT_FOUND /
  ORGANIZATION_NOT_FOUND
- e2e 覆盖一人一部门约束 / 软删后重新归属 / 跨实体引用

红线沿用:
- 一人多部门能力不做(MD-6)
- 不引入 isPrimary / joinedAt / endedAt / 进出原因(MD-5)
- 不做部门变更历史(D5 Q18 ②)
- audit_logs 不接入(已延后)

验收(全过):
- pnpm lint / typecheck / test / test:e2e / test:contract -u
- B 档:一人一部门约束 spot check

参考:docs/v2-plan.md §2.6 Step 6 / docs/v2-api-contract.md §5
```

---

### 2.7 Step 7 — E2E + contract + 文档收口

#### 状态

⏳ 待启动(Step 1-6 全部完成后启动)

#### 前置条件

- ✅ Step 1-6 全部完成
- ✅ V2 新增模块各自的 e2e 已通过(Step 3-6)

#### 本步范围

V2 第一阶段全量回归 + 契约快照锁定 + 文档收口:

- 跑全量 e2e(v1 + V2)+ 全量 contract 测试,确认全绿
- 把 V2 新增 OpenAPI schema 锁定到契约快照(`__snapshots__/openapi.contract-spec.ts.snap` 一并 commit)
- 更新 `README.md` "必读文档" / "环境要求" / "快速启动" 等章节(加 V2 模块说明)
- 更新 `CHANGELOG.md`:V2 第一阶段开发完成的发布说明
- 更新 `TASKS.md §6` V2-D8 + Step 1-7 全部 ✅ 已完成
- 同步 `data-model-draft.md` v0.4(可选):标记 4 模型已实施(从"当前倾向"→"已实施");5 延后模型保持 ⏸️
- 不更新 `ARCHITECTURE.md §12.7+` 内容(蓝图级,已锁;状态由 TASKS.md 反映)

#### 本步不做

- ❌ 不做 V2.x 立项(那是单独决议)
- ❌ 不开发延后 5 模型
- ❌ 不修改 baseline / research / data-model-draft 等已锁定文档(除 `data-model-draft.md` v0.4 标记可选)

#### 交付物

| # | 交付物 |
|---|---|
| 1 | 全量 e2e 通过(v1 162 + V2 新增 X 个,全部通过) |
| 2 | 契约快照锁定 |
| 3 | README / CHANGELOG / TASKS.md §6 / data-model-draft.md(可选)更新 |
| 4 | V2 第一阶段 ship-readiness audit 通过 |

#### 验收命令

A 档:**全跑**

```
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e        # v1 162 + V2 新增 X 个,全部通过
pnpm test:contract   # 快照锁定后通过
pnpm build           # 生产构建通过
```

B 档:**全跑**

```
pnpm start:dev          # 服务启动
curl /api/docs          # Swagger UI 完整含 v1 + V2 接口
curl /api/health/live   # 200
curl /api/health/ready  # 200(DB 连通)
spot check v1 14 接口典型路径(全部 200,响应契约不变)
spot check V2 4 模块典型路径(全部 200)
SIGTERM 关停(优雅关闭)
```

#### 回滚风险

| 风险 | 评估 |
|---|---|
| 文档 / 测试 / 快照不一致 | 本步主要是收口,代码已稳定;风险**极低** |
| 回滚操作 | `git revert <commit>`(仅文档 / 快照,无代码运行时影响) |

#### 建议 commit message

```
docs+test: V2 first-stage ship-ready (Step 7 wrap-up)

V2-D8 第一阶段 Step 7 交付:全量回归 + 契约锁定 + 文档收口。

- 全量 e2e 通过(v1 162 + V2 X 个,全部通过)
- 契约快照锁定(__snapshots__/openapi.contract-spec.ts.snap)
- README / CHANGELOG / TASKS.md §6 V2-D8 + Step 1-7 ✅ 已完成
- (可选)data-model-draft.md v0.4 标记 4 模型已实施

V2 第一阶段开发范围全部交付:
- ✅ dictionaries / organizations / members / member_departments
- ✅ users.memberId 可空外键(v1 兼容)
- ⏸️ 5 延后模型(member_profiles / attachments / audit_logs /
  events / event_participants)保留 V2.x 复活路径

验收(全过):
- pnpm lint / typecheck / test / test:e2e / test:contract / build
- B 档:start:dev / Swagger / health/live & ready / v1 + V2
  spot check / 优雅关闭

V2-D8 闭环;V2.x 启动须用户单独拍板。

参考:docs/v2-plan.md §2.7 Step 7
```

---

## 3. 每步验收要求

### 3.1 A 档(每步必跑)

```
pnpm lint                     # 0 warnings / 0 errors(--max-warnings 0)
pnpm typecheck                # tsc src + tsc test 双段无错
pnpm test                     # unit
pnpm test:e2e                 # v1 既有 162 tests + V2 新增 e2e
pnpm test:contract            # OpenAPI 契约快照(若涉及 schema 改动需 -u 更新)
```

任一未通过 → **不算完成,不能 commit,不能向用户报告"任务完成"**(沿用 V1.1 §17.10 末尾纪律)。

### 3.2 B 档(涉及全局行为或 v1 兼容性时追加)

| 验证项 | 适用步骤 |
|---|---|
| `pnpm start:dev` 服务启动 | Step 1 / Step 5 / Step 7(必跑);Step 2-4 / Step 6 推荐 |
| `curl /api/health/live` → 200 | 全部 |
| `curl /api/health/ready` → 200(DB 连通) | Step 1(schema 改后必验) / Step 7 |
| `curl /api/docs` Swagger UI 完整 | Step 3-7(涉及 controller / Swagger) |
| `curl /api/docs-json` OpenAPI JSON | 同上 |
| spot check v1 14 接口典型路径 | Step 1(schema)/ Step 5(改 v1 users)/ Step 7(全量) |
| spot check V2 新接口典型路径 | Step 3-7 |
| `SIGTERM` 优雅关闭 | 全部 |

### 3.3 验收对齐

每步完成前必须满足:

1. A 档全过
2. 涉及 B 档场景的 B 档全过
3. 该步建议 commit message 中显式列出"验收(全过)"段
4. 任务卡内 8 子项(状态 / 前置 / 范围 / 不做 / 交付物 / 验收 / 回滚 / commit message)全部勾选

---

## 4. commit 拆分建议

### 4.1 拆分原则

- **每步独立 commit**(7 步 = 7 个主 commit;可有少量子 commit 用于大模块拆分)
- **不混步**(Step 1 schema 不和 Step 2 seed 合并;Step 5 members 不和 Step 6 member_departments 合并)
- **每步内部子 commit 允许**:
  - Step 1:可拆 `chore(prisma): add V2 schema models` + `chore(prisma): generate migration` + `chore(prisma): apply migration`(若便于审阅)
  - Step 3:可拆 `feat(dict-types): CRUD` + `feat(dict-items): CRUD + tree` + `test(dictionaries): e2e`
  - Step 5:可拆 `feat(members): CRUD` + `feat(users): hook memberId` + `test(members): e2e`
  - Step 6:可拆 `feat(member-departments): assignment` + `test(member-departments): e2e`
- **Step 2 / Step 4 / Step 7 通常 1 个 commit 即可**

### 4.2 commit 数量预估

最少 7 个(每步 1 个),最多 ~12 个(若按 §4.1 子拆分)。

### 4.3 commit message 前缀对照

| 场景 | 前缀 |
|---|---|
| 新模块 / 新功能 | `feat(<module>):` |
| Prisma schema / migration | `chore(prisma):` |
| seed | `chore(seed):` |
| 单独测试 commit | `test(<scope>):` |
| 文档收口 | `docs:` |
| Bug 修复 | `fix(<module>):` |
| 通用 V2 开发(混合)| `v2-dev: <step编号> <简述>` |

### 4.4 禁止事项

- ❌ 一个 commit 跨多个 Step
- ❌ commit message 不写 Step 编号
- ❌ commit 不验收就 push
- ❌ `--no-verify` / `--amend` 跳过 hook
- ❌ 删除 e2e / contract 测试以"换取"绿(违反 baseline §13)

---

## 5. 风险与回退

### 5.1 关键风险

| 风险 ID | 风险 | 概率 | 后果 | 缓解 |
|---|---|---|---|---|
| **R-1** | Prisma 条件性唯一索引(部分索引带 WHERE 子句)版本不支持 | 低 | Step 1 / Step 6 单归属约束需降级 | docs/v2-data-model.md 中显式给出降级路径(全局唯一 + 业务规则);Step 6 实施时根据 Prisma 实际版本选择 |
| **R-2** | v1 users 改动引入回归 | 中 | v1 14 接口契约破坏 | Step 5 必跑 B 档 + e2e 162 tests 必须零退化;OpenAPI 契约快照对比 |
| **R-3** | 字典 code 变更影响业务表 | 低 | dict_items code 改后,引用方 stale | 选 D-2 候选 A `<concept>Code` 已知风险;运营改 code 是低频操作,文档 / 培训上规范操作 |
| **R-4** | Step 5 接入 audit_logs 的偷做 | 中 | 违反 D7-min;扩大第一阶段范围 | §6 任务卡 / §0.3 红线 / 每步验收清单显式排除;code review 阶段把关 |
| **R-5** | Step 6 唯一约束在并发下失效 | 低 | 同一人挂两个部门 | DB 层唯一约束兜底;业务层校验为辅;e2e 测试并发场景(可选) |
| **R-6** | 字典 seed 包含真实运营数据 | 低 | R13 红线破口 / 运营数据进 git history | Step 2 review 严守 neutral-demo;PR 时 grep 真实业务名词 |
| **R-7** | Step 1 migration 反向影响开发库 | 低 | 本地数据丢失 | Step 1 实施前确保开发库无关键数据;Prisma 安全机制需用户授权 reset |
| **R-8** | 顺手做延后模型 | 中 | 扩大第一阶段范围 / 时间不可控 | §0.3 + §7 显式排除;每步验收清单"本步不做"段把关;code review |

### 5.2 回退策略

| 回退场景 | 操作 |
|---|---|
| 单步发现问题 | `git revert <step-commit>`(模块整体撤回);schema 不动(若已 commit) |
| Step 1 schema 错误 | `git revert <commit>` + `pnpm prisma migrate reset --force --skip-seed`(需用户授权)+ 重新 `pnpm prisma:deploy` 到上一个 migration |
| Step 5 v1 users 改坏 | `git revert <commit>` 撤回 service 改动;Prisma `User` model `memberId` 字段保留(已 migrate)— 不再使用即可 |
| 全量回退 V2 第一阶段 | `git revert <step1>...<step7>` 逆序撤回;migration reset 到 v1 末尾;commit history 保留(便于审计) |
| 单步多个子 commit 回退 | `git revert <child-commit>` 单独撤回(每个子 commit 独立可回滚) |

### 5.3 回退后的 V2 状态

- 全量回退 = V2 第一阶段开发完全撤回 = V2-D8 状态退回到立项中(D8 立项产出物保留)
- 部分回退(单步)= 该步重做 = 在 TASKS.md §6 该步任务卡注明"已撤回 / 待重做"

---

## 6. v1 兼容性核查清单

每步完成前**逐条核查**(对应 ARCHITECTURE.md §12.8.2):

### 6.1 v1 接口契约

- [ ] v1 §6 已交付的 14 个接口的**路径 / HTTP 方法**全部不变(Step 1-7 全程)
- [ ] v1 14 个接口的**入参 DTO 字段集**不变
- [ ] v1 14 个接口的**出参 DTO 字段集**不变(`memberId` **不**进入 `UserResponseDto` 必返字段;可选返回需 Step 5 内部显式说明)
- [ ] v1 14 个接口的**错误码 / HTTP status / 响应包装**全部不变
- [ ] v1 14 个接口的**权限标注**(`@Public` / `@Roles`)全部不变

### 6.2 v1 表与 Prisma model

- [ ] v1 `users` 表新增**可空** `memberId` 字段(Step 1)
- [ ] v1 `users` 已有字段 / 索引 / 外键全部保留
- [ ] Prisma `User` model 仅追加 `memberId` 可空字段 + 关系到 `Member`(不改已有字段)

### 6.3 v1 业务逻辑

- [ ] v1 `POST /api/auth/login` 路径完全不动(Step 1-7 全程)
- [ ] v1 用户创建 / 查询 / 更新 / 软删除路径不动(Step 5 仅追加 memberId 处理,不改既有路径)
- [ ] v1 `seed.ts` 创建 SUPER_ADMIN 的逻辑不动(Step 2 仅追加字典 seed)
- [ ] v1 既有 e2e 用例(19 suites / 162 tests)全部保留并全部通过(Step 1-7 每步验证)

### 6.4 v1 已交付 src/ 文件修改限制

- [ ] **可修改**:`prisma/schema.prisma`(Step 1 加 memberId)
- [ ] **可修改**:`src/modules/users/users.service.ts` / `users.dto.ts`(Step 5 追加 memberId 处理)
- [ ] **禁止修改**:`src/modules/auth/*`(全程)
- [ ] **禁止修改**:`src/modules/health/*`(全程)
- [ ] **禁止修改**:`src/bootstrap/*`(全程)
- [ ] **禁止修改**:`src/config/*`(除非新增 V2 配置文件,本阶段无 V2 配置需求)
- [ ] **禁止修改**:`src/database/prisma.service.ts`(全程)

### 6.5 v1 OpenAPI 契约快照

- [ ] V2 新增接口 schema 进入快照(每步增量更新)
- [ ] v1 14 接口 schema 在快照中保持不变(若发生变化 = §6.1 / §6.3 红线违反)
- [ ] Step 7 收口时 `pnpm test:contract` 全过

---

## 7. 不在本计划范围

### 7.1 不开发的模型

- ❌ `member_profiles`(任何敏感字段 — 身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 / 第三方账号 / 凭证标识 等)
- ❌ `attachments`(附件元数据 / 上传 Provider)
- ❌ `audit_logs`(审计基础设施 / 任何接入)
- ❌ `events`(活动事件)
- ❌ `event_participants`(参与状态)

V2.x 复活触发条件见 `TASKS.md §5.5.4.3`。

### 7.2 不实施的能力

- ❌ 文件上传 Provider(本地 / OSS / R2 / 其他)
- ❌ RBAC / permission 表 / casl 权限框架
- ❌ Redis / 队列 / 定时任务
- ❌ 完整状态机 / 流程引擎(请假 / 报名 / 审批 等)
- ❌ 读审计 / 全量审计
- ❌ 多租户
- ❌ AI / 向量检索
- ❌ 复杂统计看板 / BI 报表
- ❌ 通知系统(短信 / 邮件 / 企业微信)
- ❌ 字典缓存 / 用户状态缓存
- ❌ 外部公开报名 / 微信集成

### 7.3 不允许的破口

- ❌ 在第一阶段绕过 §3.1 字典 seed 红线(真实业务取值进入 git history)
- ❌ 在第一阶段绕过 §6.1 v1 接口契约(v1 14 接口任一发生变化)
- ❌ 在第一阶段把 `member_profiles` 敏感字段"先占位"到任何 model
- ❌ 在第一阶段把 `audit_logs` 接入到任何 V2 写操作("既然要做就先做"反模式)
- ❌ 修改 `docker-compose.yml` / `.github/workflows/*`(除非 D8 立项后单独评估)
- ❌ 引入未在任务卡声明的新依赖

### 7.4 文档级不做

- ❌ 不修改 `baseline.md` / `research.md` / `data-model-draft.md` v0.3 / `interview-brief.md`(已锁定)
- ❌ 不修改 `CLAUDE.md §1-§17` / `AGENTS.md §1-§17`(已锁定;§18 已就位)
- ❌ 不修改 `ARCHITECTURE.md §1-§11`(v1 / V1.1 已锁定)
- ❌ Step 7 可选更新 `data-model-draft.md` v0.4(标记 4 模型已实施),不动其他文档

---

## 附录 A:Step 间依赖图

```
Step 1: Prisma schema + migration
  │
  ├──> Step 2: seed neutral-demo(依赖 schema)
  │      │
  │      ├──> Step 3: dictionaries 模块(依赖 schema + seed)
  │      │      │
  │      │      ├──> Step 4: organizations 模块(依赖 schema + 字典 nodeTypeCode)
  │      │      │      │
  │      │      │      ├──> Step 5: members 模块(依赖 schema + 字典 gradeCode)
  │      │      │      │      │
  │      │      │      │      ├──> Step 6: member_departments(依赖 schema + 字典 + org + member)
  │      │      │      │      │      │
  │      │      │      │      │      └──> Step 7: E2E + contract + 文档收口
  │      │      │      │      │
```

**关键依赖**:

- Step 1 是所有后续步骤的前置(schema 必须先就位)
- Step 2 在 Step 3-6 之前(seed 提供字典占位)
- Step 4 / Step 5 在 Step 3 之后(都引用字典 code)
- Step 6 在 Step 4 + Step 5 之后(同时引用 org + member)
- Step 7 在 Step 6 之后(全量收口)

**关键独立性**:

- Step 4(organizations)与 Step 5(members)**理论上可并行**,因都只依赖 Step 3(字典),不互相依赖
- 但在实践中**建议串行**:每步独立 commit + 独立审过,不并行

---

## 附录 B:版本表

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-05-07 | 初版,V2-D8 立项 D8-2 产出物;7 步开发顺序 + 每步任务卡 + commit 拆分 + 风险与回退 + v1 兼容性核查清单 |

---

> **本文是 D8-2 立项产出物**;V2-D8 标记完成需 5 份立项产出物全部就位(对应 `ARCHITECTURE.md §12.11.1`)。
> Step 1 启动需 V2-D8 ✅ + 用户单独拍板;**禁止**绕过 D8 直接进入开发。
