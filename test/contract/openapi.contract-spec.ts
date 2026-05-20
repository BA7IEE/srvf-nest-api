import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { createTestApp } from '../setup/test-app';

// V1.3-3 OpenAPI 契约快照。
//
// 目标:
//   1. 全量路由清单显式锁定 — 任何 controller 路径 / HTTP 方法的增删改,必须显式更新本测试,
//      避免无意识漂移(尤其是 v1 已锁定的 14 个业务接口 + 3 个健康检查 + auth 登录)。
//   2. 核心响应 schema 不漂移 — 用 Jest 原生 toMatchSnapshot() 锁定 paths 与 components。
//      未来 controller / DTO 改动后,需要显式 `pnpm test:contract -u` 更新快照,
//      在 PR diff 里直接 review schema 变更。
//   3. /api/docs-json 能成功生成 — Swagger 装配链路完整(applySwagger + ResponseInterceptor 跳过 + setGlobalPrefix)。
//
// 不做的事:
//   - 不引入 dredd / prism / 其他外部 schema 工具(CLAUDE.md §17 / v1.3-plan §1)
//   - 不做语义版本号绑定(snapshot 自身就是 truth)
//   - 不断言完整 OpenAPI 文档逐字节相等(交给 toMatchSnapshot 自动维护)
//
// 兼容已有 swagger.e2e-spec.ts:本 spec 关注 schema 内容,e2e 关注 HTTP 跳过包装,职责互补。

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  responses?: Record<string, unknown>;
}

type OpenApiPathItem = Partial<
  Record<'get' | 'post' | 'put' | 'patch' | 'delete', OpenApiOperation>
>;

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

// v1 锁定路由清单 + V2 第一阶段(Step 3 起)dictionaries。
// 新增 / 删除任一路由必须同步本表 + 重新生成快照。
// v1 14 接口 schema 必须**零漂移**(Step 3 引入 V2 路由后,v1 段位 schema 不应被改动)。
const EXPECTED_ROUTES: ReadonlyArray<
  readonly [Lowercase<'get' | 'post' | 'put' | 'patch' | 'delete'>, string]
