# 《批次8_RBAC_API前评审稿》(D7-RBAC v0.2 局部收口稿)

> **状态**:**v0.2 局部收口稿**(在 v0.1 草稿基础上,2026-05-14 用户在 v0.8.1 handoff §10 启动后 Fast-1 轮**局部收口 5 项**:D12 过渡终止条件 / F5 判权调用方式 / F1 BizCode 段位 / baseline §1.1 段位追加 / `ARCHITECTURE.md` §9 升级路径修订;**其他 20 项决议保持 v0.1 待评审状态**;v1.0 冻结另起 PR)
> **性质**:**D7-RBAC 评审稿**(基于 D6 业务确认稿 13 题 + 4 决议 + 4 处留 D7 细化,落地完整 schema + API + judge 函数 + seed + 集成方案)
> **批次号**:批次 8 暂定;正式编号以 D7-RBAC v1.0 冻结 + V2.x 立项 commit 为准
> **撰写日期**:2026-05-14(v0.1)/ 2026-05-14(v0.2 局部收口)
> **接续**:
> - [D6 业务确认稿(PR #47, squash commit `44e1326`)](批次8_RBAC_业务确认稿.md)
> - [访谈提纲(PR #46, squash commit `1b33c4e`)](批次8_RBAC_业务访谈提纲.md)
> - [PR #45 attachments 业务确认稿 §三 决议 1 / 决议 2](批次7_attachments_业务确认稿.md)
> - [v0.8.1 handoff §10 启动 Fast-1](handoff/v0.8.1.md)(本次局部收口的触发源)
> **风格参照**:[docs/批次6_audit_logs_API前评审.md](批次6_audit_logs_API前评审.md)
> **核心**:落地 RBAC **4 个 model**(`Role` / `Permission` / `RolePermission` / `UserRole`)+ **~16 个 API 端点** + **judge 函数 `rbac.can()`**(F5 v0.2 锁:Service 层显式调用,**不**做 Guard 装饰器)+ **进程内缓存 + reload 接口** + **seed migration 框架** + **audit_logs 集成 ~9 项 union** + **BizCode 段位 `300xx` / `301xx`**(F1 v0.2 锁;baseline §1.1 已同步追加)

---

## 1. 前置业务确认结果(沿 D6 §二 13 题 + §三 4 决议)

### 1.1 D6 13 题拍板(沿 [批次8_RBAC_业务确认稿.md §二](批次8_RBAC_业务确认稿.md))

| Q | 内容 | 拍板 | 本稿落地章节 |
|---|---|---|---|
| 1 | 业务角色清单 | D 全套预置 + 后台 CRUD 自定义 | §4.1 Role / §10 seed |
| 2 | 角色组合 | B 多 RBAC 角色 | §4.4 UserRole 多对多 |
| ★ 3 | 权限点粒度 | B resource type 级 | §4.2 Permission / §10 权限点 |
| 4 | 资源所有权 | C 混合(user.id + Member.id) | §8.3 owner 字段映射 |
| ★ 5 | 角色继承 | B 三层 Role 自动继承 | §7 共存 / §8.2 判权 |
| 6 | 权限点分配权 | C 运营管理员业务角色 | §6.1 / §10.4 bootstrap |
| 7 | 角色分配权 | D 按角色分级 | §6.2 角色层级 |
| 8 | 按部门切片 | A 不切片 | §4 无 scope 字段 |
| 9 | 配置即时生效 | B 显式 reload 接口 | §5.3 reload / §9 缓存 |
| 10 | 初始 seed | D 全套预置 | §10 seed |
| ★ 11 | 与三层 Role 关系 | C 短期 A 长期 B | §7 共存 |
| 12 | 配置变更 audit_logs | A 全部记录 | §11 audit 集成 |
| 13 | 用户失效场景 | A disable 时 user_roles 不动 | §13 失效场景 |

### 1.2 D6 4 条新增决议(沿 [批次8_RBAC_业务确认稿.md §三](批次8_RBAC_业务确认稿.md))

| # | 决议 | 本稿处理 |
|---|---|---|
| 1 | 启动顺序:C-6 先行 → C-7 跟进 | 沿用,本稿是 C-6 D7 评审稿 |
| 2 | RBAC 模型:完整三表 + 三层 Role 并存 | 本稿落地 §4 |
| 3 | 实施前置:§9 升级路径 + BizCode 段位 `300xx` / `301xx` | §12 BizCode(段位 v0.2 已锁) |
| 4 | v1 / V2 既有接口 zero drift | §15 风险 + §17 验收 |

### 1.3 D6 4 处留 D7 细化(本稿落地)

| Q | 留 D7 细化项 | 本稿落地章节 |
|---|---|---|
| 4 | 每业务表"本人"判定字段穷举 | §8.3 |
| 6 | 运营管理员能改表粒度 + bootstrap + "最后一个保护" | §6.1 + §6.3 |
| 7 | 角色层级具体规则 | §6.2 |
| 10 | 具体 seed 内容(脱敏 placeholder) | §10 |
| 11 | 过渡终止条件三选一 | §7.3 |

---

## 2. 本批次目标

1. 新增 4 个 Prisma model:`Role` / `Permission` / `RolePermission` / `UserRole` + migration
2. 新增 `permissions` 模块(`src/modules/permissions/`):**8 文件**(主体 4 + `permissions.select.ts` + `permissions.types.ts` + 子目录 `dto/`)
3. 新增 `RbacService`(`@Injectable`)+ judge 函数 `rbac.can(user, action, resource)`
4. 新增 16 个 API 端点(D7 v0.1 草稿;v0.2 可能微调)
5. 新增 `RbacGuard`(可选;沿 §7 共存方案决议)
6. 新增进程内 RBAC 缓存(short TTL)+ `POST /api/v2/rbac/reload` 显式失效接口
7. 新增 seed migration(全套预置:角色 + 权限点 + 角色权限映射)
8. 新增 `AuditLogEvent` union 项 ~9 项(`rbac.*` 系列)
9. 新增 BizCode 段位 `300xx` / `301xx`(**v0.2 已锁**;baseline §1.1 已同步追加;**业务级**)
10. **v1 14 接口 + V2 既有 79 接口 zero drift**(A-2 红线);`users.policy.ts` 保留

---

## 3. 本批次不做

- 不引入 Redis / 队列 / 定时任务(沿 V1.1 §17.3;RBAC 缓存仅进程内)
- 不引入多实例分布式锁 / 失效广播
- 不做 按部门 / 按 Organization 数据范围切片(Q8 A 不切片)
- 不实施 Q11 "长期 B" 过渡(本稿仅决议**过渡终止条件**,实际过渡不在 C-6 内)
- 不动 v1 14 接口 + V2 既有 79 接口的任何字段 / 路径 / 权限标注
- 不废弃 `users.policy.ts`(沿 Q11 短期 A)
- 不强制全部 controller 改走 RBAC 判权(沿 §7 渐进迁出)
- 不在 RBAC seed 中包含真实角色名 / 部门名(沿 research §5.1 / §7-R13;真实名 user 私下提供 `.env.seed.local`)
- 不审计 audit_logs 自身(A-18 红线)
- 不引入 `permissions` 表的"按 owner 切片"字段(沿 Q8 A;未来切片走 §9 升级路径)
- 不为 attachments / member_profiles / events 等延后模块预填权限点(沿 PR #45 决议 1,attachments 实施时再加 seed)

---

## 4. schema 草案

### 4.1 Role model(自定义角色表;沿 D6 Q1)

```prisma
model Role {
  id          String   @id @default(cuid())
  code        String   @unique // 业务 code,kebab-case;如 'apd-chief' / 'equipment-manager'
  displayName String   // 显示名(脱敏 placeholder;真实名 seed 时填)
  description String?  // 角色用途说明
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime? // 沿 v1 软删除范式

  rolePermissions RolePermission[]
  userRoles       UserRole[]

  @@index([deletedAt])
}
```

**字段说明**:

- `code`:业务唯一标识(kebab-case 规范;DTO 校验 `@Matches(/^[a-z][a-z0-9-]{2,32}$/)`)
- `displayName`:对外显示名;**真实名 user 私下提供 seed**,本稿用 placeholder
- `deletedAt`:沿 v1 软删除;角色被软删后 `user_roles` / `role_permissions` **不联动**(沿 §6.3 "最后一个运营管理员保护" 同事务检查)
- **没有 `isSystem` 字段**(运营管理员也走普通角色,bootstrap 在 seed 阶段处理)

### 4.2 Permission model(权限点表;沿 D6 Q3 B resource type 级)

```prisma
model Permission {
  id           String   @id @default(cuid())
  code         String   @unique // <module>.<action>.<resource_type>
  module       String   // 模块名,如 'attachment' / 'member' / 'activity' / 'rbac'
  action       String   // 动作,如 'upload' / 'view' / 'create' / 'delete'
  resourceType String   // 资源类型,如 'cert' / 'activity' / 'self' / 'other'
  description  String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  rolePermissions RolePermission[]

  @@index([module])
  @@index([resourceType])
}
```

**字段说明**:

- `code` 命名规范:`<module>.<action>.<resource_type>`(沿 Q3 B);具体规则见 §10.2
- `code` UNIQUE 防止重复定义
- **无软删字段**(Permission 是 seed-driven;运营不主动删,真有"误加权限点"通过 RBAC 配置撤销而非删表)
- 三个分类字段(`module` / `action` / `resourceType`)冗余存储,方便后台 UI 按 module / type 分组展示

### 4.3 RolePermission model(角色 → 权限点 多对多;沿 D6 Q2 / Q6)

```prisma
model RolePermission {
  id           String   @id @default(cuid())
  roleId       String
  permissionId String
  createdAt    DateTime @default(now())
  createdBy    String?  // User.id;沿 Q12 A audit 字段

  role          Role        @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission    Permission  @relation(fields: [permissionId], references: [id], onDelete: Cascade)
  createdByUser User?       @relation("RolePermissionCreator", fields: [createdBy], references: [id], onDelete: SetNull)

  @@unique([roleId, permissionId])
  @@index([roleId])
  @@index([permissionId])
}
```

**字段说明**:

- 复合 UNIQUE(`roleId, permissionId`):防止重复授权
- FK Cascade:Role / Permission 删除时 RolePermission 联级清理
- `createdBy` 保留为可空 + `onDelete: SetNull`:上传者软删后保留授权关系记录
- **没有 `deletedAt`**(撤权 = 物理删,沿 Q12 A audit 记录)

### 4.4 UserRole model(用户 → 业务角色 多对多;沿 D6 Q2 / Q7 / Q13)

```prisma
model UserRole {
  id        String   @id @default(cuid())
  userId    String
  roleId    String
  createdAt DateTime @default(now())
  createdBy String?  // User.id;沿 Q12 A audit 字段

  user          User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  role          Role  @relation(fields: [roleId], references: [id], onDelete: Cascade)
  createdByUser User? @relation("UserRoleCreator", fields: [createdBy], references: [id], onDelete: SetNull)

  @@unique([userId, roleId])
  @@index([userId])
  @@index([roleId])
}
```

**字段说明**:

- 复合 UNIQUE(`userId, roleId`):防止重复分配
- **沿 Q13 A:不加 `deletedAt`**(disable 时 user_roles 不动,disable 阻断登录即可)
- FK Cascade:User 物理删除时 UserRole 联级(但 User 走软删,实际 Cascade 不触发,沿 §13 失效场景)
- Role 软删时 UserRole **不**联级清理(留给 §6.3 "最后一个运营管理员保护" 决策)

### 4.5 与现有 `User` model 的关系

```prisma
model User {
  // 现有字段不变(A-2 红线;不修改 v1 已交付字段)

  // 新增反向关系(Prisma DSL 层面,DB 层无 schema 变更)
  userRoles               UserRole[]
  userRolesCreated        UserRole[]       @relation("UserRoleCreator")
  rolePermissionsCreated  RolePermission[] @relation("RolePermissionCreator")
}
```

**关键说明**:**不**修改 User 表字段(沿 A-2 红线;v1 14 接口出参不变)。

### 4.6 索引 / FK / 约束总结

| 表 | 索引 | UNIQUE | FK |
|---|---|---|---|
| Role | deletedAt | code | — |
| Permission | module / resourceType | code | — |
| RolePermission | roleId / permissionId | (roleId, permissionId) | role / permission Cascade;createdBy SetNull |
| UserRole | userId / roleId | (userId, roleId) | user / role Cascade;createdBy SetNull |

---

## 5. API 草案(16 端点)

### 5.1 路径清单

| # | 方法 | 路径 | 用途 | 所需权限 |
|---|---|---|---|---|
| 1 | GET | `/api/v2/permissions` | 权限点列表(分页) | `rbac.permission.read` |
| 2 | POST | `/api/v2/permissions` | 创建权限点 | `rbac.permission.create` |
| 3 | PATCH | `/api/v2/permissions/:id` | 更新权限点描述 | `rbac.permission.update` |
| 4 | DELETE | `/api/v2/permissions/:id` | 删除权限点(物理删) | `rbac.permission.delete` |
| 5 | GET | `/api/v2/roles` | 角色列表(分页) | `rbac.role.read` |
| 6 | GET | `/api/v2/roles/:id` | 角色详情(含已分配权限点) | `rbac.role.read` |
| 7 | POST | `/api/v2/roles` | 创建角色 | `rbac.role.create` |
| 8 | PATCH | `/api/v2/roles/:id` | 更新角色(displayName / description) | `rbac.role.update` |
| 9 | DELETE | `/api/v2/roles/:id` | 软删除角色 | `rbac.role.delete` |
| 10 | POST | `/api/v2/roles/:id/permissions` | 给角色加权限点(批量) | `rbac.role-permission.create` |
| 11 | DELETE | `/api/v2/roles/:id/permissions/:permissionId` | 撤角色权限点 | `rbac.role-permission.delete` |
| 12 | GET | `/api/v2/users/:userId/roles` | 用户的角色列表 | `rbac.user-role.read` 或本人 |
| 13 | POST | `/api/v2/users/:userId/roles` | 给用户分配角色 | `rbac.user-role.create` + Q7 角色分级 |
| 14 | DELETE | `/api/v2/users/:userId/roles/:roleId` | 撤用户角色 | `rbac.user-role.delete` + Q7 角色分级 |
| 15 | GET | `/api/v2/rbac/me/permissions` | 当前用户的有效权限点集 | 任何登录用户(`@Public()` 等价,但需登录) |
| 16 | POST | `/api/v2/rbac/reload` | 触发 RBAC 缓存失效(沿 Q9 B) | `rbac.config.reload` |

**16 端点全部 `@ApiBearerAuth()`**(沿 v1 §8 + V2 已有风格)。

### 5.2 入参 / 出参 DTO 框架(关键字段;字段集 D7 v0.2 细化)

#### 5.2.1 `CreatePermissionDto`

```typescript
export class CreatePermissionDto {
  @ApiProperty({ description: '权限点 code', example: 'attachment.upload.cert' })
  @IsString()
  @Matches(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$/)
  code!: string;

  @ApiProperty({ description: '模块名' })
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,32}$/)
  module!: string;

  @ApiProperty({ description: '动作' })
  @IsString()
  action!: string;

  @ApiProperty({ description: '资源类型' })
  @IsString()
  resourceType!: string;

  @ApiPropertyOptional({ description: '描述' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
```

#### 5.2.2 `CreateRoleDto`

```typescript
export class CreateRoleDto {
  @ApiProperty({ description: '角色 code', example: 'apd-chief' })
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{2,32}$/)
  code!: string;

  @ApiProperty({ description: '角色显示名' })
  @IsString()
  @MaxLength(50)
  displayName!: string;

  @ApiPropertyOptional({ description: '描述' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
```

#### 5.2.3 `AssignRolePermissionsDto`(批量给角色加权限点)

```typescript
export class AssignRolePermissionsDto {
  @ApiProperty({ description: '权限点 code 数组', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissionCodes!: string[];
}
```

#### 5.2.4 `AssignUserRoleDto`

```typescript
export class AssignUserRoleDto {
  @ApiProperty({ description: '角色 code' })
  @IsString()
  roleCode!: string;
}
```

#### 5.2.5 `ReloadRbacDto`(可选 scope)

```typescript
export class ReloadRbacDto {
  @ApiPropertyOptional({
    description: 'reload 范围;默认 all',
    enum: ['all', 'user', 'role'],
    example: 'all'
  })
  @IsOptional()
  @IsIn(['all', 'user', 'role'])
  scope?: 'all' | 'user' | 'role';

  @ApiPropertyOptional({ description: 'scope=user 时指定 userId' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'scope=role 时指定 roleId' })
  @IsOptional()
  @IsString()
  roleId?: string;
}
```

#### 5.2.6 出参 DTO(关键)

- `PermissionResponseDto`(出参字段:`id` / `code` / `module` / `action` / `resourceType` / `description` / `createdAt` / `updatedAt`)
- `RoleResponseDto`(出参字段:`id` / `code` / `displayName` / `description` / `createdAt` / `updatedAt`;详情接口额外含 `permissions: PermissionResponseDto[]`)
- `UserRoleResponseDto`(出参字段:`id` / `roleId` / `roleCode` / `roleDisplayName` / `createdAt` / `createdByUserId`)
- `MyPermissionsResponseDto`(出参:`permissions: string[]` 仅 code 字符串集 + `effectiveRoles: { code: string; displayName: string }[]`)

字段集 D7 v0.2 细化(`@ApiProperty` 详细描述 / 必填可选标注 / nullable 标注)。

### 5.3 `GET /api/v2/rbac/me/permissions` 详解

**用途**:让前端 / 后台 UI 拉取当前登录用户的有效权限点集合(用于动态显示按钮 / 路由 / 菜单)。

**返回结构**:

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "permissions": [
      "attachment.upload.cert",
      "attachment.view.cert",
      "rbac.role.read",
      ...
    ],
    "effectiveRoles": [
      { "code": "apd-chief", "displayName": "..." }
    ]
  }
}
```

**权限**:任何登录用户(`@Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)`)

**缓存**:走 RBAC 缓存(沿 §9);进程内 cached,reload 接口触发失效

### 5.4 `POST /api/v2/rbac/reload` 详解(沿 D6 Q9 B)

**入参**:见 §5.2.5 `ReloadRbacDto`(可选 scope)

**权限**:`rbac.config.reload`(仅运营管理员)

**行为**:

- `scope=all`(默认):清空全部 RBAC 进程内缓存
- `scope=user` + `userId`:仅清空指定用户的有效权限点缓存
- `scope=role` + `roleId`:清空所有"持有该角色"的用户的缓存

**多实例场景**(沿 §9.3):本期单实例 OK;多实例需 §9 升级路径(引入 Redis pub/sub 或类似失效广播)

---

## 6. 权限规则(沿 D6 Q6 / Q7)

### 6.1 谁能改 `role_permissions`(权限点分配权;沿 Q6 C 运营管理员)

**决议**:仅"运营管理员"业务角色能调 `POST/DELETE /api/v2/roles/:id/permissions`

**权限点**:

- `rbac.role-permission.create`
- `rbac.role-permission.delete`

**seed 时**:

- 创建"运营管理员"角色(`code='ops-admin'`,placeholder displayName)
- 给"运营管理员"角色配齐所有 `rbac.*` 权限点(沿 §10.3 seed 表)

**bootstrap**:沿 §10.4

### 6.2 谁能改 `user_roles`(角色分配权;沿 Q7 D 按角色分级)

**决议**:**按角色分级**(本稿建议三级,D7 评审业务方可调整)

**层级表**(本稿建议;**业务方在 D7 评审时拍**):

| 分配人 RBAC 角色 / 系统级 Role | 能分配的目标角色 |
|---|---|
| `SUPER_ADMIN`(系统级) | 任何角色(包括运营管理员 / 部长 / 副部长 等所有角色) |
| `ops-admin`(运营管理员,RBAC 角色) | 除 `ops-admin` 之外的所有角色(避免运营管理员自己创造同级或更高级别) |
| 各部门部长角色(如 `apd-chief`,RBAC 角色) | 对应部门的下属角色(如 `apd-deputy`);**只能给本队员分配**(Q4 C 混合) |
| 各部门副部长角色 | 不能分配 |
| `ADMIN`(系统级) | 不能分配(沿 Q7 D 按角色分级;ADMIN 默认无业务角色分配权,需通过 RBAC 配置授予) |
| `USER`(系统级) | 不能分配 |

**实现**:

- `RbacService.canAssignRole(actor, targetRoleCode)`:Service 层判断
- 沿 v1 §13 `assertCanManageUser` 风格,先取 actor 的有效角色集,再查"actor 角色可分配 targetRoleCode 的角色集"
- "可分配的角色集" 是 **代码硬编码**(本稿 v0.1)还是 **配置驱动**(`role_assignable_targets` 表)— **留 D7 v0.2 决议**;本稿建议代码硬编码(简化首批实施)

### 6.3 "最后一个运营管理员保护"(类比 v1 §13 最后一个 SUPER_ADMIN 保护)

**决议**:任何"剥夺最后一个运营管理员权限"操作前,在同一 `prisma.$transaction` 内检查剩余活跃运营管理员数,**确保操作后剩余 ≥ 1**,否则抛 `BizException(BizCode.LAST_OPS_ADMIN_PROTECTED)`(段位 `30101`,**v0.2 已锁**)

**触发场景**:

1. `DELETE /api/v2/users/:userId/roles/:roleId`(撤运营管理员角色)
2. `DELETE /api/v2/roles/:id`(软删运营管理员角色)— 实际 Role 软删时 `user_roles` 不联动,但仍需检查
3. `PATCH /api/v2/users/:id/status`(disable 运营管理员)— 触发 v1 接口,需要在 `users.service.ts` 内补"如该用户是最后一个运营管理员则拒绝"
4. `PATCH /api/v2/users/:id/role`(降级 SUPER_ADMIN 到 ADMIN/USER 时)— 若该 SUPER_ADMIN 是唯一通过自动继承拥有运营管理员权限的人,需检查

**bootstrap 不绕过保护**:首次 seed 时**至少配置 1 个运营管理员**(沿 §10.4);如 seed 失败,migration 整体回滚(沿 Prisma migration 标准行为)

---

## 7. 与三层 Role / `users.policy.ts` 共存(沿 D6 Q11 C 短期 A 长期 B)

### 7.1 判权优先级(短路 → 细粒度)

```
1. SUPER_ADMIN 短路:user.role === SUPER_ADMIN → 自动通过 RBAC 判权(沿 Q5 B 三层 Role 自动继承)
2. ADMIN 继承 USER 权限:user.role === ADMIN → 自动通过所有"USER 级" RBAC 判权
3. RBAC 细粒度:查 user_roles → role_permissions → permissions 集
4. 资源所有权:权限点含 .self 后缀时,检查 owner 匹配(沿 Q4 C 混合)
```

### 7.2 `users.policy.ts` 保留与 RBAC 共存

- v1 14 接口的 `@Roles(...)` + `assertCanManageUser`:**保留**(沿 A-2 红线 + Q11 短期 A)
- V2 现有 79 接口的 `@Roles(...)` + Service 层 `assertCanXxx`:**保留**
- 新增 v2 / 未来接口:**走 RBAC**(`@RbacRequired('attachment.upload.cert')` 装饰器或 Guard)
- 双轨制:两套判权并行,**SUPER_ADMIN 在两套都自动通过**(避免冲突)

### 7.3 过渡终止条件(沿 D6 Q11;三选一决议)

> **状态**:**D12 v0.2 已锁**(2026-05-14 用户拍板)
> **决议**:**(c) 永不切换** — 三层 Role 永远存在作为"系统级身份分层";RBAC 作为业务级补充长期共存

**理由**:

- v1 14 接口的 `@Roles(...)` 是**契约**(A-2 红线),改动等于破坏 v1 兼容性
- 三层 Role 自动继承(Q5 B)+ RBAC 业务角色双层模型清晰且稳定
- "迁移到完全走 RBAC" 收益不明显(三层 Role 简洁;ADMIN 系统级身份是显式的)
- 维护负担小(没有"何时迁完"的时间压力)
- `users.policy.ts` 永久共存 + RBAC 业务级补充,V2 现有 79 接口 + 未来新增接口走 RBAC 时,v1 14 接口仍按 v1 契约工作

**已否决候选**(2026-05-14):

- (a) 某 N 模块全走 RBAC 后启动 v1 接口迁出 — **不采用**;v1 接口契约长期稳定
- (b) 时间硬截止(如 V3.0)— **不采用**;强制切换会破坏 v1 兼容性,且无明确收益

**修订边界**:本节决议为 v0.2 锁定结果,如需调整需另起 v1.x 修订 PR + 用户拍板。

---

## 8. judge 函数 `rbac.can()`

> **F5 v0.2 已锁**(2026-05-14 用户拍板):**Service 层显式 `rbac.can()` 调用**,**不**实现 `RbacGuard` 装饰器或 `@RbacRequired(...)` 装饰器形式。
> **理由**:Service 层显式调用便于审计 / 调试 / 资源 owner 上下文构造(沿 §8.3 各业务表本人判定字段映射);Guard 装饰器在装饰器作用域内难以注入资源对象。
> **影响**:§5.1 16 端点路径不变;每个 controller 在 Service 层入口显式调 `await this.rbac.can(currentUser, action, resource)`,失败抛 `BizException(BizCode.RBAC_FORBIDDEN)`(`30100`)。

### 8.1 函数签名

```typescript
export interface RbacResource {
  ownerType?: 'user' | 'member';  // 沿 Q4 C 混合
  ownerId?: string;                 // user.id 或 member.id,与 ownerType 对应
  // 未来扩展:instance 级判权(沿 Q3 暂不做)
}

export interface RbacJudgeResult {
  allowed: boolean;
  reason?: 'super_admin_pass' | 'admin_inherits_user' | 'has_permission' | 'self_match' | 'no_permission';
}

export class RbacService {
  /**
   * 判权主函数。
   *
   * @param user 当前登录用户(沿 CurrentUser type)
   * @param action 权限点 code(如 'attachment.upload.cert')
   * @param resource 资源对象(可选;含 ownerType / ownerId 用于 .self / .other 判定)
   */
  async can(
    user: CurrentUser,
    action: string,
    resource?: RbacResource,
  ): Promise<boolean>;

  /**
   * 同 can(),但返回详细原因(用于审计 + 调试)
   */
  async judge(
    user: CurrentUser,
    action: string,
    resource?: RbacResource,
  ): Promise<RbacJudgeResult>;

  /**
   * 取当前用户的所有有效权限点(走缓存)
   */
  async getUserPermissions(userId: string): Promise<Set<string>>;

  /**
   * 触发缓存失效(沿 §5.4 reload 接口)
   */
  async reload(scope: 'all' | { user: string } | { role: string }): Promise<void>;
}
```

### 8.2 实现伪代码(沿 §7.1 判权优先级)

```typescript
async can(user, action, resource) {
  // 1. SUPER_ADMIN 短路
  if (user.role === Role.SUPER_ADMIN) return true;

  // 2. 取用户的有效权限点(走缓存)
  const permissions = await this.getUserPermissions(user.id);

  // 3. ADMIN 自动继承 USER 级权限(沿 Q5 B)
  //    实现:seed 时给"USER 级权限点"配给"内置 ADMIN 角色",ADMIN 用户自动持有此角色
  //    本判权步骤不需要特殊处理,RBAC 表已表达

  // 4. 检查精确匹配
  if (!permissions.has(action)) {
    return false;
  }

  // 5. 涉及"本人 vs 他人"时,检查 ownership(沿 Q4 C 混合)
  if (action.endsWith('.self') && resource?.ownerType && resource?.ownerId) {
    return this.checkOwnership(user, resource);
  }

  return true;
}

private checkOwnership(user, resource) {
  if (resource.ownerType === 'user') {
    return resource.ownerId === user.id;
  }
  if (resource.ownerType === 'member') {
    return resource.ownerId === user.memberId; // 沿 V2 v1 User.memberId 可空外键
  }
  return false; // 未知 ownerType
}
```

### 8.3 "本人"判定字段映射(沿 D6 Q4 C 混合)

| 业务表 | "本人"判定字段 | RbacResource 用法 |
|---|---|---|
| `Member`(队员) | `Member.id` 匹配 `user.memberId` | `{ ownerType: 'member', ownerId: member.id }` |
| `MemberProfile`(队员档案;延后) | 同上 | 同上 |
| `EmergencyContact` | 通过 Member 关联;`memberId` 匹配 `user.memberId` | 同上 |
| `Certificate` | 通过 Member 关联;`memberId` 匹配 `user.memberId` | 同上 |
| `Activity`(创建者) | `Activity.createdBy` 匹配 `user.id`(管理员可能无 Member) | `{ ownerType: 'user', ownerId: activity.createdBy }` |
| `ActivityRegistration` | 通过 Member 关联;`memberId` 匹配 `user.memberId` | `{ ownerType: 'member', ownerId: registration.memberId }` |
| `Attachment`(未来) | 上传者;**字段决策见 attachments PR #45 § Q2**(D7-attachments 拍 `uploadedBy` 是 User.id 还是 Member.id) | 两种都支持 |
| `AuditLog` | `actorUserId` 匹配 `user.id` | `{ ownerType: 'user', ownerId: log.actorUserId }` |

**实现策略**:Service 层调用 `rbac.can()` 时**显式构造** `RbacResource`,而非由 RbacService 自动推断 — 避免推断错误造成权限漏判

---

## 9. 缓存策略(沿 D6 Q9 B)

### 9.1 进程内 short TTL 缓存

**实现**(本稿建议):

- 使用 `node-cache` 或自实现 `Map` + setTimeout
- 默认 TTL:**30 分钟**(可配置;`RBAC_CACHE_TTL_SECONDS=1800`)
- 缓存粒度:`user:<userId>` → `Set<string>` 权限点 code 集
- LRU 淘汰策略:可选(本期不强求)

### 9.2 显式 reload 接口(沿 D6 Q9 B + §5.4)

- 运营管理员通过 `POST /api/v2/rbac/reload` 主动失效
- scope: `all` / `user` / `role`(沿 §5.4)
- 失效是**进程本地**操作(沿 §9.3 多实例说明)

### 9.3 多实例场景(本期不解决)

- 当前 V1.1 §17.3 锁定单实例 + 进程内缓存
- 多实例部署时,reload 接口仅影响本实例;**已知限制**,由运维通过滚动重启实例触发全量失效
- 未来通过 ARCHITECTURE.md §9 升级路径解锁(候选:Redis pub/sub / NATS / 等)

### 9.4 缓存失效条件

| 触发动作 | 失效范围 |
|---|---|
| `POST /api/v2/users/:userId/roles`(给用户加角色) | 单用户 cache 自动失效;Service 层在事务后 `cache.del('user:'+userId)` |
| `DELETE /api/v2/users/:userId/roles/:roleId`(撤用户角色) | 单用户 cache 自动失效 |
| `POST /api/v2/roles/:id/permissions`(给角色加权限点) | 所有持有该角色的用户 cache 失效(走 `cache.del('user:'+each)` 批量) |
| `DELETE /api/v2/roles/:id/permissions/:permissionId`(撤角色权限点) | 同上 |
| `DELETE /api/v2/roles/:id`(软删角色) | 同上 |
| `DELETE /api/v2/permissions/:id`(删权限点) | 全量失效(简化处理) |
| `POST /api/v2/rbac/reload`(显式) | 按 scope |
| TTL 到期 | 自动失效 |

---

## 10. 初始 seed migration(沿 D6 Q1 + Q10)

### 10.1 预置角色清单(脱敏 placeholder;真实名 user 私下提供)

| placeholder code | 用途 | seed 来源 |
|---|---|---|
| `ops-admin` | 运营管理员(RBAC 自身配置 + 用户角色分配) | 公开 seed |
| `role-a` | 部门部长(真实名 user 私下提供) | `.env.seed.local` |
| `role-b` | 部门副部长 | `.env.seed.local` |
| `role-c` | 装备管理员 | `.env.seed.local` |
| `role-d` | 培训管理员 | `.env.seed.local` |
| `role-e` | 资料管理员 | `.env.seed.local` |
| `role-f` | (预留;真实名 user 私下提供) | `.env.seed.local` |

**说明**:`ops-admin` 是 RBAC 自身的"meta 角色",**公开 seed 必有**;其余角色名以 placeholder 占位,真实名通过 `.env.seed.local` 或 prisma seed 脚本读取 `process.env` 注入,**不进 git 历史**(沿 research §5.1 / §7-R13)

### 10.2 预置权限点清单(部分示例;完整穷举留 D7 v0.2)

| 权限点 code | module | action | resourceType | 描述 |
|---|---|---|---|---|
| `rbac.permission.read` | rbac | permission.read | — | 查看权限点 |
| `rbac.permission.create` | rbac | permission.create | — | 创建权限点 |
| `rbac.permission.update` | rbac | permission.update | — | 更新权限点 |
| `rbac.permission.delete` | rbac | permission.delete | — | 删除权限点 |
| `rbac.role.read` | rbac | role.read | — | 查看角色 |
| `rbac.role.create` | rbac | role.create | — | 创建角色 |
| `rbac.role.update` | rbac | role.update | — | 更新角色 |
| `rbac.role.delete` | rbac | role.delete | — | 软删角色 |
| `rbac.role-permission.create` | rbac | role-permission.create | — | 角色加权限点 |
| `rbac.role-permission.delete` | rbac | role-permission.delete | — | 撤角色权限点 |
| `rbac.user-role.read` | rbac | user-role.read | — | 查看用户角色 |
| `rbac.user-role.create` | rbac | user-role.create | — | 分配用户角色 |
| `rbac.user-role.delete` | rbac | user-role.delete | — | 撤用户角色 |
| `rbac.config.reload` | rbac | config.reload | — | 触发缓存失效 |
| `attachment.upload.cert.self` | attachment | upload.cert.self | — | 上传自己证件附件 |
| `attachment.upload.cert.other` | attachment | upload.cert.other | — | 上传他人证件附件 |
| `attachment.view.cert.self` | attachment | view.cert.self | — | 查看自己证件附件 |
| `attachment.view.cert.other` | attachment | view.cert.other | — | 查看他人证件附件 |
| ...(完整 30-50 条留 D7 v0.2 穷举) | | | | |

### 10.3 预置角色权限映射(部分示例)

| 角色 code | 权限点 code 集 |
|---|---|
| `ops-admin` | 全部 `rbac.*`(14 条) |
| `role-a`(placeholder)| `attachment.*` 部分 + 业务模块部分(待 D7 v0.2 穷举) |
| `role-b`(placeholder)| `role-a` 的子集(沿 §6.2 角色层级,但 RBAC 不做继承,seed 显式映射) |
| ...(完整映射留 D7 v0.2) | |

### 10.4 bootstrap 流程(首个运营管理员)

**seed 阶段**:

```typescript
// prisma/seed.ts(伪代码;不实际修改 seed.ts)
async function seed() {
  // 1. seed Permission 表(沿 §10.2 全集)
  await prisma.permission.createMany({ data: [...] });

  // 2. seed Role 表(`ops-admin` + 业务角色 placeholder)
  await prisma.role.createMany({ data: [...] });

  // 3. seed RolePermission 表(沿 §10.3 映射)
  await prisma.rolePermission.createMany({ data: [...] });

  // 4. 给首个运营管理员分配 ops-admin 角色
  const initialOpsAdminId = process.env.RBAC_INITIAL_OPS_ADMIN_USER_ID;
  if (initialOpsAdminId) {
    await prisma.userRole.create({
      data: {
        userId: initialOpsAdminId,
        roleId: <ops-admin role id>,
      },
    });
  } else {
    // 兼容方案:把 ops-admin 角色配给现有 SUPER_ADMIN 用户(seed 阶段查找)
    const superAdmin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
    if (superAdmin) {
      await prisma.userRole.create({
        data: { userId: superAdmin.id, roleId: <ops-admin role id> },
      });
    }
  }
}
```

**bootstrap 策略**:

1. 首选:`process.env.RBAC_INITIAL_OPS_ADMIN_USER_ID` 显式指定首个运营管理员
2. 备选:无环境变量时,自动配给现有 SUPER_ADMIN 用户(SUPER_ADMIN 通过 Q5 B 三层 Role 自动继承 ops-admin 所有权限,但显式 user_roles 仍要落库,方便后台 UI 显示"我是运营管理员")

**强校验**:seed 完成后,**至少 1 个 `ops-admin` user_roles 必须存在**,否则 throw 退出(沿 §6.3 最后一个保护)

---

## 11. audit_logs 集成(沿 D6 Q12 A)

### 11.1 新增 `AuditLogEvent` union 项(9 项)

```typescript
// src/modules/audit-logs/audit-logs.types.ts(预期扩展)
export type AuditLogEvent =
  | ...  // 现有 17 项(v0.8.0 收官)
  | 'rbac.permission.create'
  | 'rbac.permission.update'
  | 'rbac.permission.delete'
  | 'rbac.role.create'
  | 'rbac.role.update'
  | 'rbac.role.delete'
  | 'rbac.role-permission.change'  // 沿 audit_logs 路线 A:多 operation 共用单一事件名,extra 区分
  | 'rbac.user-role.change'         // 同上
  | 'rbac.config.reload';            // 沿 Q9 B reload 接口
```

**路线 A 命名策略**(沿 audit_logs v0.8.0 收官):

- `rbac.role-permission.change` 承载 2 个 operation(create / delete),通过 `extra.operation` 区分
- `rbac.user-role.change` 承载 2 个 operation(create / delete),通过 `extra.operation` 区分

**union 增量**:17 → 26 项(+9)

### 11.2 同事务 wrap 策略(沿 A-17 红线)

所有 RBAC 写操作必须 wrap `prisma.$transaction`,内部调 `AuditLogsService.log({ tx })`:

```typescript
// 示例:给角色加权限点
async addPermissionsToRole(roleId, permissionCodes, currentUser, meta) {
  return this.prisma.$transaction(async (tx) => {
    // 1. 业务写入
    const rolePerms = await tx.rolePermission.createMany({ ... });

    // 2. audit 落库(同事务)
    await this.auditLogs.log({
      tx,
      event: 'rbac.role-permission.change',
      actorUserId: currentUser.id,
      resourceType: 'role',
      resourceId: roleId,
      context: { ...meta, extra: { operation: 'create', permissionCodes } },
    });

    // 3. 失效缓存(事务外;事务回滚时已写入业务表的失效不会影响,因为业务表也已回滚)
    return rolePerms;
  });
}
```

### 11.3 e2e 覆盖(沿 audit_logs 范式)

- 每个写接口 e2e 覆盖:成功路径 + audit 落库验证
- 失败路径(权限不足 / 业务规则违反):audit 应**不**落库(同事务 fail-fast)
- 不审计 audit_logs 自身(A-18 红线)

---

## 12. BizCode 建议(段位 `300xx` / `301xx`,**v0.2 已锁**)

**说明**(F1 v0.2 已锁,2026-05-14 用户拍板):**`300xx` / `301xx`** 是新增 V2 模块段位,中间留 `240xx-290xx` 缓冲(未来训练 / 装备 / 财务 / 通知等模块预留),RBAC 是项目骨架级模块,占独立段位空间。`baseline §1.1` 已同步追加(本 PR 内交付)。

**段位选择对照**:

- `140xx` / `141xx` 段位**已被 audit_logs 占用**(批次 6 v0.7.0 实装 `14001 AUDIT_LOG_NOT_FOUND` / `14101 FORBIDDEN_AUDIT_LOG_READ`),不可与 RBAC 共用
- `240xx-290xx` 留给未来未规划业务模块(训练 / 装备 / 财务 / 通知等)
- RBAC 占 `300xx` / `301xx`,不与现有段位冲突

### 12.1 `300xx`(RBAC 模块通用错误)

| code | name | message | httpStatus | 用途 |
|---|---|---|---|---|
| 30000 | RBAC_BAD_REQUEST | RBAC 参数错误 | 400 | 通用 |
| 30001 | PERMISSION_NOT_FOUND | 权限点不存在 | 404 | — |
| 30002 | PERMISSION_CODE_ALREADY_EXISTS | 权限点 code 已存在 | 409 | — |
| 30003 | ROLE_NOT_FOUND | 角色不存在 | 404 | — |
| 30004 | ROLE_CODE_ALREADY_EXISTS | 角色 code 已存在 | 409 | — |
| 30005 | ROLE_DELETED | 角色已删除 | 410 Gone | — |
| 30006 | USER_ROLE_ALREADY_EXISTS | 该用户已持有此角色 | 409 | — |
| 30007 | USER_ROLE_NOT_FOUND | 该用户未持有此角色 | 404 | — |
| 30008 | INVALID_PERMISSION_CODE_FORMAT | 权限点 code 格式不合法 | 400 | — |
| 30009 | INVALID_ROLE_CODE_FORMAT | 角色 code 格式不合法 | 400 | — |

### 12.2 `301xx`(RBAC 权限 / 边界错误)

| code | name | message | httpStatus | 用途 |
|---|---|---|---|---|
| 30100 | RBAC_FORBIDDEN | 无权限执行 RBAC 配置变更 | 403 | 沿 §6.1 / §6.2 |
| 30101 | LAST_OPS_ADMIN_PROTECTED | 系统必须保留至少一个活跃运营管理员 | 409 | 沿 §6.3 |
| 30102 | CANNOT_ASSIGN_HIGHER_ROLE | 无权分配高于自身的角色 | 403 | 沿 §6.2 角色层级 |
| 30103 | CANNOT_DELETE_SYSTEM_PERMISSION | 系统级权限点不可删 | 403 | 防止误删 `rbac.*` 权限点 |
| 30104 | CANNOT_DELETE_OPS_ADMIN_ROLE | `ops-admin` 角色不可删 | 403 | 类比 30101 |

**待 v1.0 冻结时微调 / 追加**(如 RBAC 配置初始化错误 / migration 失败提示等);**段位本身 v0.2 已锁,只在该段内追加**。

---

## 13. 用户失效场景(沿 D6 Q13 A)

| 场景 | `user_roles` 行为 | 判权行为 |
|---|---|---|
| `User.status = DISABLED` | 不动 | `JwtStrategy.validate()` 拒绝 token(沿 v1 CLAUDE.md §8);判权不达 |
| `User.deletedAt != null`(软删) | 不动 | 同上 |
| `Member.deletedAt != null`(关联 user.memberId)| 不动 | RBAC 判权时,`checkOwnership` 仍可能匹配 `user.memberId`;**但** v1 已有的 `Member` 查询走 `notDeletedWhere`,所以业务对象访问失败 |
| user disable + reactivate | 不动,角色保留 | reactivate 后立即恢复(沿 Q13 A 体验) |

**v1 兼容性**:不修改 `JwtStrategy.validate()`(沿 A-2 红线);RBAC 判权在 Service 层执行,失效场景由 v1 现有 Guard / 校验拦截

---

## 14. e2e 覆盖建议

### 14.1 RBAC CRUD 覆盖(目标 ~40 用例)

- Permission CRUD × 4 端点 × (成功 / 权限不足 / 不存在 / 重复 code 等):**~12 用例**
- Role CRUD × 5 端点(含详情)× 各场景:**~15 用例**
- RolePermission × 2 端点 × 各场景:**~6 用例**
- UserRole × 3 端点 × 各场景:**~6 用例**
- reload × 1 端点 × 各 scope:**~3 用例**
- me/permissions × 1 端点:**~2 用例**

### 14.2 判权函数 `rbac.can()` 单元测试

- SUPER_ADMIN 短路 → 任何 action 通过
- ADMIN + 无 RBAC 角色 → 仅基础 USER 权限
- 多角色合并取并集
- `.self` 权限的 ownership 匹配 / 不匹配
- 缓存命中 / TTL 失效 / reload 触发失效

### 14.3 audit_logs 集成测试

- 每个写接口 → audit 落库验证
- 业务异常(P2002 / RbacForbidden)→ audit **不**落库
- RBAC 配置 reload → audit 记录

### 14.4 "最后一个运营管理员保护"测试

- 单 ops-admin 不可被 disable(30101)
- 单 ops-admin 不可被撤角色(30101)
- 多 ops-admin 时允许操作

### 14.5 contract snapshot(zero drift 验证)

- v1 14 + V2 79 接口 schema **保持不变**(A-2 红线)
- 新增 16 RBAC 接口 + me/permissions + reload **入 snapshot**

---

## 15. 风险与返工点

| # | 风险 | 缓解 |
|---|---|---|
| R1 | RBAC seed 内容大,migration 文件膨胀 | seed 拆分多个 prisma migration / 用 `prisma db seed` 而非 migration |
| R2 | `rbac.can()` 缓存 miss 时 DB 查询慢(多表 join) | 预估 < 50ms;TTL 30 分钟覆盖;真出现瓶颈再加 Redis(§9 升级路径) |
| R3 | 多实例部署时 reload 不一致 | 当前单实例 OK;V1.1 §17.3 锁;未来 §9 升级路径 |
| R4 | "运营管理员"角色被误删 | §6.3 + 30101 保护 + 30104 防误删 ops-admin 角色 |
| R5 | 权限点 seed 漏配,业务模块判权 false negative | e2e 全覆盖 + 灰度上线 |
| R6 | v1 14 接口出参 zero drift 失守(A-2) | contract snapshot CI |
| R7 | ~~Q11 过渡终止条件本稿建议 c(永不切换)但业务方未拍~~ — **v0.2 已解除**(D12 已锁 c 永不切换;沿 §7.3) | — |
| R8 | 角色层级(§6.2)本稿建议三级,业务方可能要五级 / 扁平 | D7 评审时业务方拍 |
| R9 | `.env.seed.local` 真实角色名不在 git 历史,新人难以本地起 dev | 文档化 seed 步骤;`.env.seed.example` 给 placeholder |
| R10 | RBAC 缓存 TTL 30 分钟 vs reload 即时性的平衡 | 提供 `RBAC_CACHE_TTL_SECONDS` env 配置 |

---

## 16. PR 拆分建议(沿 batch6 audit_logs 范式)

**预估 7-9 个 PR**(D7 v0.2 微调):

| PR | 类型 | 主题 | 改动量 |
|---|---|---|---|
| 1 | chore(prisma) | 4 个 model + migration(`Role` / `Permission` / `RolePermission` / `UserRole`)| 中 |
| 2 | feat(permissions) | Permission CRUD 模块(端点 1-4) | 中 |
| 3 | feat(permissions) | Role CRUD 模块(端点 5-9) | 中 |
| 4 | feat(permissions) | RolePermission CRUD(端点 10-11)+ 缓存集成 | 中 |
| 5 | feat(permissions) | UserRole CRUD(端点 12-14)+ §6.2 角色层级判定 | 中-大 |
| 6 | feat(permissions) | `rbac.can()` + `RbacService` + `RbacGuard`(可选)+ me/permissions(端点 15) | 大(核心 judge 函数) |
| 7 | feat(permissions) | reload 接口(端点 16) + 缓存失效逻辑 | 小-中 |
| 8 | feat(permissions) | seed migration(`ops-admin` + 权限点全集 + 角色权限映射 + bootstrap) | 中-大 |
| 9 | docs(v2-batch8-landing) | 收口 docs(类比 PR #35 / #37 / #39 / #41) | 小 |

**bump version**:8 个 feat PR 后跑 `chore: bump version to 0.9.0`(SemVer minor;新模块 + 新表 + 16 接口,但 v1 14 + V2 79 接口 zero drift,沿 v0.6.0 → v0.7.0 → v0.8.0 minor 风格)

---

## 17. 验收门槛(沿 baseline §14)

### 17.1 A 档(必跑)

- `pnpm lint` 通过
- `pnpm typecheck` 通过
- `pnpm test:e2e` 全部通过(含 v1 14 已有 137 用例 + V2 79 接口现有用例 + 新增 RBAC e2e ~40 用例)
- `pnpm build` 通过
- `pnpm test:contract` 通过(v1 14 + V2 79 接口 zero drift;**新增 16 RBAC 接口入 snapshot**)
- 任务卡声明的所有验收标准

### 17.2 B 档(HTTP / 中间件 / Guard / Swagger 改动时)

启动服务后手工验证:

- `/api/docs` 完整可用,**16 个新 RBAC 端点全部展示**
- `GET /api/v2/rbac/me/permissions` 能正确返回当前用户的权限点集
- `POST /api/v2/rbac/reload` 实际生效(改完 RBAC 配置后,reload 前 vs reload 后行为有差)
- v1 `GET /api/health` 仍按 v1 契约返回
- v1 14 接口 `@Roles(...)` 仍按 v1 契约工作
- SUPER_ADMIN 短路通过任何 RBAC 判权
- ADMIN 自动继承 USER 级权限

---

## 18. 决议表(本评审稿待业务方 / 用户评审拍板;D7 v1.0 冻结)

> **v0.2 局部收口标注**(2026-05-14):
> - 🔒 = 本次 v0.2 已锁的 5 项(D12 / F5 / F1 + baseline §1.1 + ARCHITECTURE.md §9 修订)
> - ✓ = 保持 v0.1 待评审状态(20 项),v1.0 冻结时一次性拍板;期间业务方可微调本稿建议
> - 修订需另起 v1.x PR + 用户拍板

| # | 决议 | 来源 | 本稿建议 | 状态 |
|---|---|---|---|---|
| B1 | RBAC 模型 = 完整三表(`Role` + `Permission` + `RolePermission` + `UserRole` 4 表) | D6 §三 决议 2 | 沿 D6 | ✓ |
| B2 | 三层 Role 自动继承(SUPER_ADMIN > ADMIN > USER) | D6 Q5 B | 沿 D6 | ✓ |
| B3 | RBAC 业务角色**无**显式继承 | D6 Q5 B | 沿 D6 | ✓ |
| D1 | 权限点粒度 = resource type 级 | D6 Q3 B | 沿 D6 | ✓ |
| D2 | 权限点 code 命名 = `<module>.<action>.<resource_type>` | 本稿 §4.2 / §10.2 | **待评审** | ✓ |
| D3 | 资源所有权 = user.id + Member.id 混合(action 后缀 `.self` / `.other` 区分) | D6 Q4 C | **沿 D6 + §8.3** | ✓ |
| D4 | RBAC 4 model 软删策略:Role 软删 / Permission 物理删 / RolePermission 物理删 / UserRole 物理删 | 本稿 §4 | **待评审**(允许 Role 软删后撤回?) | ✓ |
| D5 | 缓存策略 = 进程内 short TTL + 显式 reload | D6 Q9 B + §9 | 沿 D6 | ✓ |
| D6 | 缓存 TTL 默认 = 30 分钟 | 本稿 §9.1 | **待评审** | ✓ |
| D7 | 角色层级(§6.2)= 三级(SUPER_ADMIN / ops-admin / 业务角色 / ADMIN-USER 无配权) | 本稿 §6.2 | **待评审**(可调整为 4-5 级或扁平) | ✓ |
| D8 | 角色可分配性 = 代码硬编码(非配置驱动) | 本稿 §6.2 | **待评审**(配置化更灵活,但复杂度高) | ✓ |
| D9 | bootstrap = `process.env.RBAC_INITIAL_OPS_ADMIN_USER_ID` 优先 + SUPER_ADMIN 自动 fallback | 本稿 §10.4 | **待评审** | ✓ |
| D10 | "最后一个 ops-admin 保护"触发场景 = §6.3 列出 4 个 | 本稿 §6.3 | **待评审** | ✓ |
| D11 | AuditLogEvent 新增 9 项(路线 A 路径) | 本稿 §11.1 | **待评审** | ✓ |
| D12 | 过渡终止条件(D6 Q11)= **(c) 永不切换**;`users.policy.ts` 永久共存 + RBAC 业务级补充 | 本稿 §7.3 | **🔒 v0.2 已锁(2026-05-14 用户拍板)** |
| F1 | BizCode 段位 = **`300xx` 通用 / `301xx` 权限边界**(避开 `140xx/141xx` audit_logs 已占用段位;中间留 `240xx-290xx` 给未来未规划模块) | 本稿 §12 | **🔒 v0.2 已锁(2026-05-14 用户拍板)+ baseline §1.1 已同步追加** |
| F2 | 16 API 端点路径(`/api/v2/permissions/...` / `/api/v2/roles/...` / `/api/v2/users/:userId/roles` / `/api/v2/rbac/me/permissions` + reload) | 本稿 §5.1 | **待评审** | ✓ |
| F3 | `me/permissions` 返回 `permissions: string[]` + `effectiveRoles: object[]` | 本稿 §5.2.6 / §5.3 | **待评审** | ✓ |
| F4 | reload scope = `all` / `user:userId` / `role:roleId` 三种 | 本稿 §5.4 | **待评审** | ✓ |
| F5 | judge 调用方式 = **Service 层显式 `rbac.can()` 调用**,**不**做 `RbacGuard` 装饰器 | 本稿 §8 | **🔒 v0.2 已锁(2026-05-14 用户拍板)** |
| F6 | seed 真实角色名 / 部门名走 `.env.seed.local`(R13) | 本稿 §10.1 | 沿 research | ✓ |
| F7 | `Role.code` 长度 = 3-32(`@Matches(/^[a-z][a-z0-9-]{2,32}$/)`)| 本稿 §5.2.2 | **待评审** | ✓ |
| F8 | RBAC 缓存允许多 TTL(`RBAC_CACHE_TTL_SECONDS` env) | 本稿 §9.1 / R10 | **待评审** | ✓ |
| F9 | `rbac.can()` 仅在新增 V2 接口启用;v1 14 + V2 79 接口走 `users.policy.ts` | 本稿 §7.2 | 沿 A-2 红线 | ✓ |
| F10 | PR 拆分 = 9 个 PR(沿 batch6 范式) | 本稿 §16 | **待评审** | ✓ |

**总计**:**B 3 + D 12 + F 10 = 25 项**(沿 batch6 D7 v1.1 25 项规模)

---

## 19. 落地节奏

1. ~~**本稿 D7-RBAC v0.1 PR**~~ → ✅ 已落地(PR #48)
2. **本 PR(D7-RBAC v0.2 局部收口)** → 用户评审 → 锁定 5 项(D12 / F5 / F1 + baseline §1.1 + ARCHITECTURE.md §9)
3. **D7-RBAC v1.0 冻结 PR**(后续另起)→ 业务方 / 用户评审剩余 20 项 → 微调 → **冻结为 D7-RBAC v1.0**
4. D7-RBAC v1.0 冻结 → **C-6 RBAC V2.x 立项 commit**
5. 立项后按 §16 PR 拆分顺序实施(预估 9 个 PR + 1 个 bump version PR + 1 个 docs 收口 PR)
6. 实施周期参考 batch6 audit_logs(2-3 周)
7. C-6 上线 → **C-7 attachments D7 评审稿启动**(沿 PR #45 决议 1)

---

## 20. 撰写元信息

- **状态标签**:**v0.2 局部收口稿**;等用户评审 v0.2 改动 → 后续另起 v1.0 冻结 PR
- **commit 风格**:
  - v0.1:`docs(v2-design): 批次8 RBAC API 前评审 v0.1`(已落地 PR #48)
  - v0.2:`docs(v2-design): 批次8 RBAC API 前评审 v0.2 局部收口`(本 PR;沿 V2 §18.5 风格)
- **未做项**(v0.2 沿 v0.1 + 强化):
  - 不动 `prisma/schema.prisma` 文件本身(本稿 Prisma DSL 是设计草案,在 markdown 中展示;不修改 schema 文件)
  - 不动 `src/**` / `test/**` / `package.json` / `pnpm-lock.yaml` / `src/bootstrap/apply-swagger.ts`
  - 不 bump version / 不打 tag / 不发 Release
  - 不启动 RBAC 实施 / 不启动 attachments 任何动作 / 不执行 migration
- **v0.2 修订范围**(本 PR;沿 v0.8.1 handoff §10 启动后 Fast-1 任务):
  - 本评审稿:状态升 v0.2 + §1.2 / §3 / §6.3 / §7.3 / §8 / §12 / §15 / §18 / §19 / §20 锁定 5 项
  - `docs/srvf-foundation-baseline.md` §1.1:追加 `300xx + 301xx` permissions 段位 + 附录 A v0.7
  - `ARCHITECTURE.md` §9:现有"权限点到按钮级"条目去 casl + 改触发条件描述
  - `CHANGELOG.md` Unreleased:追加一行 v0.2 局部收口说明
  - **不**修订 `docs/handoff/v0.8.1.md`(沿 V2 红线 §5.1 历史 handoff 不回改;过期段位号表述以本评审稿 + baseline + CHANGELOG 为准)
- **撰写者签名**:Claude Code(v0.1 基于 D6 业务确认稿 13 题 + 4 决议 + 4 处留 D7 细化;v0.2 基于用户 Fast-1 拍板局部收口 5 项;**v0.1 / v0.2 均未动任何代码 / schema 文件**)
