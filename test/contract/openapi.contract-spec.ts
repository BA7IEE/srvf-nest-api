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

  ['get', '/api/health'],
  ['get', '/api/health/live'],
  ['get', '/api/health/ready'],

  ['get', '/api/users/me'],
  ['patch', '/api/users/me'],
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