> = [
  ['post', '/api/auth/login'],
  // P0-E PR-3(2026-05-18):refresh token / logout / logout-all 三新端点
  ['post', '/api/auth/refresh'],
  ['post', '/api/auth/logout'],
  ['post', '/api/auth/logout-all'],

  ['get', '/api/health'],
  ['get', '/api/health/live'],
  ['get', '/api/health/ready'],

  ['get', '/api/users/me'],
  ['patch', '/api/users/me'],
  // P0-D PR-3(2026-05-17):本人自助改密
  ['put', '/api/users/me/password'],
  ['get', '/api/users'],
  ['post', '/api/users'],
  ['get', '/api/users/{id}'],
  ['patch', '/api/users/{id}'],
  ['put', '/api/users/{id}/password'],
  ['patch', '/api/users/{id}/role'],
  ['patch', '/api/users/{id}/status'],
  ['delete', '/api/users/{id}'],

  // V2 dictionaries (Step 3,2026-05-08)
  ['get', '/api/v2/dict-types'],
  ['post', '/api/v2/dict-types'],
  ['get', '/api/v2/dict-types/{id}'],
  ['patch', '/api/v2/dict-types/{id}'],
  ['patch', '/api/v2/dict-types/{id}/status'],
  ['delete', '/api/v2/dict-types/{id}'],
  ['get', '/api/v2/dict-items'],
  ['post', '/api/v2/dict-items'],
  ['get', '/api/v2/dict-items/tree'],
  ['get', '/api/v2/dict-items/{id}'],
  ['patch', '/api/v2/dict-items/{id}'],
  ['patch', '/api/v2/dict-items/{id}/status'],
  ['delete', '/api/v2/dict-items/{id}'],

  // V2 organizations (Step 4,2026-05-08)
  ['get', '/api/v2/organizations'],
  ['get', '/api/v2/organizations/tree'],
  ['post', '/api/v2/organizations'],
  ['get', '/api/v2/organizations/{id}'],
  ['patch', '/api/v2/organizations/{id}'],
  ['patch', '/api/v2/organizations/{id}/status'],
  ['delete', '/api/v2/organizations/{id}'],

  // V2 members (Step 5,2026-05-08)
  ['get', '/api/v2/members'],
  ['post', '/api/v2/members'],
  ['get', '/api/v2/members/{id}'],
  ['patch', '/api/v2/members/{id}'],
  ['patch', '/api/v2/members/{id}/status'],
  ['delete', '/api/v2/members/{id}'],

  // V2 member-departments (Step 6,2026-05-08;嵌套在 members 下作子资源)
  ['get', '/api/v2/members/{memberId}/department'],
  ['put', '/api/v2/members/{memberId}/department'],
  ['delete', '/api/v2/members/{memberId}/department'],

  // V2 第一阶段批次 1 member-profiles (2026-05-10;1:1 子资源)
  ['get', '/api/v2/members/{memberId}/profile'],
  ['post', '/api/v2/members/{memberId}/profile'],
  ['patch', '/api/v2/members/{memberId}/profile'],

  // V2 第一阶段批次 1 emergency-contacts (2026-05-10;N:1 子资源 + 单条 CRUD)
  ['get', '/api/v2/members/{memberId}/emergency-contacts'],
  ['post', '/api/v2/members/{memberId}/emergency-contacts'],
  ['patch', '/api/v2/members/{memberId}/emergency-contacts/{id}'],
  ['delete', '/api/v2/members/{memberId}/emergency-contacts/{id}'],

  // V2 第一阶段批次 2 certificates (2026-05-10;N:1 子资源 + verify / reject / qualification-flag 动作)
  // 路径顺序:list / create / qualification-flag(必先于 :id)/ detail / update / softDelete /
  // verify / reject(controller 内方法声明顺序固定;NestJS 字面段优先于 :id 占位段)
  ['get', '/api/v2/members/{memberId}/certificates'],
  ['post', '/api/v2/members/{memberId}/certificates'],
  ['get', '/api/v2/members/{memberId}/certificates/qualification-flag'],
  ['get', '/api/v2/members/{memberId}/certificates/{id}'],
  ['patch', '/api/v2/members/{memberId}/certificates/{id}'],
  ['delete', '/api/v2/members/{memberId}/certificates/{id}'],
  ['patch', '/api/v2/members/{memberId}/certificates/{id}/verify'],
  ['patch', '/api/v2/members/{memberId}/certificates/{id}/reject'],

  // V2 第一阶段批次 3A activities (2026-05-11;7 路由;Q-A7 USER + ADMIN 同路由)
  ['get', '/api/v2/activities'],
  ['post', '/api/v2/activities'],
  ['get', '/api/v2/activities/{id}'],
  ['patch', '/api/v2/activities/{id}'],
  ['delete', '/api/v2/activities/{id}'],
  ['patch', '/api/v2/activities/{id}/publish'],
  ['patch', '/api/v2/activities/{id}/cancel'],

  // V2 第一阶段批次 3A activity-registrations (2026-05-11;管理端 6 + 队员端 4 = 10 路由)
  // Q-A3 USER 自助报名与 ADMIN 代报名拆开;Q-A6 CSV 导出(默认 scope=pass / 可选 all)
  ['post', '/api/v2/activities/{activityId}/registrations'],
  ['get', '/api/v2/activities/{activityId}/registrations'],
  ['get', '/api/v2/activities/{activityId}/registrations/export'],
  ['patch', '/api/v2/activities/{activityId}/registrations/{id}/approve'],
  ['patch', '/api/v2/activities/{activityId}/registrations/{id}/reject'],
  ['patch', '/api/v2/activities/{activityId}/registrations/{id}/cancel'],
  ['post', '/api/v2/users/me/activities/{activityId}/registration'],
  ['get', '/api/v2/users/me/registrations'],
  ['get', '/api/v2/users/me/registrations/{id}'],
  ['patch', '/api/v2/users/me/registrations/{id}/cancel'],

  // V2 第一阶段批次 3B attendances (2026-05-11;管理端 8 + 队员端 1 = 9 路由)
  // Sheet 提交 / 列表 / detail / review-detail / edit / delete / approve / reject + /me records
  // 路径顺序:submit / list / review-detail(字面)/ detail / edit / delete / approve / reject
  // (字面段优先于 :id 占位段;实装阶段 controller 内方法声明顺序固定)
  ['post', '/api/v2/activities/{activityId}/attendance-sheets'],
  ['get', '/api/v2/activities/{activityId}/attendance-sheets'],
  ['get', '/api/v2/attendance-sheets/{id}/review-detail'],
  ['get', '/api/v2/attendance-sheets/{id}'],
  ['patch', '/api/v2/attendance-sheets/{id}'],
  ['delete', '/api/v2/attendance-sheets/{id}'],
  ['patch', '/api/v2/attendance-sheets/{id}/approve'],
  ['patch', '/api/v2/attendance-sheets/{id}/reject'],
  // V2 第一阶段批次 4-B(2026-05-12;APD 部门部长 / 副部长终审,沿 D-S5 / D-S7)
  ['patch', '/api/v2/attendance-sheets/{id}/final-approve'],
  ['patch', '/api/v2/attendance-sheets/{id}/final-reject'],
  ['get', '/api/v2/users/me/attendance-records'],
  // V2 第一阶段批次 5-A(2026-05-12;ContributionRule CRUD,沿 D6 v1.1)
  ['get', '/api/v2/contribution-rules'],
  ['post', '/api/v2/contribution-rules'],
  ['get', '/api/v2/contribution-rules/{id}'],
  ['patch', '/api/v2/contribution-rules/{id}'],
  ['delete', '/api/v2/contribution-rules/{id}'],

  // V2 第一阶段批次 6 PR #1(2026-05-12;audit_logs 查询接口,沿 D6 v1.1 §5)
  // 不开放 POST / PATCH / PUT / DELETE / export(F5;写入后不可改不可删,红线)
  ['get', '/api/v2/audit-logs'],
  ['get', '/api/v2/audit-logs/{id}'],

  // V2.x C-6 RBAC 实施 PR #2(2026-05-14;permissions CRUD,沿 D7 v1.1 §5.1 端点 1-4)
  // 仅 Permission CRUD;Role / RolePermission / UserRole / RbacService / 判权
  // 接入由后续 PR #3-#6 完成。沿 F9:本 PR 接入仅入口 Guard @Roles,不接 RBAC 判权。
  ['get', '/api/v2/permissions'],
  ['post', '/api/v2/permissions'],
  ['patch', '/api/v2/permissions/{id}'],
  ['delete', '/api/v2/permissions/{id}'],

  // V2.x C-6 RBAC 实施 PR #3(2026-05-14;RbacRole CRUD,沿 D7 v1.1 §5.1 端点 5-9)
  // 软删(D4 v1.0;deletedAt);GET /:id 区分 30003(不存在)/ 30005 ROLE_DELETED(已软删);
  // detail 含 permissions 数组(D7 §5.2.6;RolePermission CRUD 未实施时永远空数组)。
  // PATCH / DELETE 不存在或已软删统一返 30003(沿 v1 §10 信息泄漏防御)。
  ['get', '/api/v2/roles'],
  ['post', '/api/v2/roles'],
  ['get', '/api/v2/roles/{id}'],
  ['patch', '/api/v2/roles/{id}'],
  ['delete', '/api/v2/roles/{id}'],

  // V2.x C-6 RBAC 实施 PR #4(2026-05-14;RolePermission 关联表,沿 D7 v1.1 §5.1 端点 10-11)
  // POST 批量授权(幂等;入参 permissionCodes[]);DELETE 撤权(精确 :permissionId);
  // BizCode 30011 ROLE_PERMISSION_NOT_FOUND(关系不存在);
  // 沿 D7 §9.4 缓存失效:授权/撤权后清所有持有该角色的 user cache。
  ['post', '/api/v2/roles/{id}/permissions'],
  ['delete', '/api/v2/roles/{id}/permissions/{permissionId}'],

  // V2.x C-6 RBAC 实施 PR #5(2026-05-14;UserRole CRUD,沿 D7 v1.1 §5.1 端点 12-14)
  // GET / POST / DELETE 用户角色;POST 入参 roleCode 单 code(沿 D7 §5.2.4);
  // BizCode 30006/30007/30101/30102;
  // Q7 C2 中庸角色分级(SUPER_ADMIN 通过 / 持 ops-admin 通过非 ops-admin / 其他 30102);
  // 最后一个 ops-admin 保护(沿 D7 §6.3;事务内 count + delete)。
  ['get', '/api/v2/users/{userId}/roles'],
  ['post', '/api/v2/users/{userId}/roles'],
  ['delete', '/api/v2/users/{userId}/roles/{roleId}'],

  // V2.x C-6 RBAC 实施 PR #6(2026-05-14;RbacService + me/permissions,沿 D7 v1.1 §5.1 端点 15)
  // 任何登录用户(@Roles(USER, ADMIN, SUPER_ADMIN));SUPER_ADMIN 返 Permission.code 全集
  //(沿用户拍板方案 B);其它角色返 user_roles → role_permissions → permissions 聚合后的并集。
  ['get', '/api/v2/rbac/me/permissions'],

  // V2.x C-6 RBAC 实施 PR #7(2026-05-14;RBAC reload 接口,沿 D7 v1.1 §5.1 端点 16 + §5.4)
  // 三档 scope:all(默认)/ user(+ userId)/ role(+ roleId);
  // 入口 @Roles(SUPER_ADMIN, ADMIN);scope=user 缺 userId / scope=role 缺 roleId → 400;
  // userId / roleId 不存在 → 200 静默成功(沿用户拍板四项决策);
  // 出参恒为 { reloaded: true };RBAC_FORBIDDEN 业务模块接入留后续 PR。
  ['post', '/api/v2/rbac/reload'],

  // V2.x C-7 attachments 实施 PR #3(2026-05-15;AttachmentTypeConfig CRUD,沿 D7 v1.0 §4.2 / §16 Q1-Q7)
  // 6 个端点:list / create / detail / update / updateStatus / softDelete;
  // 入口 @Roles(SUPER_ADMIN, ADMIN);**不接 rbac.can()**(F4 v1.0:配置三表是系统配置 / 运维能力);
  // BizCode 13020 ATTACHMENT_TYPE_CONFIG_NOT_FOUND / 13021 ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS /
  // 13023 INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT;
  // PATCH /:id 严禁 code(Q1)/ status(Q5 走独立 status 端点)/ deletedAt / id;
  // 软删 deletedAt = now() + 同步置 status=INACTIVE;
  // **本 PR 不实装**:AttachmentMimeConfig CRUD(PR #4)/ AttachmentSizeLimitConfig CRUD(PR #5)/
  // attachments 主模块 / Provider / audit / RBAC 业务判权 / ATTACHMENT_TYPE_CONFIG_IN_USE(13030)。
  ['get', '/api/v2/attachment-type-configs'],
  ['post', '/api/v2/attachment-type-configs'],
  ['get', '/api/v2/attachment-type-configs/{id}'],
  ['patch', '/api/v2/attachment-type-configs/{id}'],
  ['patch', '/api/v2/attachment-type-configs/{id}/status'],
  ['delete', '/api/v2/attachment-type-configs/{id}'],

  // V2.x C-7 attachments 实施 PR #4(2026-05-15;AttachmentMimeConfig CRUD,沿 D7 v1.0 §4.3 / §16 + Q1-Q8)
  // 6 个端点:list / create / detail / update / updateStatus / softDelete;
  // 入口 @Roles(SUPER_ADMIN, ADMIN);**不接 rbac.can()**(F4 v1.0);
  // BizCode 13022 ATTACHMENT_MIME_CONFIG_NOT_FOUND / 13024 ATTACHMENT_MIME_CONFIG_DUPLICATE /
  // 13025 INVALID_ATTACHMENT_MIME_FORMAT + 复用 13020 ATTACHMENT_TYPE_CONFIG_NOT_FOUND(Q5 v1.0);
  // PATCH /:id 仅 remark(Q3:mime 不可改 / Q4:typeConfigId 不可改 / Q5:status 走独立端点);
  // 出参嵌套 typeConfig: { id, code, displayName }(Q2 v1.0);
  // (typeConfigId, mime) UNIQUE 含软删历史(Q8 v1.0);软删 deletedAt = now() + 同步 INACTIVE;
  // **本 PR 不实装**:AttachmentSizeLimitConfig CRUD(PR #5)/ attachments 主模块 /
  // Provider / audit / RBAC 业务判权 / IN_USE 跨表约束(Q6 v1.0)。
  ['get', '/api/v2/attachment-mime-configs'],
  ['post', '/api/v2/attachment-mime-configs'],
  ['get', '/api/v2/attachment-mime-configs/{id}'],
  ['patch', '/api/v2/attachment-mime-configs/{id}'],
  ['patch', '/api/v2/attachment-mime-configs/{id}/status'],
  ['delete', '/api/v2/attachment-mime-configs/{id}'],

  // V2.x C-7 attachments 实施 PR #5(2026-05-15;AttachmentSizeLimitConfig CRUD,沿 D7 v1.0 §4.4 + Q1-Q8)
  // **5 个端点**(Q1 v1.0:本表无 status 字段,无独立 status 端点):list / create / detail / update / softDelete;
  // 入口 @Roles(SUPER_ADMIN, ADMIN);**不接 rbac.can()**(F4 v1.0);
  // BizCode 13026 ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND / 13027 ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS +
  // 复用 13020 ATTACHMENT_TYPE_CONFIG_NOT_FOUND(Q5 PR #4);
  // PATCH /:id 仅 maxSizeBytes / remark(Q4 PR #4:typeConfigId 不可改;Q5 v1.0:maxSizeBytes 不允许 null);
  // 出参嵌套独立 AttachmentSizeLimitConfigTypeConfigSummaryDto(Q4 v1.0:不复用 mime 的 summary DTO);
  // typeConfigId 1:1 UNIQUE 含软删历史(Q3 v1.0);软删 deletedAt = now()(Q7 v1.0:本表无 status,不同步置);
  // **本 PR 不实装**:attachments 主模块 / Provider / audit / RBAC 业务判权 / IN_USE 跨表约束 / status 字段。
  ['get', '/api/v2/attachment-size-limit-configs'],
  ['post', '/api/v2/attachment-size-limit-configs'],
  ['get', '/api/v2/attachment-size-limit-configs/{id}'],
  ['patch', '/api/v2/attachment-size-limit-configs/{id}'],
  ['delete', '/api/v2/attachment-size-limit-configs/{id}'],

  // V2.x C-7 attachments 实施 PR #6b(2026-05-15;attachments 主模块 7 端点,沿 D7 v1.0 §5.1)
  // 入口仅 JwtAuthGuard(F3 v1.0;**不加** @Roles);全部判权在 Service 层 rbac.can()。
  // BizCode 13001 ATTACHMENT_NOT_FOUND / 13010 ATTACHMENT_OWNER_TYPE_INVALID /
  // 13011 ATTACHMENT_OWNER_NOT_FOUND / 13012 ATTACHMENT_MIME_NOT_ALLOWED /
  // 13013 ATTACHMENT_SIZE_EXCEEDED / 13015 ATTACHMENT_PII_DETECTED;
  // 复用 30100 RBAC_FORBIDDEN(写路径)+ 信息泄漏防御 13001(读路径)。
  // 路径顺序铁律:/by-owner / /me/uploaded 字面段在 /:id 之前(NestJS 字面段优先 :id)。
  // **本 PR 不实装**:audit_logs 接入(留 PR #6c)/ Provider 文件层(Q15 挂起)。
  ['post', '/api/v2/attachments'],
  ['get', '/api/v2/attachments'],
  // V2.x C-7.5 实施 PR #10:upload-url + confirm-upload(沿评审 §8.1 / §8.2 / §8.3 / §8.4)
  // 路径顺序铁律:字面段优先,必须放在 :id 之前(沿 §8.2)
  ['post', '/api/v2/attachments/upload-url'],
  ['post', '/api/v2/attachments/confirm-upload'],
  ['get', '/api/v2/attachments/by-owner'],
  ['get', '/api/v2/attachments/me/uploaded'],
  ['get', '/api/v2/attachments/{id}'],
  ['patch', '/api/v2/attachments/{id}'],
  ['delete', '/api/v2/attachments/{id}'],

  // V2.x C-7.5 实施 PR #11:Storage Settings admin Controller(沿评审 §6.5 / §6.6 + Q-11)
  ['get', '/api/v2/storage-settings'],
  ['patch', '/api/v2/storage-settings'],
  ['post', '/api/v2/storage-settings/reset-credentials'],

  // Phase 2 P2-1(2026-05-19):App /api/app/v1/me* 三 endpoint
  // 沿 docs/app-api-phase-2-review.md §2 接口清单;新 path 默认 /api/app/v1/*(沿
  // docs/api-client-boundary-migration-plan.md §5 Phase 3 方案 C);旧 /api/users/me*
  // 行为**逐字不变**(沿 §3.2 + §9.2 #9 path stability)。
  ['get', '/api/app/v1/me'],
  ['get', '/api/app/v1/me/account'],
  ['get', '/api/app/v1/me/capabilities'],

  // Phase 2 P2-2(2026-05-20):App /api/app/v1/me/profile GET + PATCH
  // 沿 docs/app-api-p2-2-profile-review.md §7.3 + §9.3;字段集恰好 9(GET 出参)/ 2(PATCH 入参);
  // canUseApp=false → FORBIDDEN(40300);empty body / forbidden field → BAD_REQUEST(40000);
  // P2-2 不新增 BizCode(沿 §6.1);旧 /api/users/me 行为**逐字不变**(沿 §10.3 + §14.2)。
  ['get', '/api/app/v1/me/profile'],
  ['patch', '/api/app/v1/me/profile'],

  // Phase 2 P2-3(2026-05-20):App /api/app/v1/me/password
  // 沿 docs/app-api-p2-3-password-review.md §1 + §11;**复用** ChangeMyPasswordDto +
  // UserResponseDto(0 新 DTO 注册到 components.schemas);**复用** UsersService.changeMyPassword +
  // @PasswordChangeThrottle() + password.change.self audit + refresh token 撤销
  // (revokedReason='self-password-change');**0 新 BizCode**;
  // **D-P2-3-1 = X**(沿评审稿 §4.3 锁定):admin without member 允许使用,
  // 该豁免**严格仅本端点**适用(沿 §4.6);旧 /api/users/me/password 行为**逐字不变**。
  ['put', '/api/app/v1/me/password'],

  // Phase 2 P2-4a(2026-05-20):App /api/app/v1/activities/available 列表
  // 沿 docs/app-api-p2-4-activities-review.md §1 接口清单 + §4.1 字段集恰好 11 项;
  // 可见性沿 D-P2-4-1 = A:仅 statusCode='published' AND deletedAt IS NULL;
  // canUseApp=false → FORBIDDEN(40300);不沿 P2-3 admin-without-member 例外(沿 §6.2);
  // 0 新 BizCode;0 schema 变更;旧 /api/v2/activities* 行为**逐字不变**(沿 §11.4)。
  // **D-P2-4-5 = split**:P2-4b `GET /:id` 详情独立 PR(本 spec 不含 detail 路径)。
  ['get', '/api/app/v1/activities/available'],
];

