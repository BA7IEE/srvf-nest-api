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
  deprecated?: boolean;
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
  // Route B Phase 4(2026-06-01;沿 docs/api-surface-migration-plan.md §6 Phase 4):
  // auth → auth/v1、health → system/v1/health 的老 path 已删除(无生产消费者,直接收口);
  // 下列为 canonical 单一前缀。
  ['post', '/api/auth/v1/login'],
  ['post', '/api/auth/v1/refresh'],
  ['post', '/api/auth/v1/logout'],
  ['post', '/api/auth/v1/logout-all'],
  // 找回密码 T2(2026-06-11;冻结评审稿 password-reset-by-sms-review.md §3.2):
  // pre-auth 两端点,155→157。
  ['post', '/api/auth/v1/password-reset/send-code'],
  ['post', '/api/auth/v1/password-reset'],
  // OTP 登录 F4-T2(2026-06-11;冻结评审稿 queue-b-otp-birthday-infra-review.md §5.2):
  // pre-auth 两端点,157→159;登录成功响应复用 LoginResponseDto(与密码登录同 DTO)。
  ['post', '/api/auth/v1/login-sms/send-code'],
  ['post', '/api/auth/v1/login-sms'],
  // 微信小程序登录 T3(2026-06-12;冻结评审稿 wechat-mini-login-review.md §3.2 ④-⑥):
  // 第三个独立认证端点 + 手机短信锚点绑定两端点,162→165(连同 me/wechat 与 admin 清除 →168);
  // login-wechat 未绑返 bindingRequired:true;wechat-bind 成功响应复用 LoginResponseDto。
  ['post', '/api/auth/v1/login-wechat'],
  ['post', '/api/auth/v1/wechat-bind/send-code'],
  ['post', '/api/auth/v1/wechat-bind'],
  ['get', '/api/system/v1/health'],
  ['get', '/api/system/v1/health/live'],
  ['get', '/api/system/v1/health/ready'],
  ['get', '/api/app/v1/me'],
  ['get', '/api/app/v1/me/account'],
  ['get', '/api/app/v1/me/capabilities'],

  // Phase 2 P2-2(2026-05-20):App /api/app/v1/me/profile GET + PATCH
  // 沿 docs/app-api-p2-2-profile-review.md §7.3 + §9.3;字段集恰好 9(GET 出参)/ 2(PATCH 入参);
  // canUseApp=false → FORBIDDEN(40300);empty body / forbidden field → BAD_REQUEST(40000);
  // P2-2 不新增 BizCode(沿 §6.1);字段集 / 行为契约沿 §10.3 + §14.2 锁定。
  ['get', '/api/app/v1/me/profile'],
  ['patch', '/api/app/v1/me/profile'],

  // Phase 2 P2-3(2026-05-20):App /api/app/v1/me/password
  // 沿 docs/app-api-p2-3-password-review.md §1 + §11;**复用** ChangeMyPasswordDto +
  // UserResponseDto(0 新 DTO 注册到 components.schemas);**复用** UsersService.changeMyPassword +
  // @PasswordChangeThrottle() + password.change.self audit + refresh token 撤销
  // (revokedReason='self-password-change');**0 新 BizCode**;
  // **D-P2-3-1 = X**(沿评审稿 §4.3 锁定):admin without member 允许使用,
  // 该豁免**严格仅本端点**适用(沿 §4.6)。
  ['put', '/api/app/v1/me/password'],
  // SMS 基础设施 T3(2026-06-10;评审稿 §3.2 ⑤⑥):账号级手机号绑定,沿 me/password
  // 豁免先例不强约 canUseApp(E-5);phone/send-code 发码 + phone 验码绑定/换绑一体。
  ['post', '/api/app/v1/me/phone/send-code'],
  ['put', '/api/app/v1/me/phone'],
  // 微信小程序登录 T3(2026-06-12;wechat 评审稿 §3.2 ⑦⑧):账号级微信绑定,沿 me/phone
  // 豁免先例(E-18);GET 状态查询(openid 掩码)+ PUT 绑定/换绑一体(JWT 已证身份免短信)。
  ['get', '/api/app/v1/me/wechat'],
  ['put', '/api/app/v1/me/wechat'],

  // 保险模块 T2(2026-06-13;insurance-module-review.md §3.2 端点 1-4):App 自助自购保险
  // CRUD,self-scope 锁 currentUser.memberId 不接 RBAC(D-INS-3);无 :id 详情端点(E-14);
  // 他人/不存在/已删统一 26001 防侧信道;新 BizCode 260xx 段 5 码(26030 门槛随 T3)。
  ['get', '/api/app/v1/me/insurances'],
  ['post', '/api/app/v1/me/insurances'],
  ['patch', '/api/app/v1/me/insurances/{id}'],
  ['delete', '/api/app/v1/me/insurances/{id}'],

  // Phase 2 P2-4a(2026-05-20):App /api/app/v1/activities/available 列表
  // 沿 docs/app-api-p2-4-activities-review.md §1 接口清单 + §4.1 字段集恰好 11 项;
  // 可见性沿 D-P2-4-1 = A:仅 statusCode='published' AND deletedAt IS NULL;
  // canUseApp=false → FORBIDDEN(40300);不沿 P2-3 admin-without-member 例外(沿 §6.2);
  // 0 新 BizCode;0 schema 变更;行为契约沿 §11.4 锁定。
  ['get', '/api/app/v1/activities/available'],

  // Phase 2 P2-4b(2026-05-20):App /api/app/v1/activities/{id} 详情
  // 沿 docs/app-api-p2-4-activities-review.md §1 接口清单 + §5.1 字段集恰好 13 项;
  // 可见性沿 D-P2-4-1 = A:仅 statusCode='published' AND deletedAt IS NULL;
  // 不可见(draft / cancelled / completed / 软删 / 不存在)统一 → 404 ACTIVITY_NOT_FOUND
  // (沿 D-P2-4-3 v0.1 锁定;避免存在性侧信道);
  // 0 新 BizCode(复用既有 ACTIVITY_NOT_FOUND=20001);0 schema 变更;
  // 行为契约沿 §11.4 锁定。
  ['get', '/api/app/v1/activities/{id}'],

  // Phase 2 P2-5a(2026-05-20):App /api/app/v1/my/* 3 只读 endpoint
  // 沿 docs/app-api-p2-5-registrations-review.md §13.7 + D-P2-5-5;5 endpoint 全部
  // 挂在 AppMyRegistrationsController @Controller('app/v1/my');本 PR 仅落 3 GET,
  // 写 2 endpoint(POST / PATCH cancel)留 P2-5b。
  // 准入沿 §7.1 / §7.3 + D-5.2:5 endpoint 全部前置 AppIdentityResolver.resolve +
  // canUseApp;**不**沿 D-P2-3-1 admin-without-member 例外。
  // 0 新 BizCode(D-P2-5-10);0 schema 变更;行为契约沿 §5.3 + §15.2 + 风险 14.13 锁定
  // (PR review 强查 controller.ts 无 diff)。
  ['get', '/api/app/v1/my/registrations'],
  ['get', '/api/app/v1/my/registrations/{id}'],
  ['get', '/api/app/v1/my/activities'],

  // Phase 2 P2-5b(2026-05-20):App /api/app/v1/my/registrations 2 写 endpoint
  // 沿 docs/app-api-p2-5-registrations-review.md §13.7 + D-P2-5-5 / D-P2-5-8 / D-P2-5-9 /
  // D-P2-5-10;两 endpoint 挂在同一 AppMyRegistrationsController(P2-5a 已建)。
  // 准入沿 §7.1(canUseApp 前置);D-P2-5-8 锁定 cancelled/draft/completed/soft-deleted 活动
  // 统一抛 ACTIVITY_NOT_FOUND=20001 防侧信道;复用既有 audit event registration.create /
  // registration.review;0 新 BizCode;0 schema 变更;旧 admin / me write path 行为不变。
  ['post', '/api/app/v1/my/registrations'],
  ['patch', '/api/app/v1/my/registrations/{id}/cancel'],

  // Phase 2 P2-6(2026-05-20):App /api/app/v1/my/attendance-records 1 endpoint
  // 沿 docs/app-api-p2-6-attendance-records-review.md §4 endpoint 契约 + §5 字段集恰好 14;
  // 复用 attendances.service.listMyRecords(沿 D-P2-6-2 thin-wrap;0 service diff);
  // AppMy service 内 2 次 IN 批量查 AttendanceSheet + Activity(沿 D-P2-6-6 + §7.4 默认方案);
  // 0 新 BizCode / 0 schema / 0 migration / 0 新依赖;
  // 行为契约沿 D-P2-6-15 + §11.1 path stability 锁定。
  ['get', '/api/app/v1/my/attendance-records'],

  // Phase 2 P2-7(2026-05-20):App /api/app/v1/my/certificates 1 endpoint
  // 沿 docs/app-api-p2-7-my-certificates-review.md §4 endpoint 契约 + §5 字段集恰好 12;
  // 独立 AppMyCertificatesService(沿 D-P2-7-9;**不** thin-wrap certificates.service.list;
  // **不**新增 listForMember);PrismaService 直查 Certificate(memberId + deletedAt:null + 可选
  // certStatusCode / certTypeCode filter;orderBy createdAt desc);
  // 0 新 BizCode / 0 schema / 0 migration / 0 新依赖;
  // 行为契约沿 D-P2-7-15 + §11.1 锁定。
  ['get', '/api/app/v1/my/certificates'],

  // System surface(Ops-* tag;56 路由):终态前缀 /api/system/v1/*
  // (Route B 终态;v2 老前缀已于 Phase 4 删除,沿 docs/api-surface-migration-plan.md §3.4)。
  ['get', '/api/system/v1/dict-types'],
  ['post', '/api/system/v1/dict-types'],
  ['get', '/api/system/v1/dict-types/{id}'],
  ['patch', '/api/system/v1/dict-types/{id}'],
  ['patch', '/api/system/v1/dict-types/{id}/status'],
  ['delete', '/api/system/v1/dict-types/{id}'],
  ['get', '/api/system/v1/dict-items'],
  ['post', '/api/system/v1/dict-items'],
  ['get', '/api/system/v1/dict-items/tree'],
  ['get', '/api/system/v1/dict-items/{id}'],
  ['patch', '/api/system/v1/dict-items/{id}'],
  ['patch', '/api/system/v1/dict-items/{id}/status'],
  ['delete', '/api/system/v1/dict-items/{id}'],
  ['get', '/api/system/v1/contribution-rules'],
  ['post', '/api/system/v1/contribution-rules'],
  ['get', '/api/system/v1/contribution-rules/{id}'],
  ['patch', '/api/system/v1/contribution-rules/{id}'],
  ['delete', '/api/system/v1/contribution-rules/{id}'],
  ['get', '/api/system/v1/audit-logs'],
  ['get', '/api/system/v1/audit-logs/{id}'],
  ['get', '/api/system/v1/permissions'],
  ['post', '/api/system/v1/permissions'],
  ['patch', '/api/system/v1/permissions/{id}'],
  ['delete', '/api/system/v1/permissions/{id}'],
  ['get', '/api/system/v1/roles'],
  // F1/A4(admin-api-fe-integration-roadmap.md §4 A4;D4:roles 选择器落 system/v1)。
  ['get', '/api/system/v1/roles/options'],
  ['post', '/api/system/v1/roles'],
  ['get', '/api/system/v1/roles/{id}'],
  ['patch', '/api/system/v1/roles/{id}'],
  ['delete', '/api/system/v1/roles/{id}'],
  ['post', '/api/system/v1/roles/{id}/permissions'],
  ['delete', '/api/system/v1/roles/{id}/permissions/{permissionId}'],
  ['get', '/api/system/v1/users/{userId}/roles'],
  ['post', '/api/system/v1/users/{userId}/roles'],
  ['delete', '/api/system/v1/users/{userId}/roles/{roleId}'],
  ['get', '/api/system/v1/rbac/me/permissions'],
  ['post', '/api/system/v1/rbac/reload'],
  ['get', '/api/system/v1/attachment-type-configs'],
  ['post', '/api/system/v1/attachment-type-configs'],
  ['get', '/api/system/v1/attachment-type-configs/{id}'],
  ['patch', '/api/system/v1/attachment-type-configs/{id}'],
  ['patch', '/api/system/v1/attachment-type-configs/{id}/status'],
  ['delete', '/api/system/v1/attachment-type-configs/{id}'],
  ['get', '/api/system/v1/attachment-mime-configs'],
  ['post', '/api/system/v1/attachment-mime-configs'],
  ['get', '/api/system/v1/attachment-mime-configs/{id}'],
  ['patch', '/api/system/v1/attachment-mime-configs/{id}'],
  ['patch', '/api/system/v1/attachment-mime-configs/{id}/status'],
  ['delete', '/api/system/v1/attachment-mime-configs/{id}'],
  ['get', '/api/system/v1/attachment-size-limit-configs'],
  ['post', '/api/system/v1/attachment-size-limit-configs'],
  ['get', '/api/system/v1/attachment-size-limit-configs/{id}'],
  ['patch', '/api/system/v1/attachment-size-limit-configs/{id}'],
  ['delete', '/api/system/v1/attachment-size-limit-configs/{id}'],
  ['get', '/api/system/v1/storage-settings'],
  ['patch', '/api/system/v1/storage-settings'],
  ['post', '/api/system/v1/storage-settings/reset-credentials'],

  // SMS 基础设施 T2(2026-06-10;冻结评审稿 docs/archive/reviews/sms-verification-infra-review.md §3.2):
  // settings 三端点动词镜像 storage-settings 现状(评审稿 E-1)+ send-logs 分页只读;
  // T3 已增 app/v1/me/phone* 两端点与 admin 清号端点(见各 surface 段)。
  ['get', '/api/system/v1/sms-settings'],
  ['patch', '/api/system/v1/sms-settings'],
  ['post', '/api/system/v1/sms-settings/reset-credentials'],
  ['get', '/api/system/v1/sms-send-logs'],

  // 微信小程序登录 T2(2026-06-12;冻结评审稿 docs/archive/reviews/wechat-mini-login-review.md §3.2):
  // settings 三端点动词镜像 sms-settings 现状(评审稿 E-6),159→162;
  // T3 将增 auth/v1 三公开端点 + app/v1/me/wechat 两端点 + admin 清除端点(届时 →168)。
  ['get', '/api/system/v1/wechat-settings'],
  ['patch', '/api/system/v1/wechat-settings'],
  ['post', '/api/system/v1/wechat-settings/reset-credentials'],

  // 招新一期 · 实名核验通道 T2(2026-06-18):realname-settings 三端点(评审稿 §3.2 端点 1-3;
  // 路径动词镜像 wechat/sms-settings;183→186);T3 将增 recruitment 公开/admin 端点(届时 →~196)。
  ['get', '/api/system/v1/realname-settings'],
  ['patch', '/api/system/v1/realname-settings'],
  ['post', '/api/system/v1/realname-settings/reset-credentials'],

  // Admin surface(Admin-* tag;74 路由):终态前缀 /api/admin/v1/*
  // (Route B 终态;v2 老前缀已于 Phase 4 删除,沿 docs/api-surface-migration-plan.md §3.4)。
  // 注:历史 mobile-like 自助端点已收口到 App surface(/api/app/v1/me|my/*);
  // 原 *-legacy controller 已于 Phase 4 删除,App 自助流由 app-me / app-my-* controller 承载。
  // Admin 自视角本人身份只读 bootstrap(2026-06-14;AdminMeController,单一 'Admin - Me' tag;
  // 任意登录用户返本人身份 9 字段,不内联角色/权限——权限走 system/v1/rbac/me/permissions)。
  ['get', '/api/admin/v1/me'],
  ['get', '/api/admin/v1/users'],
  // F1/A2(admin-api-fe-integration-roadmap.md §4 A2)。
  ['get', '/api/admin/v1/users/options'],
  ['post', '/api/admin/v1/users'],
  ['get', '/api/admin/v1/users/{id}'],
  ['patch', '/api/admin/v1/users/{id}'],
  ['put', '/api/admin/v1/users/{id}/password'],
  ['patch', '/api/admin/v1/users/{id}/role'],
  ['patch', '/api/admin/v1/users/{id}/status'],
  ['delete', '/api/admin/v1/users/{id}'],
  // SMS 基础设施 T3(评审稿 §3.2 ⑦):管理员清除绑定手机号(幂等;解除绑定唯一路径)。
  ['delete', '/api/admin/v1/users/{id}/phone'],
  // 微信小程序登录 T3(wechat 评审稿 §3.2 ⑨):管理员清除绑定微信 openid(幂等;镜像清号)。
  ['delete', '/api/admin/v1/users/{id}/wechat'],
  ['get', '/api/admin/v1/organizations'],
  ['get', '/api/admin/v1/organizations/tree'],
  // F1/A3(admin-api-fe-integration-roadmap.md §4 A3)。
  ['get', '/api/admin/v1/organizations/options'],
  ['get', '/api/admin/v1/organizations/tree-options'],
  ['post', '/api/admin/v1/organizations'],
  ['get', '/api/admin/v1/organizations/{id}'],
  ['patch', '/api/admin/v1/organizations/{id}'],
  ['patch', '/api/admin/v1/organizations/{id}/status'],
  // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §8.3/§11 PR1):reparent 重挂父级。
  ['post', '/api/admin/v1/organizations/{id}/move'],
  ['delete', '/api/admin/v1/organizations/{id}'],
  ['get', '/api/admin/v1/members'],
  // F1/A1(admin-api-fe-integration-roadmap.md §4 A1)。
  ['get', '/api/admin/v1/members/options'],
  ['post', '/api/admin/v1/members'],
  ['get', '/api/admin/v1/members/{id}'],
  ['patch', '/api/admin/v1/members/{id}'],
  ['patch', '/api/admin/v1/members/{id}/status'],
  ['delete', '/api/admin/v1/members/{id}'],
  // 队员账号闭环 v1(MVP,2026-07-07):开号(手机验证码登录,不设密码),320→321。
  ['post', '/api/admin/v1/members/{id}/account'],
  // 队员账号闭环 v2(2026-07-07;冻结评审稿 docs/archive/reviews/member-account-loop-v2-review.md):
  // 绑定既有悬空账号 / 解绑(只断链)/ 退号重开 / 队员面启停账号,+4 路由,321→325。
  ['post', '/api/admin/v1/members/{id}/account/bind'],
  ['post', '/api/admin/v1/members/{id}/account/unbind'],
  ['post', '/api/admin/v1/members/{id}/account/reopen'],
  ['patch', '/api/admin/v1/members/{id}/account/status'],
  // 参与域生命周期收口⑤(v0.40.0):一键离队,+1 路由,328→329。
  ['post', '/api/admin/v1/members/{id}/offboard'],
  // 队员账号闭环 v2 批量开号(2026-07-07):+1 路由,325→326。
  ['post', '/api/admin/v1/members/accounts/bulk-grant'],
  ['get', '/api/admin/v1/members/{memberId}/department'],
  ['put', '/api/admin/v1/members/{memberId}/department'],
  ['delete', '/api/admin/v1/members/{memberId}/department'],
  // 终态 scoped-authz PR2(2026-07-01;冻结稿 §7.1):组织归属 memberships 4 端点(旧 3 department 路由保留)。
  ['get', '/api/admin/v1/members/{memberId}/memberships'],
  ['post', '/api/admin/v1/members/{memberId}/memberships'],
  ['patch', '/api/admin/v1/members/{memberId}/memberships/{id}'],
  ['delete', '/api/admin/v1/members/{memberId}/memberships/{id}'],
  ['get', '/api/admin/v1/members/{memberId}/profile'],
  ['post', '/api/admin/v1/members/{memberId}/profile'],
  ['patch', '/api/admin/v1/members/{memberId}/profile'],
  ['get', '/api/admin/v1/members/{memberId}/emergency-contacts'],
  ['post', '/api/admin/v1/members/{memberId}/emergency-contacts'],
  ['patch', '/api/admin/v1/members/{memberId}/emergency-contacts/{id}'],
  ['delete', '/api/admin/v1/members/{memberId}/emergency-contacts/{id}'],
  ['get', '/api/admin/v1/members/{memberId}/certificates'],
  ['post', '/api/admin/v1/members/{memberId}/certificates'],
  ['get', '/api/admin/v1/members/{memberId}/certificates/qualification-flag'],
  ['get', '/api/admin/v1/members/{memberId}/certificates/{id}'],
  ['patch', '/api/admin/v1/members/{memberId}/certificates/{id}'],
  ['delete', '/api/admin/v1/members/{memberId}/certificates/{id}'],
  ['patch', '/api/admin/v1/members/{memberId}/certificates/{id}/verify'],
  ['patch', '/api/admin/v1/members/{memberId}/certificates/{id}/reject'],

  // 保险模块 T2(2026-06-13;insurance-module-review.md §3.2 端点 5-14):队统一保单 CRUD +
  // 覆盖名单管理(单加/一键加幂等/移除)+ admin 查队员自购保险(read.other,镜像 certificates
  // N:1 子资源数组无分页)。判权全部 service 层 rbac.can(team-insurance-policy 6 码 +
  // member-insurance.read.other),biz-admin 全绑(T1 seed)。
  ['get', '/api/admin/v1/team-insurance-policies'],
  ['post', '/api/admin/v1/team-insurance-policies'],
  ['get', '/api/admin/v1/team-insurance-policies/{id}'],
  ['patch', '/api/admin/v1/team-insurance-policies/{id}'],
  ['delete', '/api/admin/v1/team-insurance-policies/{id}'],
  ['get', '/api/admin/v1/team-insurance-policies/{id}/members'],
  ['post', '/api/admin/v1/team-insurance-policies/{id}/members'],
  ['post', '/api/admin/v1/team-insurance-policies/{id}/members/add-all-active'],
  ['delete', '/api/admin/v1/team-insurance-policies/{id}/members/{memberId}'],
  ['get', '/api/admin/v1/members/{memberId}/insurances'],
  ['get', '/api/admin/v1/activities'],
  // F1/A6(admin-api-fe-integration-roadmap.md §4 A6)。
  ['get', '/api/admin/v1/activities/options'],
  ['post', '/api/admin/v1/activities'],
  ['get', '/api/admin/v1/activities/{id}'],
  ['patch', '/api/admin/v1/activities/{id}'],
  ['delete', '/api/admin/v1/activities/{id}'],
  ['patch', '/api/admin/v1/activities/{id}/publish'],
  ['patch', '/api/admin/v1/activities/{id}/cancel'],
  ['post', '/api/admin/v1/activities/{id}/complete'],
  ['post', '/api/admin/v1/activities/{activityId}/registrations'],
  ['get', '/api/admin/v1/activities/{activityId}/registrations'],
  ['get', '/api/admin/v1/activities/{activityId}/registrations/export'],
  ['patch', '/api/admin/v1/activities/{activityId}/registrations/{id}/approve'],
  ['patch', '/api/admin/v1/activities/{activityId}/registrations/{id}/reject'],
  ['patch', '/api/admin/v1/activities/{activityId}/registrations/{id}/cancel'],
  ['post', '/api/admin/v1/activities/{activityId}/registrations/{id}/reopen'],
  ['post', '/api/admin/v1/activities/{activityId}/attendance-sheets'],
  ['get', '/api/admin/v1/activities/{activityId}/attendance-sheets'],
  ['get', '/api/admin/v1/attendance-sheets/{id}/review-detail'],
  ['get', '/api/admin/v1/attendance-sheets/{id}'],
  ['patch', '/api/admin/v1/attendance-sheets/{id}'],
  ['delete', '/api/admin/v1/attendance-sheets/{id}'],
  ['patch', '/api/admin/v1/attendance-sheets/{id}/approve'],
  ['patch', '/api/admin/v1/attendance-sheets/{id}/reject'],
  ['patch', '/api/admin/v1/attendance-sheets/{id}/final-approve'],
  ['patch', '/api/admin/v1/attendance-sheets/{id}/final-reject'],
  // 队员/审批跨轴只读查询(2026-06-23;前端任务驱动后台 · GAP-001 Tier2 / GAP-002 Tier3):
  //   5 个 admin 只读端点,224→229(仅新增;复用 read 码零新码 / 零 schema 列 / 零 migration)。
  //   Tier2 跨活动横扫(审批工作台):registrations + attendance-sheets(根 @Get 加在既有
  //   AttendanceSheetsResourceController);Tier3 队员 360:members/:memberId/{registrations,
  //   attendance-records,contribution-summary}(贡献值实时算复用 team-join 封顶核,生涯累计 1.5/北京日)。
  ['get', '/api/admin/v1/registrations'],
  ['get', '/api/admin/v1/attendance-sheets'],
  ['get', '/api/admin/v1/members/{memberId}/registrations'],
  ['get', '/api/admin/v1/members/{memberId}/attendance-records'],
  ['get', '/api/admin/v1/members/{memberId}/contribution-summary'],
  ['post', '/api/admin/v1/attachments'],
  ['get', '/api/admin/v1/attachments'],
  ['post', '/api/admin/v1/attachments/upload-url'],
  ['post', '/api/admin/v1/attachments/confirm-upload'],
  ['get', '/api/admin/v1/attachments/by-owner'],
  ['get', '/api/admin/v1/attachments/{id}'],
  ['patch', '/api/admin/v1/attachments/{id}'],
  ['delete', '/api/admin/v1/attachments/{id}'],
  // 招新一期(招新前段)T3(2026-06-18;冻结评审稿 recruitment-phase1-review.md §3.2):
  //   recruitment 10 路由,186→196。open/v1 公开报名 surface **首用**(api-surface-policy §0
  //   「预留→首用」解锁;第 5 canonical 前缀,见文件尾 CANONICAL_PREFIXES);admin/v1 轮次×4 + 报名×4。
  ['post', '/api/open/v1/recruitment/applications'],
  // 招新实名环节 OCR 改造(2026-06-22;冻结评审稿 recruitment-realname-ocr-review.md §3.2 端点 4b):
  //   +1 公开识别端点(扫证件 OCR 回填供申请人确认;无状态);仅新增。
  ['post', '/api/open/v1/recruitment/applications/recognize'],
  ['post', '/api/open/v1/recruitment/applications/query'],
  // 招新四期 S4a(H5 + 手机身份链;2026-06-24;冻结评审稿 recruitment-phase4-loop-optimization-review.md §3):
  //   +5 公开端点(身份链发码/验码 2 + 手机查询②/自助换微信/自助换手机 3);均 open/v1 仅新增,235→240。
  ['post', '/api/open/v1/recruitment/identity/send-code'],
  ['post', '/api/open/v1/recruitment/identity/verify-code'],
  ['post', '/api/open/v1/recruitment/applications/query-by-phone'],
  // 招新可用性收口 F6(2026-07-11;评审稿 §3 R4):自助撤销(公开双通道;0 新码)。
  ['post', '/api/open/v1/recruitment/applications/withdraw'],
  ['post', '/api/open/v1/recruitment/applications/rebind-wechat'],
  ['post', '/api/open/v1/recruitment/applications/rebind-phone'],
  ['post', '/api/admin/v1/recruitment/cycles'],
  ['get', '/api/admin/v1/recruitment/cycles'],
  ['get', '/api/admin/v1/recruitment/cycles/{id}'],
  ['patch', '/api/admin/v1/recruitment/cycles/{id}'],
  ['get', '/api/admin/v1/recruitment/applications'],
  ['get', '/api/admin/v1/recruitment/applications/{id}'],
  // 招新可用性收口 F2(2026-07-11;评审稿 recruitment-usability-closeout-review.md §3 R1):admin 改报名资料。
  ['patch', '/api/admin/v1/recruitment/applications/{id}'],
  ['get', '/api/admin/v1/recruitment/applications/{id}/id-card-image-url'],
  ['post', '/api/admin/v1/recruitment/applications/{id}/resolve'],
  // 招新可用性收口 F3(2026-07-11;评审稿 §3 R3):单人手动建档(批量 skip 项收尾通道)。
  ['post', '/api/admin/v1/recruitment/applications/{id}/promote-single'],
  // 招新二期(招新后段)T2(2026-06-19;冻结评审稿 recruitment-phase2-review.md §3.2):
  //   admin 标门槛 + 综合评定 + 公示名单,196→199(均 admin/v1,仅新增)。
  ['patch', '/api/admin/v1/recruitment/applications/{id}/thresholds'],
  ['post', '/api/admin/v1/recruitment/applications/{id}/evaluate'],
  ['get', '/api/admin/v1/recruitment/cycles/{id}/publicity-list'],
  // 招新二期 T3:一键发号(建 User+Member),199→200。
  ['post', '/api/admin/v1/recruitment/cycles/{id}/promote'],
  // 招新闭环优化 S2(2026-06-24;冻结评审稿 recruitment-phase4-loop-optimization-review.md §7):
  //   招新工作台聚合只读 stats(五组;纯读零 schema;复用 read.record 零新 RBAC 码;答 GAP-003)。
  ['get', '/api/admin/v1/recruitment/cycles/{id}/stats'],
  // 招新闭环优化 S6(2026-06-24;冻结评审稿 recruitment-phase4-loop-optimization-review.md §8):
  //   批量操作 3 端点(纯加端点,零 schema / 零新 RBAC 码)——批量标门槛(复用单行 markThreshold)/
  //   批量导出 CSV(脱敏复用 S3 toAdminDto)/ 一键发号前预检(复用 decidePromotionIssuance,预检=实发)。
  //   批量通知不做(挂 §9 / GAP-005,随 S7)。
  ['post', '/api/admin/v1/recruitment/applications/batch-mark-threshold'],
  ['post', '/api/admin/v1/recruitment/applications/export'],
  ['get', '/api/admin/v1/recruitment/cycles/{id}/promote-precheck'],
  // 招新三期(入队:志愿者→队员)T2(2026-06-19;冻结评审稿 recruitment-phase3-review.md §3.2):
  //   team-join admin 面 8 端点(入队轮 CRUD 4 + 报名 list/detail/标 gate/综合评估 4),200→208(均 admin/v1,仅新增)。
  //   app 自助面(T3)/ 一键入队(T4)后续追加。
  ['post', '/api/admin/v1/team-join/cycles'],
  ['get', '/api/admin/v1/team-join/cycles'],
  ['get', '/api/admin/v1/team-join/cycles/{id}'],
  ['patch', '/api/admin/v1/team-join/cycles/{id}'],
  ['get', '/api/admin/v1/team-join/applications'],
  ['get', '/api/admin/v1/team-join/applications/{id}'],
  ['patch', '/api/admin/v1/team-join/applications/{id}/gates'],
  ['post', '/api/admin/v1/team-join/applications/{id}/evaluate'],
  // 招新三期 T4(2026-06-19;评审稿 §4.5):一键入队(设部门 + 级别 level-1),211→212。
  ['post', '/api/admin/v1/team-join/applications/{id}/join'],
  // 招新三期 T3(2026-06-19;评审稿 §3.2):app/v1/me 自助面 3 端点(发起/查进度/改候选),208→211。
  ['post', '/api/app/v1/me/team-join/applications'],
  ['get', '/api/app/v1/me/team-join/applications/current'],
  ['patch', '/api/app/v1/me/team-join/applications/{id}/targets'],
  // CMS 内容发布模块(第 28 模块)T2(2026-06-21;冻结评审稿 content-module-review.md §8 端点 1-12):
  //   admin/v1/contents 12 端点,212→224(仅 admin 面;app/open 面 T3/T4 后续追加)。
  //   判权 R 模式 content.* 5 码;附件端点(upload-url/confirm/删)经 AttachmentsService 写路径 RBAC;封面 set/clear。
  ['post', '/api/admin/v1/contents'],
  ['get', '/api/admin/v1/contents'],
  ['get', '/api/admin/v1/contents/{id}'],
  ['patch', '/api/admin/v1/contents/{id}'],
  ['delete', '/api/admin/v1/contents/{id}'],
  ['post', '/api/admin/v1/contents/{id}/publish'],
  ['post', '/api/admin/v1/contents/{id}/unpublish'],
  ['post', '/api/admin/v1/contents/{id}/archive'],
  ['post', '/api/admin/v1/contents/{id}/attachments/upload-url'],
  ['post', '/api/admin/v1/contents/{id}/attachments/confirm'],
  ['delete', '/api/admin/v1/contents/{id}/attachments/{attachmentId}'],
  ['put', '/api/admin/v1/contents/{id}/cover'],
  // CMS 内容发布模块(第 28 模块)T3/T4(2026-06-21;冻结评审稿 content-module-review.md §8 open/app):
  //   open/v1/contents 2 端点(@Public + content-public throttle〔第 10〕;仅 published+public,无码 `[public]`)
  //   + app/v1/contents 2 端点(canUseApp 准入 + 5 档可见性;无码 `[auth]`),224→228。
  //   读者出参零敏感(无 authorUserId / visibleOrganizationIds);签名 URL 为范围例外 a(§5.7)仅过可见级后返。
  ['get', '/api/open/v1/contents'],
  ['get', '/api/open/v1/contents/{id}'],
  ['get', '/api/app/v1/contents'],
  ['get', '/api/app/v1/contents/{id}'],
  // 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller;2026-06-25;冻结评审稿
  //   unified-notification-dispatcher-review.md §5 / member-notification-review.md §6/§7),+12 → 255。
  //   admin/v1/notifications 8(CRUD + 状态机 publish/unpublish/archive;R 模式 notification.* 5 码,无 @RequirePermissions)
  //   + app/v1/notifications 4(list/unread-count/detail/mark-read;canUseApp 准入 + 4 档可见性〔复用 content.visibility 去 public〕,无码 [auth])。
  //   读者出参零敏感(无 authorUserId / visibleOrganizationIds / statusCode / readCount);unread-count 字面段声明于 :id 之前。
  ['post', '/api/admin/v1/notifications'],
  ['get', '/api/admin/v1/notifications'],
  ['get', '/api/admin/v1/notifications/{id}'],
  ['patch', '/api/admin/v1/notifications/{id}'],
  ['delete', '/api/admin/v1/notifications/{id}'],
  ['post', '/api/admin/v1/notifications/{id}/publish'],
  ['post', '/api/admin/v1/notifications/{id}/unpublish'],
  ['post', '/api/admin/v1/notifications/{id}/archive'],
  // 统一通知模块 S5 短信兜底渠道(2026-06-27;冻结评审稿 unified-notification-dispatcher-review.md §4),+1 → 260。
  //   admin/v1/notifications/:id/send-sms(显式发起短信兜底紧急召集;计费确认必需 confirmed=true 才真发,
  //   false 仅预览受众计数;R 模式 notification.send.sms 无 @RequirePermissions;短信永不随 publish 自动发)。
  ['post', '/api/admin/v1/notifications/{id}/send-sms'],
  ['get', '/api/app/v1/notifications'],
  ['get', '/api/app/v1/notifications/unread-count'],
  ['get', '/api/app/v1/notifications/{id}'],
  ['post', '/api/app/v1/notifications/{id}/read'],
  // 统一通知模块 S2 微信订阅 quota 渠道(2026-06-25;冻结评审稿
  //   unified-notification-dispatcher-review.md §3/§7),+4 → 259。
  //   app/v1/notifications/subscriptions 2(ack 上报授权 quota +1 封顶 / status 查剩余配额;canUseApp 准入,无码 [auth];
  //   字面段 subscriptions/* 声明于 :id 之前)+ admin/v1/notification-wechat-templates 2(list / upsert 模板配置;
  //   R 模式 read.record / update.template,无 @RequirePermissions;独立 base path 避与 notifications/:id 冲突)。
  //   微信派发 = publish 事务外同步分支(NotificationDelivery 记账,零新端点);token/openid 零出参(L3)。
  ['post', '/api/app/v1/notifications/subscriptions/ack'],
  ['get', '/api/app/v1/notifications/subscriptions/status'],
  ['get', '/api/admin/v1/notification-wechat-templates'],
  ['put', '/api/admin/v1/notification-wechat-templates/{typeCode}'],
  // 终态 scoped-authz PR3「职务定义」(2026-07-01;冻结稿 §7.2),+9 → 274。
  //   positions 5(GET 列 / POST 建 / GET :id / PATCH :id / DELETE :id)+ position-rules 4
  //   (GET 列〔按 nodeTypeCode 过滤〕/ POST 建 / PATCH :id / DELETE :id;GET :id §7.2 未列不实装)。
  //   R 模式 position.*.definition 4 + position-rule.*.record 4,无 @Roles。
  ['get', '/api/admin/v1/positions'],
  // F1/A5(admin-api-fe-integration-roadmap.md §4 A5)。
  ['get', '/api/admin/v1/positions/options'],
  ['post', '/api/admin/v1/positions'],
  ['get', '/api/admin/v1/positions/{id}'],
  ['patch', '/api/admin/v1/positions/{id}'],
  ['delete', '/api/admin/v1/positions/{id}'],
  ['get', '/api/admin/v1/position-rules'],
  ['post', '/api/admin/v1/position-rules'],
  ['patch', '/api/admin/v1/position-rules/{id}'],
  ['delete', '/api/admin/v1/position-rules/{id}'],
  // 终态 scoped-authz PR4「任职」(2026-07-01;冻结稿 §7.3),+5 → 279。
  //   双轴:组织轴 GET 在任列表 / POST 任命 + 队员轴 GET 任职(含历史) + 扁平 POST 撤销 / GET 历史链。
  //   单 PositionAssignmentsController(@Controller('admin/v1') 共同前缀 + 完整子路径);
  //   R 模式 position-assignment.{read,create,revoke}.record + .read.history 4 码,无 @Roles。
  ['get', '/api/admin/v1/organizations/{orgId}/position-assignments'],
  ['post', '/api/admin/v1/organizations/{orgId}/position-assignments'],
  ['get', '/api/admin/v1/members/{memberId}/position-assignments'],
  ['post', '/api/admin/v1/position-assignments/{id}/revoke'],
  ['get', '/api/admin/v1/position-assignments/{id}/history'],
  // 终态 scoped-authz PR5「分管」(2026-07-01;冻结稿 §7.4),+6 → 285。
  //   扁平 GET 在任列表 / POST 建 / PATCH 改 / POST 撤销 + 队员轴 GET 分管范围 + 组织轴 GET 被谁分管。
  //   单 SupervisionAssignmentsController(@Controller('admin/v1') 共同前缀 + 完整子路径);
  //   R 模式 supervision-assignment.{read,create,update,revoke}.record 4 码,无 @Roles(分管绝不进判权路径)。
  ['get', '/api/admin/v1/supervision-assignments'],
  ['post', '/api/admin/v1/supervision-assignments'],
  ['get', '/api/admin/v1/members/{memberId}/supervision-scope'],
  ['get', '/api/admin/v1/organizations/{orgId}/supervisors'],
  ['patch', '/api/admin/v1/supervision-assignments/{id}'],
  ['post', '/api/admin/v1/supervision-assignments/{id}/revoke'],
  // 终态 scoped-authz PR6「RoleBinding」(2026-07-01;冻结稿 §7.5),+4 → 289。
  //   带 scope 的角色绑定管理面:GET 列 / POST 建 / PATCH 改 / DELETE 软删。
  //   单 RoleBindingsController(@Controller('admin/v1') 共同前缀 + 完整子路径 role-bindings[/:id]);
  //   R 模式 role-binding.{read,create,update,delete}.record 4 码,无 @Roles。
  //   UserRole→global RoleBinding 无损升级 = 判权唯一读源(RbacService 只读 GLOBAL);scoped 入库即止(判权是 PR8)。
  ['get', '/api/admin/v1/role-bindings'],
  ['post', '/api/admin/v1/role-bindings'],
  ['patch', '/api/admin/v1/role-bindings/{id}'],
  ['delete', '/api/admin/v1/role-bindings/{id}'],
  // 终态 scoped-authz PR10「authz/explain」(2026-07-02;冻结稿 §7.6 + §9 行 20),+1 → 290。
  //   权限解释可解释性出口(诊断读):POST 入 { userId, action, resourceRef? },出
  //   { targetUser, decision: AuthzDecision };deny 是 200 数据不是错误(resource_not_found 亦然),
  //   reason 稳定枚举(2 allow + 9 deny)入 OpenAPI 契约锁。
  //   AuthzController(authz 模块第一个 controller;@Controller('admin/v1') + 完整子路径 authz/explain);
  //   R 模式 authz.explain.decision 1 码,无 @Roles,无 audit(goal 决断④)。
  ['post', '/api/admin/v1/authz/explain'],
  // 终态 scoped-authz PR11「公告导入」(2026-07-02;冻结稿 §8.4 + §11 PR11),+2 → 292。
  //   两段式:POST preview(零写入诊断,逐行回显 ok/blocked/already-exists/needs-manual)+
  //   POST execute(幂等落库,单行失败不影响其它行)。AnnouncementImportController
  //   (@Controller('admin/v1') + 完整子路径 announcement-import/{preview,execute});
  //   R 模式 announcement-import.{preview,execute}.record 2 码,无 @Roles。
  ['post', '/api/admin/v1/announcement-import/preview'],
  ['post', '/api/admin/v1/announcement-import/execute'],
  // F1「A 组:搜索 & 选择器 + resolve-labels」(2026-07-04;冻结路线图
  //   admin-api-fe-integration-roadmap.md §4 A7;net-new meta 模块),+1 → 300(连同上方
  //   6 处 /options·/tree-options 插入共 +8,292→300)。跨资源批量 id→label 解析:POST 入
  //   { refs: [{type,id}] }(refs≤200),出 {[type]:{[id]:{label,...}}};per-type 读权限
  //   过滤 + 无权/不存在静默省略(D5)。R 模式 meta.resolve.label 1 码,无 @Roles,无 audit。
  ['post', '/api/admin/v1/meta/resolve-labels'],
  // F3「C 组:授权诊断 & role-bindings」(2026-07-04;冻结路线图
  //   admin-api-fe-integration-roadmap.md §4 C1/C2/C3 + D8/D9),+6 → 306。
  //   C1(D9):role-bindings /page 分页兄弟路由(旧 bare 数组端点逐字不动)+ GET :id detail +
  //   GET preview(dry-run 与 create 同参同校验,零写入)+ POST batch(≤200 逐条
  //   ok/blocked/already-exists,幂等,镜像 announcement-import);读三路复用 role-binding.read.record,
  //   batch 复用 role-binding.create.record(goal 拍板:preview 不设新码)。
  //   静态段(page/preview)在 controller 内先于 GET :id 声明(Nest 按声明序注册)。
  ['get', '/api/admin/v1/role-bindings/page'],
  ['get', '/api/admin/v1/role-bindings/preview'],
  ['get', '/api/admin/v1/role-bindings/{id}'],
  ['post', '/api/admin/v1/role-bindings/batch'],
  //   C2(D8):explain-batch = 单条 explain 的批量壳(≤200;同 11 值 reason 枚举,deny 是 200 数据;
  //   任一 userId 不存在 → 整请求 10001);扩 AuthzController;+1 码 authz.explain-batch.decision。
  ['post', '/api/admin/v1/authz/explain-batch'],
  //   C3(D8):action-state/batch = 批量业务态闸(调用者本人;allowed = authz 判权 ∧ 已注册 action 的
  //   状态机只读校验;reason ∈ 11 值 ∪ state_forbidden 入 OpenAPI)。第二个 controller
  //   ActionStateController(authz 模块内;三 StateMachine 以零依赖纯类入 providers,不 import 业务
  //   module 不成环);+1 码 authz.action-state.decision。
  ['post', '/api/admin/v1/authz/action-state/batch'],
  // F4「D 组:memberships 扁平/组织轴增强 + transfer」(2026-07-04;冻结路线图
  //   admin-api-fe-integration-roadmap.md §4 D 组),+7 → 313。
  //   扁平:分页总表(过滤 + expand=member,organization,D6)+ conflicts 只读诊断(多 ACTIVE PRIMARY /
  //   悬空队员 / 悬空组织 / 停用组织;数据体检面)+ transfer(唯一写端点:单事务 end 旧 + create 新,
  //   受既有 partial unique;+1 码 membership.transfer.record 绑 biz-admin + 1 audit event
  //   membership.transfer〔goal 显式预授权〕)+ GET :id detail(membership.read.record 预埋孤码实装,
  //   WARN 清零)。新 MembershipsAdminController(@Controller('admin/v1') 跨 memberships/organizations
  //   两根;既有队员轴 4 端点逐字不动)。静态段(conflicts/transfer)先于 GET :id 声明。
  ['get', '/api/admin/v1/memberships'],
  ['get', '/api/admin/v1/memberships/conflicts'],
  ['post', '/api/admin/v1/memberships/transfer'],
  ['get', '/api/admin/v1/memberships/{id}'],
  //   组织轴:归属分页(includeDescendants 展开)+ 队员下拉(复用 F1 members/options 同一份投影,
  //   member.read.record)+ 整树归属计数(直属/子树合计,单 groupBy 禁 N+1;org.read.node;
  //   OrganizationsController 静态段先于 :id)。
  ['get', '/api/admin/v1/organizations/{orgId}/memberships'],
  ['get', '/api/admin/v1/organizations/{orgId}/members/options'],
  ['get', '/api/admin/v1/organizations/tree-with-summary'],
  // F5「E 组:任职/分管总表 + preview」(2026-07-04;冻结路线图
  //   admin-api-fe-integration-roadmap.md §4 E1/E2),+6 → 319 = 路线图 F1–F5 全量落地终值。
  //   E1 任职:全局分页总表(organizationId+includeDescendants〔closure 直读仅列表过滤,沿本模块
  //   create() requireMembership 既有范式,非判权〕/memberId/positionId/status/q + expand=
  //   member,position,organization,D6;缺省含 REVOKED 历史,与组织轴仅 ACTIVE 刻意不同)+
  //   GET :id detail + POST preview(dry-run:任期+存在性+任命 5 校验**逐项收集** violations,
  //   零写入;goal 拍板复用 read 码不设新码;刻意不复用 create(dryRun) 沙箱——那是 first-failure
  //   + create 码 + 真实事务成本,见 service 注释)。扩既有 PositionAssignmentsController。
  ['get', '/api/admin/v1/position-assignments'],
  ['post', '/api/admin/v1/position-assignments/preview'],
  ['get', '/api/admin/v1/position-assignments/{id}'],
  //   E2 分管(D9 同型):/page 分页兄弟路由(旧 bare 数组端点〔仅 ACTIVE〕逐字不动;总表缺省含
  //   REVOKED 历史 + expand=supervisor,organization)+ GET :id detail + POST coverage-preview
  //   (dry-run 覆盖预演:EXACT=[该节点] / TREE=closure 展开含后代;展示读非判权,零写入;复用 read 码)。
  //   扩既有 SupervisionAssignmentsController;静态段(page/coverage-preview)先于 GET :id 声明。
  ['get', '/api/admin/v1/supervision-assignments/page'],
  ['post', '/api/admin/v1/supervision-assignments/coverage-preview'],
  ['get', '/api/admin/v1/supervision-assignments/{id}'],
  // GAP-003(handoff/admin-web.md §4;goal「GAP-003 收口」),+1 → 320。工作台/首页待办
  //   汇总:三个可省略块(registrations.pending / attendanceSheets.{pending,
  //   pendingFinalReview} / activities.published),零 query 参数。registrations/
  //   attendanceSheets 各凭对应既有读码(GLOBAL 口径,与 admin/v1/registrations ·
  //   admin/v1/attendance-sheets 两个扁平列表一致);activities 无码(沿 list 现状)。
  //   无对应块权限时静默省略(镜像 resolve-labels),响应恒 200。扩既有 MetaController。
  ['get', '/api/admin/v1/meta/dashboard-summary'],
];

