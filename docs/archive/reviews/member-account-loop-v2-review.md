# 队员账号闭环 v2(完整生命周期)评审稿

> **状态:冻结**(2026-07-07;维护者 goal「队员账号闭环 v2(完整生命周期)」拍板,goal 文本即立项 + 授权;本稿按 [`process.md §4`](../../process.md) D 档降速产出,沿 `srvf-prisma-change` skill 流程,冻结后不回改)。
> **承接**:队员账号闭环 v1(MVP)= [#515](https://github.com/BA7IEE/srvf-nest-api/pull/515)(`8a19aa15`)+ [#516](https://github.com/BA7IEE/srvf-nest-api/pull/516)(`47c2d2f9`),已发 main,v0.37.0;defer 项登记于 [`NEXT_TASKS.md` P1-18](../../ai-harness/NEXT_TASKS.md)。
> **基线**:origin/main `47c2d2f9`;权限码 196 / ops-admin 95 / biz-admin 73 / org-admin 57 / EXPECTED_ROUTES 321 / controller 66 / 模块 35 / migration 39 / 角色 7。

---

## 0. TL;DR

v1 只有"从零开号"一条端点,`User.memberId` 是**非 partial** `@unique`——槽位一旦被任何 User(含软删)占用即永久占用,结构性堵死解绑/换绑/重开。v2 做四件事:①把 `memberId` 改成 partial unique index(`WHERE "deletedAt" IS NULL`),沿本仓 `role_bindings`/`member_organization_memberships`/`organization_position_assignments` 等 7 个已验证先例的手写迁移范式;②开号 existingLink 预检查从"含软删"松绑为"仅 live";③新增绑定既有悬空账号 / 解绑(只断链)/ 退号重开(软删旧号 + 开新号,单事务原子)/ 队员面启停账号 四个端点;④批量开号(镜像 announcement-import 逐行 skip-on-error)。

**本稿在维护者已拍板方向之外,新发现并冻结以下三个结构性细节**(均已用代码证据核实,详见 §1.2 E-4/E-6/E-7):

1. **P2002 `meta.target` 对手写 partial index 不可靠**(§1.2 E-4)——本仓 `position-assignments`/`supervision-assignments` 已亲测走过这条弯路("P2002 meta.target 不可靠 → 任何 P2002 直接抛 ALREADY_EXISTS")。#516 的 `runWithUniqueConstraintGuard` 现靠 `target.includes('memberId')` 精确匹配列名,`memberId` 从 schema 声明的 `@unique` 变成手写 partial index 后,这个匹配可能失效。
2. **`username`(= memberNo)是另一个仍然全量 `@unique` 的字段,不在本次改造范围内**(§1.2 E-7)——"退号重开"若沿用 v1"username = memberNo"逐字不变,新建的 User 行会立刻撞上旧行(已软删但仍永久占用该 username)的唯一约束,**结构上不可能成功**。已用代码证据确认 `login-sms` 完全按 `phone` 解析账号、从不读 `username`,故重开场景可安全地给新行分配 `${memberNo}-{generation}` 形式的 username,零登录面影响。
3. **两面回显查询(`findLinkedUser`/`loadLinkedUsersByMemberIds`)当前不过滤 `deletedAt`**(§1.2 E-6)——这在 v1(每个 memberId 至多 1 条历史行)下是对的;但 reopen 落地后同一 memberId 可能同时存在 1 条软删历史行 + 1 条新 live 行,不过滤会导致 `hasAccount`/`accountStatus` 随机返回旧行而非当前行。

---

## 1. 决策汇总表

### 1.1 goal 已拍板项(冻结,不重开)

| # | 决策 |
|---|---|
| D-1 | `User.memberId` 全量 `@unique` → partial unique index `WHERE "deletedAt" IS NULL`,手写迁移;零冲突 / 零回填 / 非破坏性 |
| D-2 | 开号 existingLink 预检查从"含软删"改"仅 live"(`memberId=id AND deletedAt=null`);这是对 #515/#516 唯一有意的行为变更 |
| D-3 | 绑定既有悬空账号:认领 live、`memberId=null` 的账号,不强制手机号,账号保留原登录方式 |
| D-4 | 解绑 = 只断链(置 `memberId=null`),不顺手停用/软删账号;要停用走既有用户管理端点 |
| D-5 | 退号重开:软删旧号 + 开新号(新手机号),单事务原子;靠 D-1 让新号取到释放槽位 |
| D-6 | 队员面启/停账号:判权复用 `user.update.status` |
| D-7 | 批量开号:镜像 announcement-import / promote 批模式,逐行 grant + skip-on-error + 逐行结果回报 + 上限 |
| D-8 | 端点面:全 `admin/v1`、member 轴、无 App 自助面;auth 模块零改动 |
| D-9 | 权限码:新增 1 条 `member.bind.account`(bind+unbind);grant/reopen/bulk 复用 `member.grant.account`;status 复用 `user.update.status` |

### 1.2 工程代决项(本稿冻结)

| # | 代决 | 依据 / 证据 |
|---|---|---|
| E-1 | 迁移形态:`DROP INDEX "User_memberId_key"`(原索引,建于 `20260507181930_v2_foundation:166`)+ `CREATE UNIQUE INDEX "User_memberId_active_key" ON "User"("memberId") WHERE "deletedAt" IS NULL` + `CREATE INDEX "User_memberId_idx" ON "User"("memberId")`(补普通索引,覆盖 existingLink 预检查等**有意**跨软删状态查询;移除 `@unique` 会连带丢失其隐式索引) | 沿 `role_bindings`/`organization_position_assignments`/`organization_supervision_assignments`/`member_organization_memberships` 手写 partial unique 范式(7 处precedent 全部一致);`User` model 当前仅 `@@index([deletedAt])`/`@@index([status])`,无 `memberId` 索引(`prisma/schema.prisma:83-84`),需新增 |
| E-2 | schema.prisma:`memberId String? @unique` → `memberId String?` + 新增 `@@index([memberId])`(第 42 行 + 索引块) | 同上 |
| E-3 | **findUnique 审计结论:全仓 0 处** `prisma.user.findUnique({ where: { memberId } })`(grep 确认;现有两处 `memberId` 相关 `findUnique` 分别是 `member.findUnique({where:{id: memberId}})` 和 `memberProfile.findUnique({where:{memberId}})`,均非本字段)。移除 `@unique` 后 `Prisma.UserWhereUniqueInput` 类型自动去掉 `memberId`,`typecheck` 会对任何遗漏用法报错——**双重确认安全**,无需额外代码改动 | grep `findUnique` 全仓 + 类型系统兜底 |
| E-4 | **P2002 守卫韧性**:`runWithUniqueConstraintGuard`(`members.service.ts:151-153`)现有 `target.includes('memberId')` 分支不删,**新增**一条 OR 分支匹配新索引字面量名 `target.includes('User_memberId_active_key')`;两者任一命中即映射 `MEMBER_HAS_LINKED_USER`,不动"P2002 但 target 不含已映射键 → 原样上抛"既有单测契约(`members.service.spec.ts:82`)。**必须新增一条真实(非 mock)并发 e2e**——两个并发 `POST :id/account` 打同一 live 且无账号的队员,断言"一个 201、另一个 MEMBER_HAS_LINKED_USER(非裸 500)"——用真实 Postgres 验证 Prisma 对手写 partial index 实际报什么 `target`,不能只信赖现有 mock 单测(`p2002(['memberId'])` 是手造 target,不代表真实 DB 行为) | 本仓 `position-assignments.service.ts:613-616`/`supervision-assignments.service.ts:537-540` 明文注释"partial unique 由 migration.sql 末尾手写,P2002 meta.target 不可靠";两处均放弃 target 解析改为"任何 P2002 直接判定"(因为那两张表单次 create 只可能撞一种唯一约束);本模块 `tx.user.create()` 同时挂 username/phone/memberId 三种可能唯一冲突,不能照搬"任何 P2002 即判定"的粗粒度写法,必须保留判别但加固 |
| E-5 | **PR 顺序与边界**:Schema PR 范围 = 迁移 + schema.prisma 编辑 + E-4 守卫加固 + E-4 并发 e2e,**零 API 可见行为变化**(existingLink 预检查这时仍是"含软删",没有任何端点能触达"同一 memberId 两条历史行"场景,两面回显查询维持现状即可正确)。D-2(仅 live)+ 新端点落地 Endpoint PR 才会真正产生"同一 memberId 多条历史行"的可能性,E-6 两面回显修复须跟 D-2 同一 PR 落地 | 顺序推导:只有 existingLink 放宽 + reopen 端点存在后,才可能出现"1 条软删旧行 + 1 条 live 新行"共享同一 memberId;Schema PR 独立发布时该场景不可达,故可安全独立成刀且不引入行为回归窗口 |
| E-6 | **两面回显查询必须补 `deletedAt: null` 过滤**(`findLinkedUser` `members.service.ts:190-200` + `loadLinkedUsersByMemberIds` :164-175):D-2 + reopen 落地后,同一 memberId 可能同时存在 1 条软删历史行(reopen 产生)+ 1 条 live 行,当前不过滤的 `findFirst`/`findMany` 对"返回哪条"没有确定性排序保证,会导致 `hasAccount`/`accountStatus`/`userId` 随机翻转为历史值。改为仅在 `deletedAt: null` 范围内查(找不到 = 无账号,语义清晰:hasAccount 语义从"槽位是否被任何行占用过"收窄为"当前是否有 live 绑定",与 D-2 后 `MEMBER_HAS_LINKED_USER` 判定口径〔仅查 live〕保持一致) | DoD 原文"两面回显:队员面 hasAccount/accountStatus 随生命周期正确翻转"要求;不改会导致 unbind/reopen 后前端拿到过期或不确定的账号态 |
| E-7 | **`username` 冲突(v1 未预见的结构性缺口)**:`User.username` 全量 `@unique` **不在本次 partial-unique 改造范围内**(goal 只点名 `memberId`,且 AGENTS §10 明文"username 不复用"是全仓永久铁律,不可放宽)。grantAccount 恒定 `username = member.memberNo`;若 reopen 沿用同一 memberNo 作 username,新行必然撞上旧行(已软删但 username 仍永久占用)的唯一约束,**结构上 100% 失败**,与 D-5"单事务原子"矛盾。**已用代码验证登录不受影响**:`login-sms.service.ts:104-115` 的 `resolveActiveUserByPhone` 完全按 `phone` 查找账号(`where:{phone}`),从不读取或比较 `username`;`username` 仅在 JwtPayload(`{sub, username}`)里做展示性回显,不参与任何鉴权判定(`JwtStrategy.validate` 按 `payload.sub` 查库)。**决定**:reopen 新行 `username = ${member.memberNo}-${generation}`,`generation = 1 + count(User, memberId=id, 含软删)`(事务内查,先 grant 的第一条仍是纯 `memberNo`,v1 行为逐字不变;第二次起才出现后缀,只在 reopen 路径触发)。全局仍唯一(memberNo 本身全局唯一 ⇒ `${memberNo}-{n}` 全局唯一) | grep 验证 `login-sms.service.ts` 零 username 依赖;AGENTS §10 username 不复用是永久铁律,不可绕过或申请例外 |
| E-8 | **phone 冲突(非缺口,行为确认)**:`User.phone` 同样全量 `@unique`、不在本次范围内。reopen 若传入与旧行相同的手机号,会立即撞旧行(已软删仍占用)触发 `PHONE_ALREADY_BOUND`——这是**正确且符合预期**的行为(goal 原文即"开新号(新手机号)",隐含新手机号本就该与旧号不同),不是 bug,无需特殊分支;e2e 需覆盖"reopen 传相同手机号 → PHONE_ALREADY_BOUND"以固化此为有意行为而非遗漏 | 与 E-7 同一约束类别(phone/username 均维持既有"不复用"铁律,仅 memberId 被本次改造放宽) |
| E-9 | **队员面启停账号(D-6)不复用 `UsersService.updateStatus()`,改为在 `members.service.ts` 内直连 prisma 镜像其必要副作用**:`UsersModule` 的 `exports` 仅 `AppIdentityResolver`(`users.module.ts:55`),明确**不**导出 `UsersService`("避免下游模块隐式扩散对 users 内部能力的依赖"),引入依赖需改动既有模块边界。且本模块对 User 表写入的既定范式就是直连 prisma、不经 UsersService(grantAccount 注释原文"不复用 UsersService,防环 + 零漂移")。但 `UsersService.updateStatus()`(`users.service.ts:589-628`)在置 `DISABLED` 时有一个**必须保留的安全副作用**:撤销该 user 全部未撤销未过期 refresh token(`revokedReason='admin-disable'`)——若只做裸 `tx.user.update({data:{status}})`,被禁用队员的现有 access/refresh 会继续有效直至自然过期,构成真实的安全回归。**决定**:members 模块内新方法显式复刻这一条(且仅这一条)副作用;`assertNotSelf` 等价检查保留(比较 `currentUser.id` 与被操作 User 的 id,防管理员通过队员轴误禁自己绑定的账号,低概率但代价可能是自锁);**跳过**"最后一个 SUPER_ADMIN 保护"——结构上不可能触发(bind 的来源账号最高只能是 API 建的 ADMIN,AGENTS §13 业务 API 禁止创建 SUPER_ADMIN;grant/reopen 恒 `role=USER`);**跳过 audit**——镜像 `UsersService.updateStatus()` 自身"不为 status 改动写 audit"的既有决定(D-PR3-2),保持同一操作在两个轴上行为对称 | `users.module.ts:55` exports 数组;`users.service.ts:614-625` refresh 撤销注释;AGENTS §13 SUPER_ADMIN 创建边界 |
| E-10 | **批量开号事务边界:每行独立 `$transaction`,不是整批一个事务**——镜像 `announcement-import.service.ts` 的 `run()` 编排(§137-215):循环内逐行 `try { await this.grantAccountCore(...) } catch (err) { if (!(err instanceof BizException)) throw err; /* 记 blocked */ }`,每行调用各自触发独立事务。**不能**把整批包进一个 `$transaction`——Postgres 事务在任何语句出错后即"poisoned"(`current transaction is aborted`),同事务内后续行会连锁失败,与"skip-on-error 逐行独立"的 DoD 要求矛盾 | `announcement-import.service.ts` 各行调用被复用 service 的 `create()`(各自独立事务),编排层只捕获 `BizException` 转译成行结果,不共享事务;`recruitment-promotion.service.ts` 的批量发号则是刻意的整批单事务(全或无语义,与本处"部分成功"语义相反,不可套用) |
| E-11 | **提取共享核心**:`grantAccountCore(member, phone, currentUser, auditMeta, tx?)` 从现有 `grantAccount()` 抽出(校验 3-5 步 + 创建 + audit),供单条端点与批量循环共用;抽取动作放在**批量 PR**(需求出现时才抽,不在端点 PR 预先做) | 两个真实调用点(单条 + 批量)才具备抽取正当性,避免 AGENTS §2 grab-bag 式预先抽象 |
| E-12 | **路由命名与注册顺序**:批量端点 `POST admin/v1/members/accounts/bulk-grant`(2 级字面量,不用 announcement-import 式冒号写法;本仓既有 batch 端点全部 kebab-case:`role-bindings/batch`/`explain-batch`/`batch-mark-threshold`);因 `accounts` 与 controller 已有的 `:id` 同处第 2 段,**必须**在 `@Get(':id')` 等动态路由之前声明(沿既有 `options` "specific-before-dynamic" 先例,`members.controller.ts:58`) | 既有 5 个 batch/bulk 端点全部 kebab-case 无冒号;`options` 端点已有的顺序注释 |

---

## 2. 风险表(D 档降速 ②)

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` | ✅ `User.memberId` 去 `@unique`,加 `@@index([memberId])` |
| 是否新增 migration | ✅ 第 40 个;`DROP INDEX` + `CREATE UNIQUE INDEX ... WHERE` + `CREATE INDEX`;**零回填、零数据变更** |
| 是否修改 `prisma/seed.ts` | ✅ +1 权限码 `member.bind.account`,绑 ops-admin(196→**197**,ops-admin 95→**96**) |
| 是否影响现有数据 | ❌(纯约束形态收窄,现有数据必然满足更严的全量唯一 ⇒ 天然满足更宽松的 partial 唯一,零冲突) |
| 是否不可逆 | ⚠ 索引改名不可"一键回退"(需再发一个反向 migration),但**无数据丢失风险**;真正不可逆的是"若已有生产数据出现同 memberId 多条 live 行"这种理论情形——不可能发生,因为改造前的全量 unique 已保证任何时刻至多 1 条 |
| 是否影响 OpenAPI / contract snapshot | ✅ Endpoint PR +5 路由(bind/unbind/reopen/status + bulk-grant),schema PR 本身 0 |
| 是否影响鉴权 / Permission seed / 审计 | ✅ +1 权限码;+3 audit event(`member.account-{bound,unbound,reopened}`);`user.update.status`/`member.grant.account` 复用,不新增码 |
| 是否需要新增 BizCode | ✅ 2 个(15032/15033,详见 §3.3) |
| 是否需要用户拍板 | ✅ 已拍板(本 goal 即授权;本稿为 T0 冻结) |

---

## 3. 五张清单

### 3.1 schema

**migration**(第 40 个;命名 `20260707HHMMSS_user_memberid_partial_unique`,HHMMSS 取实际执行时刻):

```sql
-- 移除 User.memberId 原全量 unique 索引(建于 20260507181930_v2_foundation:166)
DROP INDEX "User_memberId_key";

-- 手写 partial unique index(Prisma DSL 至 6.x 不支持 @@unique 内表达 WHERE 子句;
-- 沿 role_bindings_active_unique / organization_position_assignments_active_unique /
-- member_org_membership_active_unique 等既有范式)。
-- 语义:同一 memberId 至多 1 条"活跃"(未软删)User 关联;软删后释放槽位供重新绑定/开号。
CREATE UNIQUE INDEX "User_memberId_active_key" ON "User"("memberId") WHERE "deletedAt" IS NULL;

-- 补普通索引:existingLink 预检查(v1 遗留,MEMBER_HAS_LINKED_USER 判定用)、
-- hasAccount 两面回显批量查询等**有意**跨软删状态的既有调用点,移除 @unique 后
-- 隐式索引一并消失,须显式补上避免全表扫描回退。
CREATE INDEX "User_memberId_idx" ON "User"("memberId");
```

**schema.prisma**(`User` model,第 42 行 + 索引块):

```diff
- memberId String? @unique
+ memberId String?
  member   Member? @relation(fields: [memberId], references: [id], onDelete: SetNull)
  ...
  @@index([deletedAt])
  @@index([status])
+ @@index([memberId])
```

**干净库验证要求**(实施 PR 内自证,不在本稿执行):39/40 全量重放通过;`prisma migrate status` 无 drift;seed 幂等二跑。

### 3.2 权限码(+1)

| code | module | action | resourceType | 绑定 | 用途 |
|---|---|---|---|---|---|
| `member.bind.account` | member | bind | account | ops-admin | 绑定既有悬空账号 + 解绑(bind/unbind 共用同一码,镜像 grant 单码覆盖开号全流程) |

复用(不新增):`member.grant.account`(grant 松预检查 / reopen / bulk-grant)、`user.update.status`(队员面启停账号)。

权限码 196→**197**;ops-admin 95→**96**;biz-admin/org-admin/角色数不变。

### 3.3 BizCode(+2,150xx 段"资源状态非法/引用约束"子段延续)

| code | 常量名 | message | httpStatus | 用途 |
|---|---|---|---|---|
| 15032 | `MEMBER_ACCOUNT_TARGET_ALREADY_LINKED` | 目标账号已绑定其他队员 | 409 CONFLICT | bind:目标 User 存在且 live,但 `memberId` 已非空(绑了别人) |
| 15033 | `MEMBER_HAS_NO_LINKED_USER` | 队员当前无绑定账号 | 409 CONFLICT | unbind/reopen/status:member 无 live 关联账号可操作 |

复用(不新增):`MEMBER_NOT_FOUND`(15001)/ `MEMBER_INACTIVE`(17030)/ `MEMBER_HAS_LINKED_USER`(15031,bind 时"本队员已有 live 账号")/ `USER_NOT_FOUND`(10001,bind 时目标 userId 不存在或已软删,沿 position-assignments/supervision-assignments"跨实体引用复用被引用方 NOT_FOUND"范式)/ `USERNAME_ALREADY_EXISTS`(10002)/ `PHONE_ALREADY_BOUND`(24002)。

### 3.4 AuditLogEvent(+3)

| event | resourceType | extra(掩码) | 说明 |
|---|---|---|---|
| `member.account-bound` | member | `{memberId, userId}` | bind 成功 |
| `member.account-unbound` | member | `{memberId, userId}` | unbind 成功(userId = 断链前的值) |
| `member.account-reopened` | member | `{memberId, oldUserId, newUserId, phone: maskPhone(...)}` | reopen 成功 |

队员面启停账号(D-6/E-9)**不新增 audit event**,镜像 `UsersService.updateStatus()` 自身"不为 status 改动写 audit"的既有决定,保持同一操作在 member 轴与 user 轴行为对称。批量开号每条成功行复用既有 `member.account-granted`(逐行各自一条,不做汇总 event)。

union 共 +3(现 union 计数以实施 PR 实测为准)。

### 3.5 e2e 覆盖清单(骨架,实施 PR 内展开)

- **Schema PR**:并发 grantAccount 真实 e2e(两个并发请求打同一 live 且无账号成员,断言 1×201 + 1×`MEMBER_HAS_LINKED_USER`,非裸 500);既有 133 suites 全绿(零回归,因为 existingLink 预检查此时仍未变)。
- **Endpoint PR**(完整生命周期链,核心场景):
  - 开号 → 解绑(`memberId=null` 且账号仍 `ACTIVE`)→ 绑定回同一队员(复验)→ 退号重开(新 phone,断言旧号 `DISABLED`+软删、新号 live 且 `username=memberNo-2`)→ 启停(`DISABLED`→`ACTIVE`)
  - **"软删旧号后能重开"**:开号 → 软删该 User(模拟历史遗留)→ 用 grant 或 reopen 均应成功(existingLink 仅查 live)
  - **"解绑后账号 memberId=null 且仍 ACTIVE"**
  - **"绑定他人已绑账号被拒"**:目标 User 已有 memberId → `MEMBER_ACCOUNT_TARGET_ALREADY_LINKED`
  - **"绑定不存在/已软删的 userId"** → `USER_NOT_FOUND`
  - **"本队员已有 live 账号时再 bind/grant"** → `MEMBER_HAS_LINKED_USER`
  - **"unbind/reopen/status 但队员无 live 账号"** → `MEMBER_HAS_NO_LINKED_USER`
  - **"reopen 传入与旧号相同手机号"** → `PHONE_ALREADY_BOUND`(E-8 固化为有意行为)
  - **两面回显翻转**:每一步后查 `GET members/:id` 断言 `hasAccount`/`accountStatus`/`userId` 与实际状态一致
  - **启停禁自我操作**:currentUser 绑定的 User 恰是被操作对象时拒绝(镜像 `assertNotSelf`)
  - **禁用即撤销 refresh**:启停置 DISABLED 后,该 User 既有 refresh token 全部 `revokedAt` 非空
  - **MVP 既有 e2e 唯一变更点**:`members-account-grant.e2e-spec.ts` 原"队员的绑定 User 已被软删 → 仍 MEMBER_HAS_LINKED_USER"断言翻转为"→ 可重新开号成功"(D-2 直接后果);其余 18 例逐字不变
- **Batch PR**:混合成功/失败批(部分 memberId 不存在、部分已有账号、部分手机号冲突、部分成功)→ 断言逐行结果 + 上限 + 不因单行失败影响其余行(独立事务证据:失败行之后的行仍能成功)。

---

## 4. 端点契约

| # | method + path | 权限码 | 请求体 | 响应 | 新增/复用 BizCode |
|---|---|---|---|---|---|
| 0(改) | `POST members/:id/account` | `member.grant.account` | `GrantMemberAccountDto{phone}` | `GrantMemberAccountResponseDto`(不变) | existingLink 仅查 live;其余逐字不变 |
| 1 | `POST members/:id/account/bind` | `member.bind.account` | `{userId: string}` | `MemberResponseDto` | `MEMBER_NOT_FOUND`/`MEMBER_INACTIVE`/`MEMBER_HAS_LINKED_USER`/`USER_NOT_FOUND`/**15032** |
| 2 | `POST members/:id/account/unbind` | `member.bind.account` | 空 | `MemberResponseDto` | `MEMBER_NOT_FOUND`/**15033** |
| 3 | `POST members/:id/account/reopen` | `member.grant.account` | `GrantMemberAccountDto{phone}`(新手机号) | `GrantMemberAccountResponseDto` | `MEMBER_NOT_FOUND`/`MEMBER_INACTIVE`/**15033**/`USERNAME_ALREADY_EXISTS`(理论不可达,防御性保留)/`PHONE_ALREADY_BOUND` |
| 4 | `PATCH members/:id/account/status` | `user.update.status` | `UpdateMemberAccountStatusDto{status: UserStatus}` | `MemberResponseDto` | `MEMBER_NOT_FOUND`/**15033**/`CANNOT_OPERATE_SELF`(禁自我操作,复用既有码) |
| 5 | `POST members/accounts/bulk-grant` | `member.grant.account` | `BulkGrantMemberAccountsDto{items:[{memberId,phone}], ≤200}` | `BulkGrantMemberAccountsResponseDto{items:[{memberId,status:'ok'|'blocked',userId?,reason?}], summary}` | 逐行复用 grant 全部既有码,`status:'blocked'` 不抛异常 |

新增 DTO(members.dto.ts 内追加,不新建文件):`BindMemberAccountDto`、`UpdateMemberAccountStatusDto`、`BulkGrantMemberAccountsDto`/`BulkGrantMemberAccountsResponseDto`/`BulkGrantAccountItemDto`。`reopen` 复用现有 `GrantMemberAccountDto`/`GrantMemberAccountResponseDto`,零新 DTO。

路由注册顺序:`accounts/bulk-grant` 必须先于 `@Get(':id')`/`@Patch(':id')`/`@Delete(':id')` 声明(E-12)。

---

## 5. 校验顺序冻结

**bind**:① member 存在且未软删 → `MEMBER_NOT_FOUND` ② member ACTIVE → `MEMBER_INACTIVE` ③ member 无 live 账号(`existingLink` 同 grant 口径,仅 live)→ 否则 `MEMBER_HAS_LINKED_USER` ④ 目标 `userId` 存在且未软删 → 否则 `USER_NOT_FOUND` ⑤ 目标 `memberId === null` → 否则 **15032** ⑥ `tx.user.update({where:{id:userId}, data:{memberId}})`(P2002 兜底同 grant 口径)⑦ audit `member.account-bound`。

**unbind**:① member 存在且未软删 → `MEMBER_NOT_FOUND` ② member 有 live 账号 → 否则 **15033** ③ `tx.user.update({data:{memberId:null}})` ④ audit `member.account-unbound`(extra 记录断链前 userId)。

**reopen**:① member 存在且未软删 → `MEMBER_NOT_FOUND` ② member ACTIVE → `MEMBER_INACTIVE` ③ member 有 live 账号 → 否则 **15033**(提示"无账号可重开,请用开号") ④ 新 username 计算(`${memberNo}-${generation}`,事务内 count 含软删)⑤ username 唯一性预检查(理论恒过,防御性保留,沿 grant 同款 `findUnique`)⑥ phone 唯一性预检查(含软删,与旧号相同手机号会在此命中 `PHONE_ALREADY_BOUND`,E-8 确认为有意)⑦ 单事务:软删旧行(`deletedAt`+`status=DISABLED`)+ 创建新行(P2002 兜底同 grant)⑧ audit `member.account-reopened`。

**status(队员面启停)**:① member 存在且未软删 → `MEMBER_NOT_FOUND` ② member 有 live 账号 → 否则 **15033** ③ `assertNotSelf` 等价检查(`currentUser.id === linkedUser.id`→ 拒绝,复用 `CANNOT_OPERATE_SELF` 或等价)④ `tx.user.update({data:{status}})` ⑤ 若目标 `status===DISABLED`:撤销该 user 全部未撤销未过期 refresh token(镜像 `UsersService.updateStatus`)⑥ 不写 audit(E-9)。

**bulk-grant**(逐行,行内顺序同 grant 五步):循环体 `try { await this.grantAccountCore(...); push ok } catch (err) { if (!(err instanceof BizException)) throw err; push blocked+reason }`;每行各自独立事务(E-10),批量上限 200,超限直接 400。

---

## 6. v1 既有行为/测试变更清单

| 位置 | 变更前 | 变更后 | 理由 |
|---|---|---|---|
| `members.service.ts` grantAccount 的 existingLink 预检查 | `tx.user.findFirst({where:{memberId:id}})`(含软删) | `tx.user.findFirst({where:{memberId:id, deletedAt:null}})`(仅 live) | D-2,goal 唯一授权的行为变更 |
| `members-account-grant.e2e-spec.ts`"队员的绑定 User 已被软删...仍 MEMBER_HAS_LINKED_USER" | 断言仍拒绝 | 断言改为**可重新开号成功**(201) | D-2 直接后果,测试名同步改为"...软删后 → 可重新开号" |
| `runWithUniqueConstraintGuard` memberId 分支 | `if (target.includes('memberId'))` | `if (target.includes('memberId') \|\| target.includes('User_memberId_active_key'))` | E-4,纯加宽匹配条件,不影响任何既有断言(mock 测试 `p2002(['memberId'])` 依旧命中第一支) |
| `findLinkedUser`/`loadLinkedUsersByMemberIds` | `where:{memberId}` | `where:{memberId, deletedAt:null}` | E-6,reopen 落地后需要 |
| 权限码/BizCode/schema 计数类文档(current-state/RBAC_MAP/CHANGELOG) | 196/95/321/39 | 197/96/326/40(bulk-grant+status+bind+unbind+reopen 共 +5 路由;实施 PR 内以实测 true-up) | 例行 true-up,非既有行为变更 |

**`src/modules/auth/**` 零 diff**——本次改动全部在 `members.service.ts`/`members.controller.ts`/`members.dto.ts`/`prisma/schema.prisma`/`prisma/migrations/`/`prisma/seed.ts`;`login-sms`/`createSession`/`password-reset`/JwtStrategy 均未涉及,既有 auth e2e 逐字不变。

---

## 7. PR 切分与实施顺序

1. **Schema PR**(D 档):migration + schema.prisma + E-4 守卫加固 + 真实并发 e2e。零 API 行为变化,可独立安全发布。
2. **Endpoint PR**(D 档,因含权限码/BizCode/schema-adjacent 行为变更):D-2 existingLink 松绑 + bind/unbind/reopen/status 四端点 + E-6 两面回显查询修复 + E-7 username 后缀处理 + 新 BizCode ×2 + 新权限码 ×1 + 新 audit ×3 + 完整生命周期 e2e + MVP 既有 e2e 唯一断言调整。
3. **Batch PR**(D 档或 C 档视 runner 判断):E-11 提取 `grantAccountCore` + bulk-grant 端点 + 批量 e2e。
4. **Docs PR**(A 档):current-state §1/§2/§3、CHANGELOG、`handoff/admin-web.md` §2.4 扩展、RBAC_MAP、NEXT_TASKS 关 P1-18。

每刀独立 lint/typecheck/unit/contract/e2e 全绿方可推进下一刀;四数(权限码/路由/controller/migration)每刀 true-up。

---

## 8. 验证计划(各 PR 内自证,不在本稿执行)

- `pnpm agent:check:full`(lint + typecheck + unit + contract + build + e2e 全量)
- Schema PR:39/40 干净库重放 + seed 幂等二跑 + `prisma migrate status` 零 drift
- Endpoint/Batch PR:`docs:rbacmap:check`(197)/ `docs:codemap:check` 0 FAIL
- 全程:`src/modules/auth/**` 零 diff(`git diff --stat` 自证)