// 至少必须出现的 schema(DTO)清单。新增重要 DTO 时按需扩充。
const EXPECTED_SCHEMAS: readonly string[] = [
  'LoginDto',
  'CreateUserDto',
  'UpdateUserDto',
  'UpdateMyProfileDto',
  'UpdateUserRoleDto',
  'UpdateUserStatusDto',
  'ResetUserPasswordDto',
  'UserResponseDto',
  'LoginResponseDto',
  'HealthResponseDto',
  'PageResultDto',

  // V2 dictionaries (Step 3)
  'CreateDictTypeDto',
  'UpdateDictTypeDto',
  'UpdateDictTypeStatusDto',
  'DictTypeResponseDto',
  'CreateDictItemDto',
  'UpdateDictItemDto',
  'UpdateDictItemStatusDto',
  'DictItemResponseDto',
  'DictItemTreeNodeDto',

  // V2 organizations (Step 4)
  'CreateOrganizationDto',
  'UpdateOrganizationDto',
  'UpdateOrganizationStatusDto',
  'OrganizationResponseDto',
  'OrganizationTreeNodeDto',

  // V2 members (Step 5)
  'CreateMemberDto',
  'UpdateMemberDto',
  'UpdateMemberStatusDto',
  'MemberResponseDto',

  // V2 member-departments (Step 6)
  'SetMemberDepartmentDto',
  'MemberDepartmentResponseDto',

  // V2 第一阶段批次 1 member-profiles
  'CreateMemberProfileDto',
  'UpdateMemberProfileDto',
  'MemberProfileResponseDto',
  'MedicalNoteItemDto',

  // V2 第一阶段批次 1 emergency-contacts
  'CreateEmergencyContactDto',
  'UpdateEmergencyContactDto',
  'EmergencyContactResponseDto',

  // V2 第一阶段批次 2 certificates
  // 注:QualificationFlagQueryDto 是 @Query() DTO,NestJS Swagger 把其属性内联为
  // parameters,不进 components.schemas;这里**不列**,与 @Body() / 出参 DTO 区分。
  'CreateCertificateDto',
  'UpdateCertificateDto',
  'VerifyCertificateDto',
  'RejectCertificateDto',
  'CertificateResponseDto',
  'CertificateListItemDto',
  'QualificationFlagResponseDto',

  // V2 第一阶段批次 3A activities + activity-registrations
  // 注:ListActivitiesQueryDto / ListRegistrationsQueryDto / ListMyRegistrationsQueryDto /
  //   ExportRegistrationsQueryDto / ActivityIdParamDto / ActivityRegistrationIdParamDto
  //   均为 @Query / @Param DTO,被内联为 parameters,不进 components.schemas。
  'CreateActivityDto',
  'UpdateActivityDto',
  'CancelActivityDto',
  'ActivityResponseDto',
  'ActivityListItemDto',
  'CreateRegistrationDto',
  'CreateMyRegistrationDto',
  'ApproveRegistrationDto',
  'RejectRegistrationDto',
  'CancelRegistrationDto',
  'ActivityRegistrationResponseDto',
  'ActivityRegistrationListItemDto',

  // V2 第一阶段批次 3B attendances
  // 注:ListAttendanceSheetsQueryDto / MyAttendanceRecordsQueryDto / ActivityIdParamDto
  //   均为 @Query / @Param DTO,被内联为 parameters,不进 components.schemas。
  //   AttendanceMemberSummaryDto / AttendanceSheetActivitySummaryDto 仅作为嵌套字段类型,
  //   Swagger 内联为父 DTO 的 property 而不注册为 named schema(沿 batch 1 / 2 嵌套范式)。
  'AttendanceRecordInputDto',
  'CreateAttendanceSheetDto',
  'UpdateAttendanceSheetDto',
  'ApproveAttendanceSheetDto',
  'RejectAttendanceSheetDto',
  'AttendanceSheetResponseDto',
  'AttendanceSheetListItemDto',
  'AttendanceRecordResponseDto',
  'AttendanceSheetReviewDetailDto',

  // V2 第一阶段批次 4-B(APD 部门部长 / 副部长终审)
  'FinalApproveAttendanceSheetDto',
  'FinalRejectAttendanceSheetDto',

  // V2 第一阶段批次 5-A contribution-rules
  // 注:ContributionRuleQueryDto 是 @Query() DTO,NestJS Swagger 把其属性内联为
  //   parameters,不进 components.schemas(沿 batch 3 ListActivities / Attendance 范式)。
  'CreateContributionRuleDto',
  'UpdateContributionRuleDto',
  'ContributionRuleResponseDto',

  // V2 第一阶段批次 6 PR #1 audit-logs
  // 注:AuditLogQueryDto 是 @Query() DTO,被内联为 parameters,不进 components.schemas。
  //   AuditContextDto 是嵌套 DTO(AuditLogResponseDto.context 字段引用),Swagger 注册为 named schema。
  'AuditContextDto',
  'AuditLogResponseDto',

  // V2.x C-6 RBAC 实施 PR #2 permissions(2026-05-14;沿 D7 v1.1 §5.2)
  // 注:ListPermissionsQueryDto 是 @Query() DTO,被内联为 parameters,不进 components.schemas。
  'CreatePermissionDto',
  'UpdatePermissionDto',
  'PermissionResponseDto',

  // V2.x C-6 RBAC 实施 PR #3 rbac-roles(2026-05-14;沿 D7 v1.1 §5.2.2 / §5.2.6)
  // 注:ListRbacRolesQueryDto 是 @Query() DTO,被内联为 parameters,不进 components.schemas。
  //   RbacRoleDetailResponseDto extends RbacRoleResponseDto + 含 permissions: PermissionResponseDto[]
  //   字段;Swagger 注册为独立 named schema。
  'CreateRbacRoleDto',
  'UpdateRbacRoleDto',
  'RbacRoleResponseDto',
  'RbacRoleDetailResponseDto',

  // V2.x C-6 RBAC 实施 PR #4 role-permissions(2026-05-14;沿 D7 v1.1 §5.2.3)
  // 注:RevokeRolePermissionParamDto 是 @Param() DTO,被内联为 parameters,不进 components.schemas。
  //   出参复用 RbacRoleDetailResponseDto(沿 RbacRole detail 范式)。
  'AssignRolePermissionsDto',

  // V2.x C-6 RBAC 实施 PR #5 user-roles(2026-05-14;沿 D7 v1.1 §5.2.4 / §5.2.6)
  // 注:UserIdParamDto / RevokeUserRoleParamDto 是 @Param() DTO,被内联为 parameters,
  //   不进 components.schemas。
  //   AssignUserRoleDto 是 @Body() 单字段 DTO,UserRoleResponseDto 是出参,均注册为 named schema。
  'AssignUserRoleDto',
  'UserRoleResponseDto',

  // V2.x C-6 RBAC 实施 PR #6 rbac me/permissions(2026-05-14;沿 D7 v1.1 §5.2.6 / §5.3)
  // MyPermissionsResponseDto 出参 + EffectiveRoleDto 嵌套 DTO(@ApiExtraModels 显式声明
  // 注册为独立 named schema)。
  'MyPermissionsResponseDto',
  'EffectiveRoleDto',

  // V2.x C-6 RBAC 实施 PR #7 rbac reload(2026-05-14;沿 D7 v1.1 §5.2.5 / §5.4)
  // ReloadRbacDto 是 @Body() DTO + ReloadRbacResponseDto 是出参,均注册为 named schema。
  'ReloadRbacDto',
  'ReloadRbacResponseDto',

  // V2.x C-7 attachments 实施 PR #3 attachment-type-configs(2026-05-15;沿 D7 v1.0 §4.2 / §16 Q1-Q7)
  // CreateAttachmentTypeConfigDto / UpdateAttachmentTypeConfigDto / UpdateAttachmentTypeConfigStatusDto
  // 是 @Body() DTO;AttachmentTypeConfigResponseDto 是出参;均注册为 named schema。
  // 注:ListAttachmentTypeConfigsQueryDto 是 @Query() DTO 继承 PaginationQueryDto,
  //   NestJS swagger 反射时不一定独立 schema(若反射出来则也加入本表;否则保持注释即可)。
  'CreateAttachmentTypeConfigDto',
  'UpdateAttachmentTypeConfigDto',
  'UpdateAttachmentTypeConfigStatusDto',
  'AttachmentTypeConfigResponseDto',

  // V2.x C-7 attachments 实施 PR #4 attachment-mime-configs(2026-05-15;沿 D7 v1.0 §4.3 + Q1-Q8)
  // CreateAttachmentMimeConfigDto / UpdateAttachmentMimeConfigDto / UpdateAttachmentMimeConfigStatusDto
  // 是 @Body() DTO;AttachmentMimeConfigResponseDto 是出参;
  // AttachmentMimeConfigTypeConfigSummaryDto 是嵌套 typeConfig 摘要(@ApiExtraModels 显式注册);
  // 均注册为 named schema。
  'CreateAttachmentMimeConfigDto',
  'UpdateAttachmentMimeConfigDto',
  'UpdateAttachmentMimeConfigStatusDto',
  'AttachmentMimeConfigResponseDto',
  'AttachmentMimeConfigTypeConfigSummaryDto',

  // V2.x C-7 attachments 实施 PR #5 attachment-size-limit-configs(2026-05-15;沿 D7 v1.0 §4.4 + Q1-Q8)
  // CreateAttachmentSizeLimitConfigDto / UpdateAttachmentSizeLimitConfigDto 是 @Body() DTO;
  // AttachmentSizeLimitConfigResponseDto 是出参;
  // AttachmentSizeLimitConfigTypeConfigSummaryDto 是嵌套 typeConfig 摘要(Q4 v1.0:独立 DTO,
  //   不复用 mime 的 summary;@ApiExtraModels 显式注册);均注册为 named schema。
  // **本表无 UpdateStatusDto**(Q1 v1.0:本表无 status 字段;无独立 status 端点)。
  'CreateAttachmentSizeLimitConfigDto',
  'UpdateAttachmentSizeLimitConfigDto',
  'AttachmentSizeLimitConfigResponseDto',
  'AttachmentSizeLimitConfigTypeConfigSummaryDto',

  // V2.x C-7 attachments 实施 PR #6b attachments 主模块(2026-05-15;沿 D7 v1.0 §5.4)
  // CreateAttachmentDto / UpdateAttachmentDto 是 @Body() DTO;
  // AttachmentResponseDto 是出参(含 accessUrl 占位字段;Q14 v1.0 恒返 null);
  // 注:ListAttachmentsQueryDto / ListAttachmentsByOwnerQueryDto / PaginationQueryDto(me/uploaded)
  //   均为 @Query() DTO,被内联为 parameters,不进 components.schemas。
  //   IdParamDto 复用 common/dto/id-param.dto,不重复注册。
  'CreateAttachmentDto',
  'UpdateAttachmentDto',
  'AttachmentResponseDto',

  // V2.x C-7.5 实施 PR #10:upload-url + confirm-upload DTO(沿评审 §8.3 / §8.4 + Q-10-14)
  // GenerateUploadUrlDto:upload-url 入参(5 字段;沿 §8.3.1)
  // UploadUrlResponseDto:upload-url 出参(6 字段含 uploadToken;沿 §8.3.2)
  // ConfirmUploadDto:confirm-upload 入参(1 必填 + 1 可选;沿 §8.4.1)
  'GenerateUploadUrlDto',
  'UploadUrlResponseDto',
  'ConfirmUploadDto',

  // V2.x C-7.5 实施 PR #11:Storage Settings admin DTO(沿评审 §6.5 / §6.6 + Q-11)
  // StorageSettingsResponseDto:出参(永不含 secret/Encrypted/credentials;沿 §6.6.2)
  // UpdateStorageSettingsDto:PATCH 入参(白名单;严禁凭证字段)
  // ResetStorageCredentialsDto:reset 入参(仅 secretId + secretKey)
  'StorageSettingsResponseDto',
  'UpdateStorageSettingsDto',
  'ResetStorageCredentialsDto',

  // Phase 2 P2-1(2026-05-19):App /api/app/v1/me* DTO
  // AppMeResponseDto / AppMeAccountDto:GET /me + /me/account 出参,均独立注册为 named schema
  // (沿 Phase 0.7 §2.2 #1-#2:**禁止**继承 / Pick / Omit Admin DTO,DTO 物理隔离)。
  // AppCapabilityResponseDto + 6 个 namespace 子 DTO(account / activities / attendance /
  // certificates / tasks / managed):嵌套结构,均独立注册为 named schema(沿 §4.2 冻结结构)。
  // 沿 §4.3 #7:reason 字段是展示字符串,**不**绑定 BizCode 段位;P2-1 不新增 BizCode。
  'AppMeResponseDto',
  'AppMeAccountDto',
  'AppCapabilityResponseDto',
  'AppCapabilityAccountDto',
  'AppCapabilityActivitiesDto',
  'AppCapabilityAttendanceDto',
  'AppCapabilityCertificatesDto',
  'AppCapabilityTasksDto',
  'AppCapabilityManagedDto',

  // Phase 2 P2-2(2026-05-20):App /api/app/v1/me/profile DTO
  // AppSelfProfileDto:GET / PATCH 共用出参,字段恰好 9(沿 §2.4 v0.1 锁定)。
  // UpdateAppSelfProfileDto:PATCH 入参,字段恰好 2(`nickname` / `avatarKey`;沿 §3.1)。
  // 两 DTO 均独立注册为 named schema;**禁止**继承 / Pick / Omit Admin DTO(沿 §4.3 + Phase 0.7 §2.2)。
  'AppSelfProfileDto',
  'UpdateAppSelfProfileDto',

  // Phase 2 P2-4a(2026-05-20):App /api/app/v1/activities/available 列表 DTO
  // AppAvailableActivityListItemDto:列表 item 出参,字段恰好 11(沿 §4.1 v0.1 锁定);
  // 独立 class,**禁止**继承 / Pick / Omit / Mapped Types Admin DTO(沿 §4.3 + Phase 0.7 §2.2)。
  // 分页外层走 @ApiWrappedPageResponse(已注册 PageResultDto + AppAvailableActivityListItemDto)。
  'AppAvailableActivityListItemDto',
];