// 至少必须出现的 schema(DTO)清单。新增重要 DTO 时按需扩充。
const EXPECTED_SCHEMAS: readonly string[] = [
  'LoginDto',
  'CreateUserDto',
  'UpdateUserDto',
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

  // 终态 scoped-authz PR2(2026-07-01;冻结稿 §3.1/§7.1)memberships 组织归属
  'MembershipResponseDto',
  'CreateMembershipDto',
  'UpdateMembershipDto',

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

  // 队员/审批跨轴只读查询(2026-06-23;GAP-001 Tier2 / GAP-002 Tier3):4 个 admin 出参 DTO,
  // 独立 admin-surface class(**不** extends / Pick / Omit 既有 list-item;沿 §2.1 / §0)。
  //   AdminRegistrationListItemDto(activity-registrations 模块)= 既有列表项 + activityTitle;
  //   AdminAttendanceSheetListItemDto / AdminMemberAttendanceRecordDto = 既有 + activity 上下文;
  //   MemberContributionSummaryDto = { memberId, contributionPoints }(生涯累计 capped 总分)。
  // 注:ListRegistrationsQueryDto / ListAttendanceSheetsQueryDto / PaginationQueryDto 复用既有
  //   @Query DTO,被内联为 parameters,不进 components.schemas;:memberId 为 raw @Param 同理。
  'AdminRegistrationListItemDto',
  'AdminAttendanceSheetListItemDto',
  'AdminMemberAttendanceRecordDto',
  'MemberContributionSummaryDto',

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

  // Phase 2 P2-4b(2026-05-20):App /api/app/v1/activities/{id} 详情 DTO
  // AppActivityDetailDto:详情出参,字段恰好 13(沿 §5.1 v0.1 锁定);在 list 11 项
  // 基础上追加 description + registrationNotes;独立 class,**禁止**继承 / Pick / Omit
  // Admin DTO(沿 §5.4 + Phase 0.7 §2.2)。@ApiWrappedOkResponse 自动注册到 schemas。
  'AppActivityDetailDto',

  // Phase 2 P2-5a(2026-05-20):App /my/* registrations DTO(3 核心出参)
  // 字段集严格沿 docs/app-api-p2-5-registrations-review.md §8.2.1 (11 项) / §8.2.2
  // (12 项 - §16.B.2 不返 memberId = 11 项) / §8.2.3 (11 项)。
  // **禁止**继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types
  // admin DTO(沿 D-P2-5-6 + §8.1 + 风险 14.1)。
  // 注:ListAppMyRegistrationsQueryDto / ListAppMyActivitiesQueryDto 是 @Query() DTO
  // 继承 PaginationQueryDto,被 NestJS Swagger 内联为 parameters,**不**注册到
  // components.schemas(沿 batch 3 / P2-4 query DTO 同范式)。
  'AppMyRegistrationListItemDto',
  'AppMyRegistrationDto',
  'AppMyActivityListItemDto',

  // Phase 2 P2-5b(2026-05-20):App /my/registrations 2 入参 DTO
  // 字段集严格沿 §8.2.4:CreateAppMyRegistrationDto 严格 2 字段(activityId + 可选 extras);
  // CancelAppMyRegistrationDto 严格 1 字段(可选 cancelReason;沿 D-P2-5-9 不必填)。
  // **禁止**继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types
  // admin CreateRegistrationDto / CreateMyRegistrationDto / CancelRegistrationDto
  // (沿 D-P2-5-6 + §8.1 + 风险 14.1)。
  'CreateAppMyRegistrationDto',
  'CancelAppMyRegistrationDto',

  // Phase 2 P2-6(2026-05-20):App /my/attendance-records 出参 DTO
  // 字段集严格沿 §5.1 v0.1 锁定 14 项;独立 class,**禁止**继承 / Pick / Omit / Mapped Types
  // admin AttendanceRecordResponseDto(沿 D-P2-6-4 + Phase 0.7 §2.2)。
  // 注:ListAppMyAttendanceRecordsQueryDto 是 @Query() DTO,被 NestJS Swagger 内联为
  // parameters,**不**注册到 components.schemas(沿 P2-5a query DTO 同范式)。
  'AppMyAttendanceRecordDto',

  // Phase 2 P2-7(2026-05-20):App /my/certificates 出参 DTO
  // 字段集严格沿 docs/app-api-p2-7-my-certificates-review.md §5.1 v0.1 锁定 12 项;
  // 独立 class,**禁止**继承 / Pick / Omit / IntersectionType / PartialType / OmitType /
  // Mapped Types admin CertificateResponseDto / CertificateListItemDto
  // (沿 D-P2-7-3 + Phase 0.6 §1.3 + Phase 0.7 §2.2)。
  // 注:ListAppMyCertificatesQueryDto 是 @Query() DTO,被 NestJS Swagger 内联为
  // parameters,**不**注册到 components.schemas(沿 P2-5a / P2-6 query DTO 同范式)。
  'AppMyCertificateDto',

  // Admin surface 本人身份 bootstrap(2026-06-14):GET /api/admin/v1/me 出参。
  // AdminMeResponseDto 独立注册为 named schema,字段集恰好 9(User 本体身份);
  // **禁止**继承 / Pick / Omit / Mapped Types 任何既有 DTO(含 AppMeResponseDto /
  // UserResponseDto;沿 api-surface-policy §2.1 四 surface DTO 物理隔离)。
  'AdminMeResponseDto',

  // 招新一期(招新前段)T3(2026-06-18;冻结评审稿 recruitment-phase1-review.md §3.2):
  //   recruitment DTO 物理隔离(独立 class,禁止继承 / Pick / Omit / Mapped Types)。
  //   admin 出参 RecruitmentApplicationAdminDto = 含 PII(列表掩码 / 详情全显由 service 控)。
  //   注:RecruitmentSubmitPayloadDto 走 multipart 内嵌 JSON 串(@Body('payload') string),
  //   **不**作为 @Body() 类型 → NestJS Swagger 不注册为 component schema(沿 query DTO 内联范式)。
  // 招新闭环优化 S4b(2026-06-24;评审稿 §2.1):submit 出参由 RecruitmentApplicationPublicDto 升级为
  //   RecruitmentSubmitResultDto(OCR 六分流:outcome 区分落记录 submitted 与不落记录的中性延迟引导
  //   retake/confirm/retry;**不暴露 riskLevel/forgery 分级**)。独立 class 物理隔离。
  'RecruitmentSubmitResultDto',
  // 招新闭环优化 S1(2026-06-24;评审稿 §4/§6):公开本人查询出参 enrich 为进度模型
  //   RecruitmentApplicationProgressDto(业务态 stage + 字典文案 + 门槛 todoList 真投影 +
  //   嵌套 RecruitmentTodoItemDto);独立 class 物理隔离。
  'RecruitmentApplicationProgressDto',
  'RecruitmentTodoItemDto',
  'RecruitmentQueryDto',
  // 招新四期 S4a(H5 + 手机身份链;2026-06-24):身份链发码/验码/手机查询②/换绑 DTO(注册为 named schema)
  'RecruitmentSendCodeDto',
  'RecruitmentSendCodeResponseDto',
  'RecruitmentVerifyCodeDto',
  'RecruitmentVerifyCodeResponseDto',
  'RecruitmentQueryByPhoneDto',
  'RecruitmentRebindWechatDto',
  'RecruitmentRebindPhoneDto',
  'RecruitmentCycleResponseDto',
  'CreateRecruitmentCycleDto',
  'UpdateRecruitmentCycleDto',
  'RecruitmentApplicationAdminDto',
  'ResolveRecruitmentApplicationDto',
  'IdCardImageUrlResponseDto',
  // OCR 鉴伪版充分利用(2026-06-29;评审稿 recruitment-ocr-anti-forgery-enrichment-review.md §4.2):
  //   recognize 响应嵌套 ocrDetail(字段级 + 卡片级告警 + 证件类型);3 个新 named schema。
  'RecruitmentOcrDetailDto',
  'RecruitmentOcrFieldDto',
  'RecruitmentOcrCardWarningsDto',
  // 招新闭环优化 S2(2026-06-24;评审稿 §7.1):招新工作台 stats 五组出参(独立 class 物理隔离;
  //   嵌套 today/pending/threshold(+ item)/evaluation/issuance 六个子 DTO 均注册为 named schema)。
  'RecruitmentCycleStatsDto',
  'RecruitmentStatsTodayDto',
  'RecruitmentStatsPendingDto',
  'RecruitmentStatsThresholdDto',
  'RecruitmentStatsThresholdItemDto',
  'RecruitmentStatsEvaluationDto',
  'RecruitmentStatsIssuanceDto',
  // 招新闭环优化 S6(2026-06-24;评审稿 §8):批量操作 DTO(独立 class 物理隔离)。
  //   批量标门槛入参 BatchMarkThresholdDto(+ 嵌套 match)/ 出参 BatchMarkThresholdResultDto(+ 嵌套 row);
  //   批量导出入参 ExportRecruitmentApplicationsDto(出参为 text/csv StreamableFile,无响应 schema);
  //   发号预检出参 PromotePrecheckResultDto(+ 嵌套 row)。
  'BatchMarkThresholdMatchDto',
  'BatchMarkThresholdDto',
  'BatchMarkThresholdRowResultDto',
  'BatchMarkThresholdResultDto',
  'ExportRecruitmentApplicationsDto',
  'PromotePrecheckRowDto',
  'PromotePrecheckResultDto',

  // CMS 内容发布模块(第 28 模块)T2(2026-06-21;冻结评审稿 content-module-review.md §6/§8):
  //   content admin DTO 物理隔离(独立 class,禁止继承 / Pick / Omit / Mapped Types)。
  //   入参 CreateContentDto / UpdateContentDto / ContentAttachmentUploadUrlDto /
  //   ContentAttachmentConfirmDto / SetContentCoverDto;出参 ContentAdminDetailDto /
  //   ContentAdminListItemDto + 嵌套 ContentAttachmentDto。
  //   注:ListContentAdminQueryDto 是 @Query() DTO,被 NestJS Swagger 内联为 parameters,
  //   **不**注册到 components.schemas(沿既有 query DTO 内联范式);附件端点复用
  //   UploadUrlResponseDto / AttachmentResponseDto(attachments 模块已注册)。
  'CreateContentDto',
  'UpdateContentDto',
  'ContentAttachmentUploadUrlDto',
  'ContentAttachmentConfirmDto',
  'SetContentCoverDto',
  'ContentAdminDetailDto',
  'ContentAdminListItemDto',
  'ContentAttachmentDto',

  // CMS 内容发布模块(第 28 模块)T3/T4(2026-06-21;冻结评审稿 content-module-review.md §8 open/app):
  //   open + app 读取面共用出参 ContentReadListItemDto / ContentReadDetailDto(独立 class,物理隔离;
  //   零 authorUserId / 零 visibleOrganizationIds;复用嵌套 ContentAttachmentDto)。
  //   注:ListContentReadQueryDto 是 @Query() DTO,被 NestJS Swagger 内联为 parameters,
  //   **不**注册到 components.schemas(沿既有 query DTO 内联范式)。
  'ContentReadListItemDto',
  'ContentReadDetailDto',

  // 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller;2026-06-25;冻结评审稿
  //   unified-notification-dispatcher-review.md §5 / member-notification-review.md §6/§7):
  //   notification DTO 物理隔离(独立 class,禁止继承 / Pick / Omit)。
  //   admin 入参 Create/Update;出参 NotificationAdminDetailDto / NotificationAdminListItemDto;
  //   app 读取面出参 NotificationReadListItemDto / NotificationReadDetailDto + mark-read / unread-count 出参。
  //   注:ListNotificationAdminQueryDto / ListNotificationReadQueryDto 是 @Query() DTO,被内联为 parameters,
  //   不进 components.schemas(沿既有 query DTO 内联范式)。
  'CreateNotificationDto',
  'UpdateNotificationDto',
  'NotificationAdminDetailDto',
  'NotificationAdminListItemDto',
  'NotificationReadListItemDto',
  'NotificationReadDetailDto',
  'MarkNotificationReadResponseDto',
  'NotificationUnreadCountDto',
  // 统一通知 S5 短信兜底渠道(2026-06-27;评审稿 §4):admin 显式发起短信入参 + 回执(物理隔离独立 class)。
  'SendNotificationSmsDto',
  'NotificationSmsSendResultDto',

  // 统一通知 S2 微信订阅 quota 渠道:ack/status 入参出参 + 模板配置 admin DTO(物理隔离独立 class)。
  'WechatSubscriptionAckDto',
  'WechatSubscriptionAckResponseDto',
  'WechatSubscriptionStatusResponseDto',
  'WechatQuotaItemDto',
  'UpsertWechatSubscribeTemplateDto',
  'WechatSubscribeTemplateDto',

  // 终态 scoped-authz PR3「职务定义」(2026-07-01;冻结稿 §3.2/§3.3/§7.2):
  //   positions / position-rules DTO 物理隔离(独立 class;入参 Create/Update + 出参 Response)。
  //   注:PositionQueryDto / PositionRuleQueryDto 继承 PaginationQueryDto,被 NestJS Swagger 内联为
  //   parameters,不进 components.schemas(沿既有 query DTO 内联范式)。
  'PositionResponseDto',
  'CreatePositionDto',
  'UpdatePositionDto',
  'PositionRuleResponseDto',
  'CreatePositionRuleDto',
  'UpdatePositionRuleDto',

  // 终态 scoped-authz PR4「任职」(2026-07-01;冻结稿 §3.4/§7.3):
  //   position-assignments DTO(入参 Create + 出参 Response;撤销无 body、历史/列表复用 Response)。
  'PositionAssignmentResponseDto',
  'CreatePositionAssignmentDto',

  // 终态 scoped-authz PR5「分管」(2026-07-01;冻结稿 §3.5/§7.4):
  //   supervision-assignments DTO(入参 Create/Update + 出参 Response;分管范围 ScopeEntry + 被谁分管 Supervisor〔嵌 Response〕)。
  'SupervisionAssignmentResponseDto',
  'CreateSupervisionAssignmentDto',
  'UpdateSupervisionAssignmentDto',
  'SupervisionScopeEntryDto',
  'OrganizationSupervisorDto',

  // 终态 scoped-authz PR6「RoleBinding」(2026-07-01;冻结稿 §3.6/§7.5):
  //   role-bindings DTO(入参 Create/Update + 出参 Response;scoped 各型入库不判,判权是 PR8)。
  'RoleBindingResponseDto',
  'CreateRoleBindingDto',
  'UpdateRoleBindingDto',

  // 终态 scoped-authz PR10「authz/explain」(2026-07-02;冻结稿 §7.6 + §9 行 20):
  //   权限解释 DTO(入参 userId/action/resourceRef 严格白名单 + 出参镜像 PR8 AuthzDecision;
  //   reason 11 值稳定枚举入 snapshot = 契约锁)。
  'ExplainAuthzDto',
  'ExplainResourceRefDto',
  'ExplainAuthzResponseDto',
  'ExplainTargetUserDto',
  'AuthzDecisionDto',
  'MatchedGrantDto',
  'ResolvedResourceDto',

  // 终态 scoped-authz PR11「公告导入」(2026-07-02;冻结稿 §8.4 + §11 PR11):
  //   preview/execute 共用请求/响应 DTO(三类行 + 逐行结果 + 汇总;deny/blocked 是数据不是错误)。
  'AnnouncementImportRequestDto',
  'AnnouncementImportResultDto',
  'ImportOrganizationRowDto',
  'ImportOrganizationRowResultDto',
  'ImportPositionRowDto',
  'ImportPositionRowResultDto',
  'ImportSupervisionRowDto',
  'ImportSupervisionRowResultDto',
  'ImportRowIssueDto',
  'ImportSummaryDto',

  // F3「C 组」(2026-07-04;路线图 §4 C1/C2/C3):
  //   C1 role-bindings /page(expand=role,principal)+ preview(dry-run)+ batch(逐条结果);
  //   C2 explain-batch(同 11 值 reason 枚举);C3 action-state/batch(reason ∪ state_forbidden 入 OpenAPI)。
  'RoleBindingExpandedRoleDto',
  'RoleBindingExpandedPrincipalDto',
  'RoleBindingPreviewResponseDto',
  'RoleBindingPreviewConflictDto',
  'RoleBindingResolvedScopeDto',
  'BatchCreateRoleBindingsDto',
  'BatchCreateRoleBindingsResponseDto',
  'RoleBindingBatchItemResultDto',
  'RoleBindingBatchSummaryDto',
  'ExplainAuthzBatchDto',
  'ExplainBatchItemDto',
  'ExplainAuthzBatchResponseDto',
  'ExplainBatchResultItemDto',
  'ActionStateBatchDto',
  'ActionStateItemDto',
  'ActionStateBatchResponseDto',
  'ActionStateResultItemDto',

  // F4「D 组」(2026-07-04;路线图 §4):memberships 分页总表(expand=member,organization)+
  // conflicts 只读诊断 + transfer(单事务 end+create)+ 组织树归属计数。
  'MembershipExpandedMemberDto',
  'MembershipExpandedOrganizationDto',
  'MembershipConflictItemDto',
  'MembershipConflictsResponseDto',
  'TransferMembershipDto',
  'OrganizationTreeWithSummaryNodeDto',

  // F5「E 组」(2026-07-04;路线图 §4 E1/E2):任职/分管总表 expand 子对象 + 两 preview 请求/响应。
  'PositionAssignmentExpandedMemberDto',
  'PositionAssignmentExpandedPositionDto',
  'PositionAssignmentExpandedOrganizationDto',
  'PreviewPositionAssignmentDto',
  'PositionAssignmentPreviewResponseDto',
  'PositionAssignmentViolationDto',
  'SupervisionExpandedSupervisorDto',
  'SupervisionExpandedOrganizationDto',
  'SupervisionCoveragePreviewDto',
  'SupervisionCoveragePreviewResponseDto',

  // GAP-003(2026-07-05;goal「GAP-003 收口」):工作台/首页待办汇总,三个可省略块各自
  // 物理隔离子 DTO(镜像 RecruitmentCycleStatsDto 嵌套子 DTO 的既有惯例)。
  'DashboardSummaryResponseDto',
  'DashboardRegistrationsSummaryDto',
  'DashboardAttendanceSheetsSummaryDto',
  'DashboardActivitiesSummaryDto',
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

  // Route B 终态验收基线(沿 docs/api-surface-migration-plan.md §3.4):迁移完成后,
  // OpenAPI 全部路由**只允许**落 canonical 前缀;零 v2 / 零裸 auth·health·users / 零 legacy。
  // 任何新增端点必须落 admin/v1 · app/v1 · auth/v1 · system/v1 · open/v1 之一,否则本断言失败。
  //
  // 招新一期(招新前段)T3(2026-06-18):open/v1 **首用**——api-surface-policy §0「预留→首用」
  //   解锁。open/v1 = 无账号公开报名 surface(小程序自助;@Public 跳过 JwtAuthGuard);
  //   第 5 canonical 前缀。后续公开端点(无账号)统一落 open/v1,不再裸前缀。
  const CANONICAL_PREFIXES = [
    '/api/admin/v1/',
    '/api/app/v1/',
    '/api/auth/v1/',
    '/api/system/v1/',
    '/api/open/v1/',
  ];

  it('Route B 终态:全部路由仅落 5 canonical 前缀(含 open/v1 首用;零 v2 / 零 legacy)', () => {
    const offenders = Object.keys(doc.paths).filter(
      (p) => !CANONICAL_PREFIXES.some((c) => p.startsWith(c)),
    );
    expect(offenders).toEqual([]);
  });
});
