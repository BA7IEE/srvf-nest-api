# P0-D 本人自助改密评审稿(PR-1 评审稿,非执行稿)

> **回填注(2026-05-17 / v0.13.0)**:本评审稿的结论**已通过 PR #115 / #116 / #117 / #118 落地**(`PUT /api/users/me/password` + 新增 BizCode `OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006` + `@PasswordChangeThrottle` 5 次/60 秒 + audit event `password.change.self`),**已随 v0.13.0 发布**(2026-05-17T08:08:36Z)。**当前实现以代码、[`security.md`](security.md)、first-release 系列([readiness-plan](first-release-readiness-plan.md) / [bizcode-mapping](first-release-bizcode-mapping.md))与 [`docs/handoff/v0.13.0.md`](handoff/v0.13.0.md) §4 为准**。**本评审稿保留作历史评审快照,不再表示"待实施"**;下方"D 档前置评审稿 / 待 PR-2 / PR-3 / PR-4 落地"等表述是评审定稿时刻的阶段状态。

> **状态**:**D 档前置评审稿,非执行稿**。
> 本文档**不是**代码实现说明,**不是**铁律修订(铁律修订归 PR-2)。
> 本文档只用于**冻结 P0-D 本人自助改密的设计决策**,供后续 PR-2 / PR-3 / PR-4 严格按本评审稿落地。
>
> **冲突优先级**(沿 [`process.md §6`](process.md)):`ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > `docs/srvf-foundation-baseline.md` > `docs/V2红线与复活路径.md` > **本评审稿** > handoff > `current-state.md` > `process.md`。冲突时本评审稿让步。
>
> **不在本文范围**:接口字段细节(回 [`v2-api-contract.md`](v2-api-contract.md));BizCode 全量翻译(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md));前端联调范围调整(归 PR-4);现有 readiness-plan / frontend-scope / bootstrap-sop / bizcode-mapping 的回填(归 PR-4);代码落地细节(归 PR-3 实施稿);CLAUDE.md / AGENTS.md 铁律修订(归 PR-2)。

---

## §0 用途与定位

### 0.1 解决什么问题

第一版前端联调起步包准备就绪([P0-A](first-release-frontend-scope.md) / [P0-G](first-release-bizcode-mapping.md) / [P0-C](first-release-bootstrap-sop.md) 已落地),但第一版上线后**没有任何"本人自助改密"路径**。带来三个具体痛点:

1. seed 创建的默认 `SUPER_ADMIN` 口令(`.env.example` 默认 `ChangeMe123456`)上线后无法在线改;运维要么重跑 seed、要么走"自己改自己"的曲径(详见 §1.3)。
2. 真实 `ADMIN` 账号建立后,改密只能找 `SUPER_ADMIN` 帮忙重置(自助路径完全为零)。
3. 普通队员账号(`USER`)交付时口令由管理员设;队员无任何自助改密路径。

P0-D 的最小目标:让任意登录用户都能在线改自己的密码,**且不破** v1 已建立的安全模型。

### 0.2 本评审稿的边界

- 本评审稿**只**讨论"本人自助改密"。
- 本评审稿**不**讨论 refresh token / logout / tokenVersion(归 P0-E)、RBAC 收紧(归 P0-F)、上传下载闭环(归 P0-B)。
- 本评审稿**不**改任何运行时代码 / schema / migration / seed / 测试 / OpenAPI snapshot。
- 本评审稿**不**改 readiness-plan / frontend-scope / bizcode-mapping / bootstrap-sop / current-state(这些状态回填归 PR-4)。
- 本评审稿**不**改 `CLAUDE.md` / `AGENTS.md`(铁律修订归 PR-2)。

### 0.3 谁要拍板

`§5` 安全规则 / `§8` PR 拆分 / `§9` 代码 PR 前复核点 中的每一项,**用户必须显式拍板**才能进入 PR-2。任一项未冻结即视为本评审稿未完成。

---

## §1 当前事实盘点

> 本节只列与 P0-D 直接相关的事实,**不**展开 user ↔ member 绑定缺口(那是已识别的另一接口缺口,见 [`bootstrap-sop §9.3`](first-release-bootstrap-sop.md),与本评审无关)。

### 1.1 已有能力

| 能力 | 接口 | 鉴权 | 关键约束 |
|---|---|---|---|
| 登录 | `POST /api/auth/login` | `@Public()` | username + password(memberNo 兜底);防账号枚举四场景统一 `LOGIN_FAILED=10004`;timing 抹平;IP 5次/60秒 内存限流 |
| 本人资料读 | `GET /api/users/me` | 任意登录用户 | 返回 `UserResponseDto`(永不含 `passwordHash`) |
| 本人资料改 | `PATCH /api/users/me` | 任意登录用户 | `UpdateMyProfileDto` **严格白名单**只接受 `nickname` / `avatarKey`;`forbidNonWhitelisted` 兜底 |
| 管理员重置他人密码 | `PUT /api/users/:id/password` | `@Roles(SUPER_ADMIN, ADMIN)` + Service 层 `assertCanManageUser` | `ResetUserPasswordDto { newPassword }`,**无需 `oldPassword`**;落库前 `bcrypt.hash` |
| 密码 hash | service 内部 | — | `bcryptjs` salt rounds 固定 10 |
| 出参屏蔽 | `userSafeSelect` | — | 永不含 `passwordHash` / `deletedAt` |

### 1.2 明确不存在的能力

- **本人自助改密**:无任何接口接受 `oldPassword + newPassword` 的本人改密路径。
- **首次登录强制改密**:无任何 schema 字段 / 流程标识。
- **忘记密码 / 邮箱找回**:无 reset_token 表 / 无邮件 Provider。
- **改密后吊销旧 token**:沿 [`security.md` Token 吊销升级路径](security.md),v1 / V1.1 / V2 至今均明文不做。

### 1.3 现有"管理员重置"接口的副作用边界

为避免后续 PR 误踩,本评审稿明确记录两条**当前事实**,但**不要求本轮改动**:

1. **`SUPER_ADMIN` 可通过 `PUT /api/users/:id/password` 给自己改密**:`assertCanManageUser(SUPER_ADMIN, SUPER_ADMIN)` 为 true,且 `resetPassword` service 层未 `assertNotSelf`。这是 v1 §13 "SUPER_ADMIN 互操作"的副作用,**不是 bug**;P0-D 落地后,推荐统一走 `PUT /api/users/me/password`,但该曲径**不删**。
2. **`ADMIN` 无法通过任何现有接口改自己密码**:`PATCH /me` 不接受 `password`;`PUT /:id/password` 走 `assertCanManageUser` 时 `ADMIN→ADMIN` 被 `FORBIDDEN_ROLE_OPERATION` 拦截。P0-D 落地后该缺口自动消解。
3. **管理员重置后旧 token 不主动吊销**:现状,沿 [`security.md`](security.md);第一版**继续保留**,归 P0-E 评估。本评审稿**不动**该行为。

---

## §2 文档偏差修正(本 PR 不动,留 PR-4)

[`first-release-readiness-plan.md §3.1 P0-D`](first-release-readiness-plan.md) 当前措辞写"当前没有任何'改密码'接口(包括管理员和本人)"。**这与代码事实不符**,准确说法应为:

> **当前已有"管理员重置他人密码"接口(`PUT /api/users/:id/password`),但没有任何形式的"本人自助改密"路径**。

修正动作:

- 本 PR(PR-1)**不动** readiness-plan,只在本评审稿记录偏差。
- PR-4 在 P0-D 状态回填时,顺手把 readiness-plan §3.1 P0-D 措辞改成事实准确版本。

---

## §3 本轮 P0-D 推荐范围

### 3.1 接口形态(候选,§5 拍板后定)

```
PUT /api/users/me/password
  入参: ChangeMyPasswordDto { oldPassword, newPassword }
  出参: 沿现有 UserResponseDto(永不含 passwordHash);
        或代码 PR(PR-3)阶段按一致性需要再定,二选其一,但禁止任何包含 passwordHash 的形态。
  鉴权: 任意登录用户(USER+ / ADMIN / SUPER_ADMIN 均可);
        controller 不标 @Roles,沿 GET/PATCH /me 范式。