describe('OpenAPI 契约快照', () => {
  let app: INestApplication;
  let doc: OpenApiDoc;

  beforeAll(async () => {
    app = await createTestApp();
    const res = await request(httpServer(app)).get('/api/docs-json');
    expect(res.status).toBe(200);
    doc = res.body as OpenApiDoc;
  });

  afterAll(async () => {
    await app.close();
  });

  it('OpenAPI 文档可生成,顶层字段齐全', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('U Nest API Starter');
    expect(typeof doc.info.version).toBe('string');
    expect(doc.paths).toBeDefined();
    expect(doc.components?.schemas).toBeDefined();
    expect(doc.components?.securitySchemes).toBeDefined();
    // bearer 鉴权方案必须存在
    const securitySchemes = doc.components?.securitySchemes ?? {};
    const hasBearer = Object.values(securitySchemes).some(
      (s) => typeof s === 'object' && s !== null && (s as { scheme?: string }).scheme === 'bearer',
    );
    expect(hasBearer).toBe(true);
  });

  it.each(EXPECTED_ROUTES)('路由仍存在: %s %s', (method, path) => {
    const item = doc.paths[path];
    expect(item).toBeDefined();
    expect(item[method]).toBeDefined();
    // 每个 operation 必须声明响应,避免漏写 @ApiWrappedXxxResponse 装饰器
    expect(item[method]?.responses).toBeDefined();
    expect(Object.keys(item[method]?.responses ?? {}).length).toBeGreaterThan(0);
  });

  it('未出现意料之外的路由(全量路由集合与白名单一致)', () => {
    const actual = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item) as Array<keyof OpenApiPathItem>) {
        actual.add(`${method} ${path}`);
      }
    }
    const expected = new Set(EXPECTED_ROUTES.map(([m, p]) => `${m} ${p}`));
    const extraInActual = [...actual].filter((r) => !expected.has(r)).sort();
    const missingInActual = [...expected].filter((r) => !actual.has(r)).sort();
    expect({ extraInActual, missingInActual }).toEqual({ extraInActual: [], missingInActual: [] });
  });

  it.each(EXPECTED_SCHEMAS)('Schema 仍存在: %s', (schemaName) => {
    expect(doc.components?.schemas?.[schemaName]).toBeDefined();
  });

  it('paths 段快照(锁定每个 operation 的响应结构)', () => {
    // 仅快照 paths,排除 info.version(随发布递增,不视作 schema 漂移)。
    expect(doc.paths).toMatchSnapshot();
  });

  it('components.schemas 段快照(锁定 DTO 字段集合与类型)', () => {
    expect(doc.components?.schemas).toMatchSnapshot();
  });
});