```

### 3.2 行为约束

- **`oldPassword` 必填**:与"管理员重置(无 `oldPassword`)"行为对称区分。
- **`newPassword` 必填**:DTO 校验沿 `ResetUserPasswordDto.newPassword` 范式(至少 8 位 + 含字母 + 含数字,详见 §5)。
- **`oldPassword` 错误 → 新错误码 `OLD_PASSWORD_INVALID=10005`**(详见 §5)。
- **`newPassword === oldPassword` → 新错误码 `NEW_PASSWORD_SAME_AS_OLD=10006`**(详见 §5)。
- **改密成功后旧 token 不主动吊销**(沿 §1.3 / [`security.md`](security.md);归 P0-E)。
- **`ADMIN` / `SUPER_ADMIN` 改自己密码也统一走该接口**;不再依赖 §1.3 的曲径(曲径保留,但前端文档不引导)。

### 3.3 与现有约束的一致性

- 落库前 `bcrypt.hash`(沿 v1 §9 / [users.service](../src/modules/users/users.service.ts))。
- salt rounds 沿现有常量(`BCRYPT_SALT_ROUNDS=10`),**不**因新接口单独配置。
- 响应通过 `userSafeSelect` 排除 `passwordHash`,沿现有出参屏蔽。
- 不在 `PATCH /api/users/me` 资料接口里夹带改密(沿 v1 §9 "不要在其他接口里夹带'顺手改密码'逻辑")。
- BizCode 复用 `LOGIN_FAILED` / `BAD_REQUEST` / `TOO_MANY_REQUESTS` 等通用码的位置,均按 §5 锁死。

---

## §4 明确不做范围(防 AI 顺手做)

第一版 P0-D **仅做** §3 推荐范围;以下任一项,本轮 PR-3 代码实现**禁止**夹带:

- ❌ **不**改已有 `PUT /api/users/:id/password`(管理员重置)接口的任何字段 / 鉴权 / 行为 / 错误码
- ❌ **不**做"首次登录强制改密"(归 P1;需 schema 字段与登录流程改造)
- ❌ **不**做"忘记密码 / 邮箱找回"(归 P2;需 reset_token 表 + 邮件 Provider)
- ❌ **不**做 refresh token / logout(归 P0-E 评审)
- ❌ **不**做 tokenVersion(归 P0-E 评审;沿 [`security.md` Token 吊销升级路径](security.md))
- ❌ **不**主动吊销旧 token(沿 v1 §9;归 P0-E)
- ❌ **不**把改密字段塞进 `PATCH /api/users/me`(沿 v1 §9 / `UpdateMyProfileDto` 严格白名单)
- ❌ **不**新增 user ↔ member 绑定能力(那是 [`bootstrap-sop §9.3`](first-release-bootstrap-sop.md) 已识别的另一接口缺口,与本评审无关)
- ❌ **不**启动 P0-E refresh token / P0-B 上传下载 / P0-F RBAC 收紧 任何相关代码改动
- ❌ **不**修改 readiness-plan / frontend-scope / bizcode-mapping / bootstrap-sop / current-state(归 PR-4)
- ❌ **不**修改 `prisma/schema.prisma`(本评审范围内零 schema 变更)
- ❌ **不**新建任何 module / 文件 / 目录(沿现 `auth/` + `users/` 双模块边界)
- ❌ **不**新建 `*.entity.ts` / `*.enum.ts` / 公共目录(沿 v1 §2)
- ❌ **不**为改密单建 `*.config.ts`,限流参数归 `app.config.ts`(沿 v1 §14)

---

## §5 安全规则(详细,代码 PR 必须严格遵循)

### 5.1 入参 DTO

| 字段 | 校验 | 校验失败错误码 |
|---|---|---|
| `oldPassword` | `@IsString` + `@IsNotEmpty`;**不**做长度 / 字母 / 数字校验(原因:登录侧 `LoginDto.password` 同样不做,防泄漏密码强度规则) | `BAD_REQUEST=40000`(`forbidNonWhitelisted` / `class-validator` 兜底) |
| `newPassword` | 与 `ResetUserPasswordDto.newPassword` **完全一致**:`@MinLength(8)` + `@MaxLength(128)` + `@Matches(/^(?=.*[a-zA-Z])(?=.*\d).+$/)` | `BAD_REQUEST=40000` |
| 其他字段 | 严格白名单只 `oldPassword + newPassword`;额外字段被全局 `forbidNonWhitelisted: true` 拒绝 | `BAD_REQUEST=40000`,message 含字段名 |

### 5.2 业务流程

1. 取 `currentUser`(已通过 `JwtAuthGuard` + `JwtStrategy.validate`)。
2. 重新查库拿当前 `passwordHash`(防极端 race;走 `findFirst + notDeletedWhere`,找不到统一抛 `USER_NOT_FOUND=10001` 沿 v1 §10)。
3. `bcrypt.compare(dto.oldPassword, user.passwordHash)`。失败 → 抛 `OLD_PASSWORD_INVALID=10005`。
4. **本进程内** `dto.oldPassword === dto.newPassword` 比较;相同 → 抛 `NEW_PASSWORD_SAME_AS_OLD=10006`。
   - 比较时机:在 `bcrypt.compare` 通过后比较;**不**用 `bcrypt.compare(dto.newPassword, user.passwordHash)`(避免触发"新密码恰好与历史某次相同"的额外语义)。
   - 严格字符串 `===` 比较,**不**做 `trim` / `toLowerCase`(密码大小写敏感、空白显著)。
5. `bcrypt.hash(dto.newPassword, BCRYPT_SALT_ROUNDS)` → `user.update({ passwordHash })`。
6. 写 audit log:`AuditLogEvent.UserPasswordChangedSelf`(命名风格代码 PR 前与现有 17 项事件对齐,见 §9)。
7. 返回 `UserResponseDto`(沿 `userSafeSelect`,永不含 `passwordHash`)。

### 5.3 新增 BizCode(段位归属与冲突复核)

| BizCode | code | message | httpStatus | 段位归属 |
|---|---|---|---|---|
| `OLD_PASSWORD_INVALID` | **10005** | `当前密码不正确` | 401 (`UNAUTHORIZED`) | 沿 v1 §5 BizCode 编码段:`100xx` 为 users 模块业务级,已用 10001-10004(`USER_NOT_FOUND` / `USERNAME_ALREADY_EXISTS` / `EMAIL_ALREADY_EXISTS` / `LOGIN_FAILED`);10005 为下一可用号位。**代码 PR 前再次复核**(§9)。 |
| `NEW_PASSWORD_SAME_AS_OLD` | **10006** | `新密码不能与当前密码相同` | 400 (`BAD_REQUEST`) | 同上,10006 为再下一可用号位。**代码 PR 前再次复核**(§9)。 |

设计取舍:

- **为什么 `OLD_PASSWORD_INVALID` 不复用 `LOGIN_FAILED=10004`?**
  - `LOGIN_FAILED` 的"防账号枚举四场景"语义只在登录路径成立(未登录态下不能区分原因);本接口在已登录态,`currentUser` 已知,**无账号枚举攻击面**,前端拿到精确错误码可给"当前密码错"的明确提示,比"账号或密码错误"对已登录用户更有意义。
- **为什么 `NEW_PASSWORD_SAME_AS_OLD` 不复用 `BAD_REQUEST=40000`?**
  - `BAD_REQUEST` 是 DTO 校验兜底;"新旧密码相同"是业务级语义校验,前端展示文案与一般 DTO 错误不同,值得独立码位。

### 5.4 防爆破(限流)

- **第一版参数**:5 次 / 60 秒,**IP 维度**(沿 V1.1 §11.4 / `@LoginThrottle` 设计;字段名归 `app.config.ts`)。
- **装饰器形态**:新增 `@PasswordChangeThrottle()`,内部使用与 `@LoginThrottle` 同款 throttler 机制;**禁止**直接在 controller 上叠 `@LoginThrottle()`(语义混淆)。
- **超限错误码**:沿现有 `TOO_MANY_REQUESTS=42900`,message `请求过于频繁，请稍后再试`,**不**暴露阈值数字 / 剩余配额 / 重置时间 / `Retry-After` 头(沿 V1.1 §17.7)。
- **未来升级路径**:第一版 IP 维度足够;若出现"同 IP 多账号被反复爆破 oldPassword"风险,**单独立项**升级为 `user + IP` 组合维度,**本评审不预实现**。
- **storage**:沿 V1.1 `@nestjs/throttler` 内存 storage,**禁止** Redis storage(沿 V1.1 §17.2)。

### 5.5 timing 防御

- 登录侧的"username 不存在仍跑 dummy bcrypt"防御不适用本接口(已登录态,`currentUser` 已知,无账号枚举攻击面)。
- 但 `bcrypt.compare(dto.oldPassword, ...)` 必须**完整跑完**,**禁止** "先比对 `oldPassword === newPassword` 跳过 bcrypt"的优化(避免泄漏"`newPassword` 与 `oldPassword` 是否相同"信息)。
- 实施顺序固定为 §5.2 的 1→2→3→4→5,**不得**调换 3 与 4。

### 5.6 audit 写入

- 事件名候选:`AuditLogEvent.UserPasswordChangedSelf`(命名风格代码 PR 前与现有 17 项事件**逐字对齐**,见 §9 复核点 #1)。
- 写入字段:遵循现有 `audit_logs` 写路径范式(actorUserId / eventType / 资源标识 / 时间);**禁止**写入 `oldPassword` / `newPassword` / `passwordHash` 任何明文或 hash。
- 写入失败处理:沿现有 audit 写入路径范式;**禁止**为"audit 失败回滚业务事务"另设特别策略(沿 v1 / V2 现有行为)。

### 5.7 token 行为(锁死现状)

- 改密成功**不主动吊销**旧 token;`JwtStrategy.validate` 不读 `passwordHash`,只看 `deletedAt` + `status===ACTIVE`,密码 hash 变化不影响已签发 token。
- 这是 v1 §9 / [`security.md` Token 吊销升级路径](security.md) 的**有意决策**;P0-D **继续保留**,归 P0-E 评估。
- 该行为必须在 §7 验收用例中**显式锁定**(详见 §7 / §9 复核点 #2)。

---

## §6 API / DTO / service / test / OpenAPI 影响清单

| 维度 | 改动 | 备注 |
|---|---|---|
| `prisma/schema.prisma` | **零变更** | 沿现有 `User.passwordHash` |
| `prisma/migrations/*` | **零变更** | — |
| `prisma/seed.ts` | **零变更** | — |
| `src/modules/users/users.dto.ts` | 新增 `ChangeMyPasswordDto` | 沿 `ResetUserPasswordDto` 范式;严格白名单 `oldPassword + newPassword` |
| `src/modules/users/users.controller.ts` | 新增 `PUT /me/password` 方法 | 放在 `/me` 段(`GET /me` 与 `PATCH /me` 之间);沿现有 Swagger 装饰器风格(`@ApiOperation` / `@ApiWrappedOkResponse(UserResponseDto)` / `@ApiBizErrorResponse(...)`);**禁止**裸 `@ApiOkResponse`(沿 v1 §6) |
| `src/modules/users/users.service.ts` | 新增 `changeMyPassword` 方法 | 沿 `resetPassword` 范式;**不**复用 `resetPassword`(语义不同:本接口需 `oldPassword` 校验);沿 helpers `findByIdOrThrow` / `hashPassword` |
| `src/common/exceptions/biz-code.constant.ts` | 新增 2 条:`OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006` | 沿 100xx users 段;§5.3 已锁定文案 / httpStatus / 归属注释 |
| `src/modules/audit-logs/*`(或 `audit-logs.events.ts` 等价位置) | 新增 `AuditLogEvent.UserPasswordChangedSelf` | 命名风格代码 PR 前与既有 17 项事件**逐字对齐**(§9 复核点 #1) |
| `src/common/decorators/*` 或限流装饰器位置 | 新增 `@PasswordChangeThrottle()` 装饰器 | 沿 `@LoginThrottle` 实现风格;限流参数从 `app.config.ts` 注入,**不**硬编码(沿 V1.1 §17.7) |
| `src/config/app.config.ts` | 新增 2 个字段:`PASSWORD_CHANGE_THROTTLE_LIMIT` / `PASSWORD_CHANGE_THROTTLE_TTL_SECONDS`(命名沿 `LOGIN_THROTTLE_*`);启动强校验加 2 行 | 默认值 5 / 60(§5.4);`.env.example` 同步加 2 行注释 |
| `test/e2e/users-change-my-password.e2e-spec.ts` | 新增 | 验收用例详见 §7 |
| `test/e2e/users-me.e2e-spec.ts` | **零变更** | 该 spec 的 `FORBIDDEN_FIELDS` 反向断言锁的是 `PATCH /me`,与新增的 `PUT /me/password` 路径不冲突 |
| `test/e2e/users-password-reset.e2e-spec.ts` | **零变更** | 该 spec 锁的是 `PUT /:id/password`,与本评审不重叠 |
| OpenAPI snapshot | 增量 diff(新增 1 路由 / 1 DTO / 2 BizCode 出现在错误码字段)| 代码 PR(PR-3)阶段更新 |
| `docs/v2-api-contract.md` | 增量 1 段说明(若 v1 段有"users 接口清单",同步加 1 行)| PR-3 或 PR-4 阶段同步,不在本评审稿强制 |

---

## §7 验收标准(代码 PR 必须全部覆盖)

E2E 文件:`test/e2e/users-change-my-password.e2e-spec.ts`(目标用例数 10-15)。

### 7.1 核心成功路径

- [ ] **改密成功**:`USER` 登录,`PUT /me/password { oldPassword: <原>, newPassword: <新> }` → HTTP 200 + `code: 0` + 响应 `data.id === currentUser.id`,**响应永不含 `passwordHash`**(字段集断言 + 反向 `not.toHaveProperty('passwordHash')`)。
- [ ] **改密后旧密码不能登录**:改密后,用原密码调 `POST /api/auth/login` → `LOGIN_FAILED=10004` + HTTP 401。
- [ ] **改密后新密码可以登录**:改密后,用新密码调 `POST /api/auth/login` → HTTP 200 + 返回新 `accessToken`。

### 7.2 错误码

- [ ] **`oldPassword` 错误** → `OLD_PASSWORD_INVALID=10005` + HTTP 401(沿 §5.3)。
- [ ] **`newPassword === oldPassword`** → `NEW_PASSWORD_SAME_AS_OLD=10006` + HTTP 400(沿 §5.3)。
- [ ] **`newPassword` 弱(<8 / 纯字母 / 纯数字)** → `BAD_REQUEST=40000` + HTTP 400 + message 含 `password` 关键词(沿 `ResetUserPasswordDto` 范式)。
- [ ] **缺 `oldPassword`** → `BAD_REQUEST=40000` + HTTP 400 + message 含 `oldPassword`。
- [ ] **缺 `newPassword`** → `BAD_REQUEST=40000` + HTTP 400 + message 含 `newPassword`。
- [ ] **额外字段(如传 `passwordHash` / `role` / `status` 等)** → `BAD_REQUEST=40000` + HTTP 400 + message 含字段名(`forbidNonWhitelisted` 兜底)。

### 7.3 鉴权与跨角色

- [ ] **未登录访问** → `UNAUTHORIZED=40100` + HTTP 401。
- [ ] **`SUPER_ADMIN` 走 `PUT /me/password`** → 成功;新密码登录有效。
- [ ] **`ADMIN` 走 `PUT /me/password`** → 成功(填补 §1.3 缺口)。

### 7.4 限流

- [ ] **限流命中** → `TOO_MANY_REQUESTS=42900` + HTTP 429 + 响应**不含** `Retry-After` / `X-RateLimit-*`(沿 V1.1 §17.7);用 §5.4 参数(5 次 / 60 秒)在测试中通过 `app.config.ts` 注入或测试夹具显式覆盖,**禁止**硬编码。

### 7.5 token 行为锁定(反向断言)

- [ ] **改密后旧 token 仍有效**:改密前用旧 token 调 `GET /me` → 200;改密后用同一旧 token 调 `GET /me` → **仍 200**(沿 §5.7 / [`users-password-reset.e2e-spec.ts:154`](../test/e2e/users-password-reset.e2e-spec.ts:154) 已有的"反向锁定"范式)。
  - 此用例的作用:**v1 故意不吊销旧 token**;未来若有人"顺手加吊销 token 逻辑",此用例会立刻挂,逼回头先改 [`security.md`](security.md) 与本评审稿。

### 7.6 audit

- [ ] **改密成功后 audit log 写入**:断言 `audit_logs` 表新增 1 条 `eventType === 'UserPasswordChangedSelf'` + `actorUserId === currentUser.id`(具体字段断言代码 PR 前对齐既有 17 项事件,见 §9 复核点 #1)。
- [ ] **audit 字段不含敏感字段**:断言写入的 audit 记录**不含** `oldPassword` / `newPassword` / `passwordHash` 任何明文或 hash 子串。

### 7.7 数据库状态

- [ ] **`passwordHash` 已改变**:改密前后 `prisma.user.findUnique` 拿到的 `passwordHash` 字符串不相等。
- [ ] **`lastLoginAt` 不变**:改密**不**顺手刷 `lastLoginAt`(沿 §3.3 / 仅登录路径更新)。
- [ ] **`updatedAt` 改变**:Prisma `@updatedAt` 自动更新,本评审不预定义额外断言。

---

## §8 PR 拆分(强串行,不并发)

| # | PR 标题(建议) | 档位 | 范围 | 前置 | 验收 |
|---|---|---|---|---|---|
| **PR-1** | `docs(review): change-my-password review`(**本 PR**)| **A 档 docs-only** | 仅新增本评审稿文件 1 个 | 无 | 用户对 §5 / §8 / §9 全部决策点拍板,本评审稿冻结 |
| PR-2 | `docs(claude): allow self-service password change` | A 档 docs-only | 修订 `CLAUDE.md §1 + §9` / `AGENTS.md §1 + §9`:把"v1 不实现本人改密码接口 `PUT /api/users/me/password`"明文升级为"v1 已开放本人自助改密,铁律见 §9"+ 同步 §9 密码处理铁律表行新增"`PUT /api/users/me/password` 接收 `ChangeMyPasswordDto { oldPassword, newPassword }`,**需 oldPassword**,走 audit + 限流" | PR-1 已 merged | 文档前后一致;`pnpm lint` 仍通过(docs-only 无运行时影响) |
| PR-3 | `feat(users): add change my password` | **D 档代码** | 严格按本评审稿 §3 / §5 / §6 实施;严格不夹带 §4 任一项 | PR-2 已 merged | A+B 档双门槛(沿 V1.1 §17.10);§7 验收用例全部 ✅;`pnpm lint` / `pnpm typecheck` / `pnpm test:e2e` / `pnpm test:contract` 全部通过 |
| PR-4 | `docs(first-release): backfill P0-D status` | A 档 docs-only | 1) [`readiness-plan §3.1 P0-D`](first-release-readiness-plan.md) 状态从"待立项"改"✅";顺手修 §2 偏差措辞<br/>2) [`frontend-scope §4`](first-release-frontend-scope.md) 起步包加 `PUT /me/password` 1 条(50 → 51);同步 §11 联调包齐备清单<br/>3) [`bizcode-mapping`](first-release-bizcode-mapping.md) 加 `OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006` 两条<br/>4) [`bootstrap-sop §9.5`](first-release-bootstrap-sop.md) 加"默认 SUPER_ADMIN 密码自助改密 SOP"段<br/>5) [`current-state §2`](current-state.md) 加 1 行能力清单<br/>6) [`security.md` 已落地策略表](security.md) 加 1 行 | PR-3 已 merged | 跨文档一致;不夹带 src / schema / 测试 |

**铁律**:

- **PR 之间强串行**,不并发(沿 [`process.md §4`](process.md))。
- **PR-3 严禁夹带 §4 任一项**;发现越权立刻打回重做。
- **PR-3 不动 release / tag / version**;不进入 release 收口阶段。
- **不**触发 [`ARCHITECTURE.md §9`](../ARCHITECTURE.md) 升级路径;refresh token / tokenVersion 仍归 P0-E。

---

## §9 代码 PR 前复核点(PR-3 启动前必须再次确认)

PR-3 启动前,以下 **4 项**必须做一次只读复核(沿 [`process.md §4`](process.md) D 档降速流程):

### 9.1 现有 `AuditLogEvent` 命名风格逐字对齐

- 用 grep 取既有 17 项 `AuditLogEvent` 取值,确认本评审拟新增的 `UserPasswordChangedSelf`:
  - 命名是 `PascalCase` 还是 `SCREAMING_SNAKE`?
  - 主语是动词在前(`PasswordChangedSelf`)还是资源在前(`UserPasswordChanged`)?
  - 是否包含"Self"后缀以区分管理员重置(若已有 `UserPasswordReset` / `UserPasswordResetByAdmin` 等,本字段应取与其对称的命名)?
- 若现有命名风格与本评审拟用名不一致,**以现有风格为准**修订本评审稿(本节是允许的小修订,不算决策点变化)。

### 9.2 现有 Throttler 装饰器复用方式

- 用 grep 看 `@LoginThrottle()` 装饰器实现位置 / 参数注入方式 / 是否依赖 `app.config.ts` 字段命名约定。
- 决定:
  - **方案 A**(推荐):新建 `@PasswordChangeThrottle()` 装饰器,复用 `@LoginThrottle` 的内部 throttler 机制,仅参数源不同。
  - **方案 B**(备选):将 `@LoginThrottle` 参数化为 `@Throttle({ name: 'login' | 'password-change' })`。
- **方案 A 改动更小,推荐**;方案 B 需评估对既有 `@LoginThrottle` 调用点的兼容影响,不在本评审稿强制。

### 9.3 现有 OpenAPI error 装饰器风格

- 用 grep 看 `@ApiBizErrorResponse(...)` 在管理员重置接口 / 登录接口的具体写法。
- 本评审拟用形态:`@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.OLD_PASSWORD_INVALID, BizCode.NEW_PASSWORD_SAME_AS_OLD, BizCode.TOO_MANY_REQUESTS)`。
- 若现有风格有顺序约定 / 排序约定,**以现有风格为准**。

### 9.4 10005 / 10006 与源码现有码位的冲突复核

- 本评审稿 §5.3 已记录"100xx 段已用 10001-10004,10005 / 10006 为下两个可用号位"。
- PR-3 启动前**再次用 grep 确认**:`grep 'code: 1000[5-9]' src/common/exceptions/biz-code.constant.ts` 应无命中(确认本评审稿与 PR-3 之间无第三方 PR 抢号)。
- 若发生抢号,需另起评审稿小修订,**不**自动顺延号位。

---

## §10 不在本文范围 / 引用来源 / 文档元信息

### 10.1 不在本文范围

| 类别 | 权威源 |
|---|---|
| 接口字段详情 / OpenAPI | [`docs/v2-api-contract.md`](v2-api-contract.md) + Swagger `/api/docs` |
| 完整 BizCode 翻译 | [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) |
| 前端联调起步包 50 接口 | [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md) |
| 第一版剩余账本 P0/P1/P2 | [`docs/first-release-readiness-plan.md`](first-release-readiness-plan.md) |
| 从零部署 SOP | [`docs/first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md) |
| 安全策略已落地表 | [`docs/security.md`](security.md) |
| 协作流程 / D 档降速 / PR 拆分 | [`docs/process.md`](process.md) |
| 当前事实 / 风险账单 | [`docs/current-state.md`](current-state.md) |
| Token 吊销升级路径(P0-E 评审依据)| [`docs/security.md`](security.md) Token 吊销升级路径段 |
| RBAC 收紧(P0-F 评审依据)| [`docs/first-release-readiness-plan.md §3.1 P0-F`](first-release-readiness-plan.md) |
| 上传下载闭环(P0-B)| [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md) |

### 10.2 引用来源

- [`README.md`](../README.md)
- [`.env.example`](../.env.example)
- [`CLAUDE.md`](../CLAUDE.md) §1 / §5 / §6 / §8 / §9 / §14 / §17
- [`AGENTS.md`](../AGENTS.md) §1 / §9
- [`docs/process.md`](process.md) §3 / §4 / §6
- [`docs/security.md`](security.md)
- [`docs/current-state.md`](current-state.md)
- [`docs/first-release-readiness-plan.md`](first-release-readiness-plan.md)
- [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md)
- [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)
- [`docs/first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md)
- 源码只读引用(不复制):[`src/modules/auth/auth.service.ts`](../src/modules/auth/auth.service.ts) / [`src/modules/users/users.controller.ts`](../src/modules/users/users.controller.ts) / [`src/modules/users/users.service.ts`](../src/modules/users/users.service.ts) / [`src/modules/users/users.dto.ts`](../src/modules/users/users.dto.ts) / [`src/modules/users/users.policy.ts`](../src/modules/users/users.policy.ts) / [`src/modules/users/users.select.ts`](../src/modules/users/users.select.ts) / [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) / [`test/e2e/users-password-reset.e2e-spec.ts`](../test/e2e/users-password-reset.e2e-spec.ts) / [`test/e2e/users-me.e2e-spec.ts`](../test/e2e/users-me.e2e-spec.ts)

### 10.3 文档元信息

- **状态**:v0.1 草稿(撰写完成,等待用户对 §5 / §8 / §9 拍板)
- **PR 标题建议**:`docs(review): change-my-password review`
- **档位**:**A 档 docs-only**(沿 [`process.md §3`](process.md))
- **本 PR 不夹带**:`CLAUDE.md` / `AGENTS.md` / `src/*` / `prisma/*` / `test/*` / `package.json` / `pnpm-lock.yaml` / OpenAPI snapshots / `.github/workflows/*` / `docs/current-state.md` / `docs/first-release-readiness-plan.md` / `docs/first-release-frontend-scope.md` / `docs/first-release-bizcode-mapping.md` / `docs/first-release-bootstrap-sop.md` / `CHANGELOG.md` / release / tag / version
- **冻结后的修订规则**:本评审稿冻结后(PR-1 merged),**不回改本文**;若 §9 复核点暴露重大冲突,另起 `docs(review): change-my-password review v2` 增量稿,不动 v1 文本(沿 [`process.md §6`](process.md) handoff 不回改范式)

### 10.4 撰写边界声明

- 本评审稿**不引入新事实**;所有引用均来自已合入 main 的代码与文档。
- 本评审稿**不调和**与 readiness-plan 已存在的措辞偏差(§2 仅指出,修正归 PR-4)。
- 本评审稿**不**承诺 PR-3 的具体实现细节(如 service 方法签名、controller 方法名、装饰器命名等);仅锁定行为契约 / 错误码 / 鉴权 / 限流 / audit / 验收用例。代码 PR 在不违反本评审稿的前提下,有最小自由度做实现选择。
