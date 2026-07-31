// @ts-check
// Harness 3.0 · P2 执法迁移 —— eslint 执法块(唯一定义处)。
//
// 单独成文件的原因:scripts/harness-eslint.selftest.ts 要 import 这份**同一份**规则做
// 阳性对照(喂必定违规的合成片段,断言确实被抓到)。若自测另起一套配置,验的就不是
// 真正生效的规则,「全绿」将毫无意义。
//
// ⚠️ flat config 对同一 ruleId 是「后块整体覆盖前块」(不是数组合并)。因此:
//   - 每个作用域块必须**显式重列完整规则集**(用 syntax(...) 组合器),
//     窄域豁免写成 filter 减掉那一条,而不是只写要加的那条;
//   - 块的先后顺序是语义的一部分,见各块注释里的排序约束。
// 违反上述任一条会让规则**静默失效**(lint 依然绿,但没有防线)——
// scripts/harness-eslint.selftest.ts 就是为了捕捉这种失效。

// ===================== Harness 3.0 · P2 执法迁移 =====================
// 规则语义零放宽,只换执法方式。message 三段式 = 规则一句话 + AGENTS 出处 + 正确做法。
// key 即「载体 id」,供 AGENTS §1/§2 表的「载体」列引用(AL-8/AL-9 自证的落点)。
// 第 18 条的选择器单独提出来:基线块要拿**同一个字符串**去拼 `:not(...)`,
// 抄第二份就会出现「规则改了、基线块没跟上」的静默失效。
const IS_OPTIONAL_NULL_SELECTOR =
  "PropertyDefinition:has(Decorator[expression.callee.name='IsOptional']):not(:has(TSNullKeyword))";

const HARNESS_SYNTAX = {
  'no-use-guards': {
    selector: "Decorator[expression.callee.name='UseGuards']",
    message:
      'Guard 全局注册,禁在 controller/handler 上 @UseGuards。[AGENTS §1 鉴权] 正确做法:JwtAuthGuard/RolesGuard 已在 app.module.ts 以 APP_GUARD 全局注册;公开接口标 @Public(),业务判权写在 Service 内 rbac.can()。细则 docs/reference/auth-jwt-refresh.md。',
  },
  'no-roles-decorator': {
    selector: "Decorator[expression.callee.name='Roles']",
    message:
      '判权单轨:全仓活跃 @Roles = 0,禁给任何端点重新挂 @Roles 入口判权。[AGENTS §1 鉴权 + §2 判权单轨] 正确做法:入口仅全局 JwtAuthGuard,判权写在 Service 内 rbac.can(权限码) 并抛 RBAC_FORBIDDEN(30100)。RolesGuard 保留为防御性兜底,不删也不用。',
  },
  'no-bare-api-ok-response': {
    selector: "Decorator[expression.callee.name='ApiOkResponse']",
    message:
      '禁裸 @ApiOkResponse:响应被全局 ResponseInterceptor 包成 {code,message,data},裸装饰器会让 OpenAPI 契约与实际响应不符。[AGENTS §1 Swagger] 正确做法:用 @ApiWrappedOkResponse / @ApiWrappedPageResponse(src/common/decorators/api-response.decorator.ts)。细则 docs/reference/swagger.md。',
  },
  'no-local-validation-pipe': {
    selector: "NewExpression[callee.name='ValidationPipe']",
    message:
      '禁局部 new ValidationPipe:全局 ValidationPipe(whitelist + forbidNonWhitelisted + transform)已在 src/bootstrap/apply-global-setup.ts 注册,局部重复=两套白名单语义。[AGENTS §1 校验] 正确做法:改 DTO,不改管道。',
  },
  'no-prisma-middleware': {
    selector: "CallExpression[callee.property.name='$use']",
    message:
      '禁 Prisma 中间件 $use:全局软删中间件是永久禁止项(会让 findUnique 唯一性预检查失效)。[AGENTS §1 软删除 + §2 永久铁律] 正确做法:每处查询显式带 notDeletedWhere。细则 docs/reference/soft-delete-transactions.md。',
  },
  'no-prisma-client-extension': {
    selector: "CallExpression[callee.property.name='$extends']",
    message:
      '禁 Prisma client extension($extends):与全局软删中间件同源风险——把过滤语义藏进 client,审计时看不见。[AGENTS §2 永久铁律] 正确做法:显式 where + notDeletedWhere。',
  },
  'no-hard-delete-tx': {
    selector:
      "CallExpression[callee.property.name=/^(delete|deleteMany)$/][callee.object.object.name=/^(prisma|tx)$/]",
    message:
      '禁硬删:业务数据一律软删。[AGENTS §1 软删除] 正确做法:update({ data: { deletedAt: new Date() } }),读侧统一带 notDeletedWhere。确属关联表/会话表物理清理(已冻结 6 处)须在 PR 说明并加 `// eslint-disable-next-line no-restricted-syntax -- <原因>`。细则 docs/reference/soft-delete-transactions.md。',
  },
  'no-hard-delete-this-prisma': {
    selector:
      "CallExpression[callee.property.name=/^(delete|deleteMany)$/][callee.object.object.property.name='prisma']",
    message:
      '禁硬删:业务数据一律软删。[AGENTS §1 软删除] 正确做法:update({ data: { deletedAt: new Date() } }),读侧统一带 notDeletedWhere。确属关联表/会话表物理清理(已冻结 6 处)须在 PR 说明并加 `// eslint-disable-next-line no-restricted-syntax -- <原因>`。',
  },
  'no-prisma-enum-redefine': {
    selector:
      "TSEnumDeclaration[id.name=/^(Role|UserStatus|DictTypeStatus|DictItemStatus|OrganizationStatus|PositionCategory|PolicyStatus|AssignmentStatus|SupervisionScopeMode|SupervisionStatus|MemberStatus|MembershipType|MembershipStatus|ContributionRuleStatus|PrincipalType|BindingScopeType|BindingStatus|PolicyScopeMode|AttachmentAccessLevel|AttachmentTypeConfigStatus|AttachmentMimeConfigStatus|StorageProviderType|StorageMimePolicyMode|SmsProviderType|SmsPurpose|SmsSendStatus|WechatProviderType|RealnameProviderType)$/]",
    message:
      '该名字是 prisma/schema.prisma 已定义的 enum,禁在 TS 侧重定义(会静默漂移)。[AGENTS §1 命名] 正确做法:import { X } from "@prisma/client"。名单由 pnpm harness:guard 从 schema 同步;本地新 enum 请另起名(如 XxxCredentialStatus)。',
  },
  'no-manual-response-wrap': {
    selector:
      "ReturnStatement > ObjectExpression:has(Property[key.name='code']):has(Property[key.name='message'])",
    message:
      '禁手工包 {code,message,...}:全局 ResponseInterceptor 已统一包装,再包一层会变成 data.code。[AGENTS §1 响应格式] 正确做法:只 return 业务 data;错误一律 throw new BizException(BizCode.X)。细则 docs/reference/response-pagination-errors.md。',
  },
  'no-mapped-type-dto': {
    selector: "CallExpression[callee.name=/^(PickType|OmitType|PartialType|IntersectionType)$/]",
    message:
      '禁 Swagger Mapped Types 派生 DTO:派生让 App/Admin 出参隐式联动,一次 Admin 加字段就可能把 L3 泄到 App。[AGENTS §1 DTO 边界 + §2 D-6] 正确做法:显式重写字段(本仓 DTO 全部显式声明,零 Mapped Type)。细则 docs/reference/naming-dto-validation.md。',
  },
  'no-local-strategy': {
    selector: "CallExpression[callee.name='AuthGuard'][arguments.0.value='local']",
    message:
      "不引入 LocalStrategy / AuthGuard('local')。[AGENTS §2 永久铁律] 正确做法:登录在 AuthService 内显式校验凭据、签发 JWT,由 JwtStrategy 单轨消费。",
  },
  'no-pagination-alias': {
    selector:
      "ClassDeclaration:not([id.name=/OptionsQueryDto$/]) > ClassBody > PropertyDefinition[key.name=/^(limit|offset|cursor|skip|take)$/]",
    message:
      '分页入参固定 page / pageSize,禁 limit / offset / cursor / skip / take 变体。[AGENTS §1 响应格式] 正确做法:extends PaginationQueryDto(src/common/dto/pagination.dto.ts)。唯一例外:不分页的下拉候选 DTO,类名须以 OptionsQueryDto 结尾。',
  },
  'no-process-env': {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message:
      '禁散落 process.env(含 NODE_ENV)。[AGENTS §1 配置归属] 正确做法:在 src/config/*.config.ts 解析 + production fail-fast,业务侧用 ConfigService.get<XConfig>("x");业务判断只用 APP_ENV。细则 docs/reference/config-env.md。',
  },
  'no-identity-cache': {
    selector: "PropertyDefinition[value.callee.name=/^(Map|WeakMap)$/]",
    message:
      '判权/身份路径禁跨请求 Map/WeakMap 缓存。[AGENTS §2 身份/权限不缓存] 正确做法:RbacService 每次判权直读 PostgreSQL 当前 GLOBAL 权限,JwtStrategy.validate 每请求查库;性能问题走索引,不走缓存(TTL = 「改了权限没生效」的正确性链)。',
  },
  'no-identity-timer': {
    selector: "CallExpression[callee.name=/^(setInterval|setTimeout)$/]",
    message:
      '判权/身份路径禁定时器(TTL / 失效链的入口)。[AGENTS §2 身份/权限不缓存] 正确做法:不缓存,不定时刷新。',
  },
  'no-nullable-is-optional': {
    selector: IS_OPTIONAL_NULL_SELECTOR,
    message:
      '`@IsOptional()` 对 null 与 undefined **都**跳过后续校验,而本仓 service 判「传没传」用的是 `=== undefined` —— 显式 null 会穿过整个契约层(实测:审核 issuedAt:null → new Date(null) = 1970-01-01 落成正式事实;Policy/Certificate PATCH → 500 而非 400)。[AGENTS §1 校验] 正确做法:字段**真能清空** → 保留 @IsOptional() 并把 TS 类型标成 `T | null`(同时 @ApiPropertyOptional({ nullable: true, type: X }),让 DTO/OpenAPI/DB 三处一致);字段**只是可省略** → 改用 @OmittableOnly()(src/common/decorators/omittable-only.decorator.ts),null 稳定 400。存量违规在本文件 IS_OPTIONAL_NULL_BASELINE 内逐条具名冻结,**只减不增**。',
  },
  'no-param-id-string': {
    selector: "Decorator[expression.callee.name='Param'][expression.arguments.0.value='id']",
    message:
      "`:id` 一律走 IdParamDto:@Param('id') id: string 绕过 DTO 白名单,长度/类型全不校验。[AGENTS §1 校验] 正确做法:@Param() params: IdParamDto(src/common/dto/id-param.dto.ts),取 params.id。存量 19 个 controller 已在 LEGACY_PARAM_ID_CONTROLLERS 冻结(只减不增),新文件一律禁止。",
  },
};

const syntax = (...ids) => ['error', ...ids.map((id) => HARNESS_SYNTAX[id])];

// 全仓通用集(src / test / prisma 都判)
const BASE = [
  'no-use-guards',
  'no-roles-decorator',
  'no-bare-api-ok-response',
  'no-local-validation-pipe',
  'no-prisma-middleware',
  'no-prisma-client-extension',
  'no-prisma-enum-redefine',
  'no-manual-response-wrap',
  'no-mapped-type-dto',
  'no-local-strategy',
  'no-pagination-alias',
  // 第 18 条默认对全仓生效(含 test / prisma —— 两处实测零违规,所以是白拿的)。
  // 存量由下方 IS_OPTIONAL_NULL_BASELINE 逐条豁免,不是整目录通配。
  'no-nullable-is-optional',
];

// src 业务代码 = 通用集 + 禁 process.env + 禁硬删
// (硬删只判 src:test 造数/清场硬删实测 209 处合法,prisma/seed 亦然)
const SRC = [...BASE, 'no-process-env', 'no-hard-delete-tx', 'no-hard-delete-this-prisma'];

// BASELINE:存量 71 处 @Param('id') 所在的 19 个 controller。只减不增;
// 某文件清零后删掉对应行,规则自动对该文件生效。清零全部后整块删除。
const LEGACY_PARAM_ID_CONTROLLERS = [
  'src/modules/certificates/certificates.controller.ts',
  'src/modules/content/content-admin.controller.ts',
  'src/modules/content/content-app.controller.ts',
  'src/modules/content/content-public.controller.ts',
  'src/modules/emergency-contacts/emergency-contacts.controller.ts',
  'src/modules/insurances/controllers/app-me-insurances.controller.ts',
  'src/modules/insurances/team-insurance-policies.controller.ts',
  'src/modules/member-departments/memberships-admin.controller.ts',
  'src/modules/member-departments/memberships.controller.ts',
  'src/modules/notifications/notification-admin.controller.ts',
  'src/modules/notifications/notification-app.controller.ts',
  'src/modules/position-assignments/position-assignments.controller.ts',
  'src/modules/recruitment/recruitment-applications.admin.controller.ts',
  'src/modules/recruitment/recruitment-cycles.controller.ts',
  'src/modules/role-bindings/role-bindings.controller.ts',
  'src/modules/supervision-assignments/supervision-assignments.controller.ts',
  'src/modules/team-join/team-join-applications.admin.controller.ts',
  'src/modules/team-join/team-join-applications.app.controller.ts',
  'src/modules/team-join/team-join-cycles.controller.ts',
];

// BASELINE(第 18 条):存量 641 处 / 56 文件,**全部在 src/**(test/ 与 prisma/ 实测零违规)。
//
// 为什么用棘轮而不是一次改完:641 处 = 一个没人能评审的超大 diff,而跨模型评审是
// 本仓唯一兜底。棘轮让「新写的代码不能再犯」立刻生效,存量按批次还。
//
// 为什么键是「类名.字段名」而不是行号:行号一改就失效,基线立刻变成噪音;而
// `description` 这类字段名在同一文件的多个 DTO 类里各出现一次,只写字段名
// **区分不开**「已冻结的那个」和「新加的那个」—— 而后者正是棘轮要拦的东西。
//
// 只减不增,两道执行位各管一半:
//   · 往**已在基线里的文件**新增一个违规字段 → `pnpm lint` 当场红
//     (它不在该文件被挖掉的名单里,见下方 isOptionalNullBaselineBlocks);
//   · 修好一个存量却忘了删基线行 → `pnpm harness:selftest` 当场红
//     (scripts/harness-eslint.selftest.ts 扫全仓比对,陈旧行 = 基线在说谎)。
// 前者 lint 做得到、后者做不到(一条用不上的豁免是静默无害的),所以必须两道都有。
const IS_OPTIONAL_NULL_BASELINE = {
  'src/common/dto/pagination.dto.ts': ['PaginationQueryDto.page', 'PaginationQueryDto.pageSize'],
  'src/modules/activities/activities.dto.ts': ['ActivityOptionsQueryDto.limit', 'ActivityOptionsQueryDto.organizationId', 'ActivityOptionsQueryDto.q', 'ActivityOptionsQueryDto.statusCode', 'CancelActivityDto.cancelReason', 'CreateActivityDto.capacity', 'CreateActivityDto.content', 'CreateActivityDto.coverImageUrl', 'CreateActivityDto.description', 'CreateActivityDto.galleryImageUrls', 'CreateActivityDto.genderRequirementCode', 'CreateActivityDto.initiatorMemberId', 'CreateActivityDto.isPublicRegistration', 'CreateActivityDto.locationLatitude', 'CreateActivityDto.locationLongitude', 'CreateActivityDto.registrationDeadline', 'CreateActivityDto.registrationNotes', 'CreateActivityDto.registrationSchema', 'CreateActivityDto.requiresInsurance', 'ListActivitiesQueryDto.activityTypeCode', 'ListActivitiesQueryDto.dateFrom', 'ListActivitiesQueryDto.dateTo', 'ListActivitiesQueryDto.includeDescendants', 'ListActivitiesQueryDto.includeStats', 'ListActivitiesQueryDto.isPublicRegistration', 'ListActivitiesQueryDto.organizationId', 'ListActivitiesQueryDto.q', 'ListActivitiesQueryDto.statusCode', 'UpdateActivityDto.activityTypeCode', 'UpdateActivityDto.content', 'UpdateActivityDto.coverImageUrl', 'UpdateActivityDto.description', 'UpdateActivityDto.endAt', 'UpdateActivityDto.galleryImageUrls', 'UpdateActivityDto.genderRequirementCode', 'UpdateActivityDto.isPublicRegistration', 'UpdateActivityDto.location', 'UpdateActivityDto.locationLatitude', 'UpdateActivityDto.locationLongitude', 'UpdateActivityDto.organizationId', 'UpdateActivityDto.registrationDeadline', 'UpdateActivityDto.registrationNotes', 'UpdateActivityDto.registrationSchema', 'UpdateActivityDto.requiresInsurance', 'UpdateActivityDto.startAt', 'UpdateActivityDto.title'],
  'src/modules/activities/activity-publish-review.dto.ts': ['ApproveActivityPublishReviewDto.reviewNote', 'ListActivityPublishReviewsQueryDto.activityQ', 'ListActivityPublishReviewsQueryDto.includeDescendants', 'ListActivityPublishReviewsQueryDto.initiatorQ', 'ListActivityPublishReviewsQueryDto.organizationId', 'ListActivityPublishReviewsQueryDto.requestType', 'ListActivityPublishReviewsQueryDto.status', 'ListActivityPublishReviewsQueryDto.submittedFrom', 'ListActivityPublishReviewsQueryDto.submittedTo'],
  'src/modules/activities/activity-responsibility.dto.ts': ['CreateActivityCollaboratorDto.reason'],
  'src/modules/activities/dto/app/app-managed-activity.dto.ts': ['AppActivityChangePositionDto.activityPositionId', 'AppActivityChangePositionDto.clientRef', 'AppManagedActivitiesQueryDto.statusCode', 'AppSubmitActivityChangeReviewDto.positions', 'CreateAppManagedActivityDto.capacity', 'CreateAppManagedActivityDto.content', 'CreateAppManagedActivityDto.coverImageUrl', 'CreateAppManagedActivityDto.description', 'CreateAppManagedActivityDto.genderRequirementCode', 'CreateAppManagedActivityDto.isPublicRegistration', 'CreateAppManagedActivityDto.locationLatitude', 'CreateAppManagedActivityDto.locationLongitude', 'CreateAppManagedActivityDto.registrationDeadline', 'CreateAppManagedActivityDto.registrationNotes', 'CreateAppManagedActivityDto.registrationSchema', 'CreateAppManagedActivityDto.requiresInsurance', 'CreateAppManagedActivityPositionDto.sortOrder', 'CreateAppManagedCollaboratorDto.reason', 'UpdateAppManagedActivityDto.activityTypeCode', 'UpdateAppManagedActivityDto.content', 'UpdateAppManagedActivityDto.coverImageUrl', 'UpdateAppManagedActivityDto.description', 'UpdateAppManagedActivityDto.endAt', 'UpdateAppManagedActivityDto.genderRequirementCode', 'UpdateAppManagedActivityDto.isPublicRegistration', 'UpdateAppManagedActivityDto.location', 'UpdateAppManagedActivityDto.locationLatitude', 'UpdateAppManagedActivityDto.locationLongitude', 'UpdateAppManagedActivityDto.organizationId', 'UpdateAppManagedActivityDto.registrationDeadline', 'UpdateAppManagedActivityDto.registrationNotes', 'UpdateAppManagedActivityDto.registrationSchema', 'UpdateAppManagedActivityDto.requiresInsurance', 'UpdateAppManagedActivityDto.startAt', 'UpdateAppManagedActivityDto.title', 'UpdateAppManagedActivityPositionDto.attendanceRoleCode', 'UpdateAppManagedActivityPositionDto.name', 'UpdateAppManagedActivityPositionDto.sortOrder'],
  'src/modules/activities/dto/app/list-app-my-activities-query.dto.ts': ['ListAppMyActivitiesQueryDto.registrationStatusCode'],
  'src/modules/activity-registrations/activity-registrations.dto.ts': ['ApproveRegistrationDto.reviewNote', 'BulkReviewRegistrationsDto.reviewNote', 'CancelRegistrationDto.cancelReason', 'CreateMyRegistrationDto.activityPositionId', 'CreateMyRegistrationDto.extras', 'CreateRegistrationDto.activityPositionId', 'CreateRegistrationDto.extras', 'ExportRegistrationsQueryDto.format', 'ExportRegistrationsQueryDto.scope', 'ListMyRegistrationsQueryDto.statusCode', 'ListRegistrationsQueryDto.activityId', 'ListRegistrationsQueryDto.activityQ', 'ListRegistrationsQueryDto.dateFrom', 'ListRegistrationsQueryDto.dateTo', 'ListRegistrationsQueryDto.expand', 'ListRegistrationsQueryDto.includeDescendants', 'ListRegistrationsQueryDto.memberId', 'ListRegistrationsQueryDto.memberQ', 'ListRegistrationsQueryDto.organizationId', 'ListRegistrationsQueryDto.q', 'ListRegistrationsQueryDto.statusCode'],
  'src/modules/activity-registrations/dto/app/app-managed-registration.dto.ts': ['AppManagedRegistrationsQueryDto.statusCode', 'ApproveAppManagedRegistrationDto.reviewNote', 'BulkReviewAppManagedRegistrationsDto.reviewNote', 'CancelAppManagedRegistrationDto.cancelReason'],
  'src/modules/activity-registrations/dto/app/cancel-app-my-registration.dto.ts': ['CancelAppMyRegistrationDto.cancelReason'],
  'src/modules/activity-registrations/dto/app/create-app-my-registration.dto.ts': ['CreateAppMyRegistrationDto.activityPositionId', 'CreateAppMyRegistrationDto.extras'],
  'src/modules/activity-registrations/dto/app/list-app-my-registrations-query.dto.ts': ['ListAppMyRegistrationsQueryDto.statusCode'],
  'src/modules/announcement-import/announcement-import.dto.ts': ['AnnouncementImportRequestDto.organizations', 'AnnouncementImportRequestDto.positions', 'AnnouncementImportRequestDto.supervisions', 'ImportOrganizationRowDto.code', 'ImportOrganizationRowDto.establishmentStatusCode', 'ImportOrganizationRowDto.groupFunctionCode', 'ImportOrganizationRowDto.name', 'ImportOrganizationRowDto.parentCode', 'ImportOrganizationRowDto.sortOrder', 'ImportPositionRowDto.appointmentSource', 'ImportPositionRowDto.displayName', 'ImportPositionRowDto.endedAt', 'ImportPositionRowDto.isConcurrent', 'ImportPositionRowDto.memberNo', 'ImportPositionRowDto.note', 'ImportPositionRowDto.orgCode', 'ImportPositionRowDto.positionCode', 'ImportPositionRowDto.startedAt', 'ImportSupervisionRowDto.displayName', 'ImportSupervisionRowDto.endedAt', 'ImportSupervisionRowDto.note', 'ImportSupervisionRowDto.orgCode', 'ImportSupervisionRowDto.scopeMode', 'ImportSupervisionRowDto.startedAt', 'ImportSupervisionRowDto.supervisorMemberNo'],
  'src/modules/attachment-configs/attachment-mime-configs.dto.ts': ['CreateAttachmentMimeConfigDto.remark', 'ListAttachmentMimeConfigsQueryDto.mime', 'ListAttachmentMimeConfigsQueryDto.status', 'ListAttachmentMimeConfigsQueryDto.typeConfigId', 'UpdateAttachmentMimeConfigDto.remark'],
  'src/modules/attachment-configs/attachment-size-limit-configs.dto.ts': ['CreateAttachmentSizeLimitConfigDto.remark', 'ListAttachmentSizeLimitConfigsQueryDto.typeConfigId', 'UpdateAttachmentSizeLimitConfigDto.maxSizeBytes', 'UpdateAttachmentSizeLimitConfigDto.remark'],
  'src/modules/attachment-configs/attachment-type-configs.dto.ts': ['CreateAttachmentTypeConfigDto.defaultMimeWhitelist', 'CreateAttachmentTypeConfigDto.description', 'ListAttachmentTypeConfigsQueryDto.ownerTable', 'ListAttachmentTypeConfigsQueryDto.status', 'UpdateAttachmentTypeConfigDto.defaultMimeWhitelist', 'UpdateAttachmentTypeConfigDto.description', 'UpdateAttachmentTypeConfigDto.displayName', 'UpdateAttachmentTypeConfigDto.ownerTable'],
  'src/modules/attachments/attachments.dto.ts': ['ConfirmUploadDto.checksum', 'CreateAttachmentDto.accessLevel', 'CreateAttachmentDto.description', 'CreateAttachmentDto.expireAt', 'CreateAttachmentDto.tags', 'ListAttachmentsQueryDto.accessLevel', 'ListAttachmentsQueryDto.mime', 'ListAttachmentsQueryDto.ownerId', 'ListAttachmentsQueryDto.ownerType', 'ListAttachmentsQueryDto.tags', 'ListAttachmentsQueryDto.uploadedBy', 'UpdateAttachmentDto.tags'],
  'src/modules/attendances/attendances.dto.ts': ['ApproveAttendanceSheetDto.reviewNote', 'AttendanceRecordInputDto.note', 'AttendanceRecordInputDto.registrationId', 'AttendanceRecordInputDto.serviceHours', 'FinalApproveAttendanceSheetDto.finalReviewNote', 'ListAttendanceSheetsQueryDto.activityQ', 'ListAttendanceSheetsQueryDto.dateFrom', 'ListAttendanceSheetsQueryDto.dateTo', 'ListAttendanceSheetsQueryDto.expand', 'ListAttendanceSheetsQueryDto.includeDescendants', 'ListAttendanceSheetsQueryDto.organizationId', 'ListAttendanceSheetsQueryDto.q', 'ListAttendanceSheetsQueryDto.statusCode', 'MyAttendanceRecordsQueryDto.activityId', 'UpdateAttendanceSheetDto.records'],
  'src/modules/attendances/dto/app/activity-check-in-location.dto.ts': ['ActivityCheckInLocationDto.accuracy'],
  'src/modules/attendances/dto/app/app-managed-attendance.dto.ts': ['AppManagedAttendanceRecordInputDto.note', 'AppManagedAttendanceRecordInputDto.registrationId', 'AppManagedAttendanceRecordInputDto.serviceHours', 'AppManagedAttendanceSheetsQueryDto.statusCode', 'UpdateAppManagedAttendanceSheetDto.records'],
  'src/modules/attendances/dto/app/list-app-my-attendance-records-query.dto.ts': ['ListAppMyAttendanceRecordsQueryDto.activityId'],
  'src/modules/audit-logs/audit-logs.dto.ts': ['AuditLogQueryDto.actorUserId', 'AuditLogQueryDto.endDate', 'AuditLogQueryDto.event', 'AuditLogQueryDto.resourceId', 'AuditLogQueryDto.resourceType', 'AuditLogQueryDto.startDate'],
  'src/modules/authz/authz.dto.ts': ['ActionStateItemDto.key', 'ExplainAuthzDto.resourceRef', 'ExplainBatchItemDto.resourceRef'],
  'src/modules/certificates/certificates-workbench.dto.ts': ['CertificateWorkbenchFilterDto.categoryCode', 'CertificateWorkbenchFilterDto.certStatusCode', 'CertificateWorkbenchFilterDto.expiresFrom', 'CertificateWorkbenchFilterDto.expiresTo', 'CertificateWorkbenchFilterDto.includeDescendants', 'CertificateWorkbenchFilterDto.issuedFrom', 'CertificateWorkbenchFilterDto.issuedTo', 'CertificateWorkbenchFilterDto.levelCode', 'CertificateWorkbenchFilterDto.memberId', 'CertificateWorkbenchFilterDto.organizationId', 'CertificateWorkbenchFilterDto.q', 'CertificateWorkbenchFilterDto.sourceCode', 'CertificateWorkbenchFilterDto.standardCode', 'ListCertificateWorkbenchQueryDto.page', 'ListCertificateWorkbenchQueryDto.pageSize'],
  'src/modules/certificates/dto/app/list-app-my-certificates-query.dto.ts': ['ListAppMyCertificatesQueryDto.certCategoryCode', 'ListAppMyCertificatesQueryDto.certStatusCode'],
  'src/modules/content/content.dto.ts': ['ContentAttachmentConfirmDto.checksum', 'ContentAttachmentConfirmDto.etag', 'CreateContentDto.pinned', 'CreateContentDto.summary', 'CreateContentDto.tags', 'CreateContentDto.visibleOrganizationIds', 'ListContentAdminQueryDto.contentTypeCode', 'ListContentAdminQueryDto.keyword', 'ListContentAdminQueryDto.page', 'ListContentAdminQueryDto.pageSize', 'ListContentAdminQueryDto.pinned', 'ListContentAdminQueryDto.statusCode', 'ListContentAdminQueryDto.tags', 'ListContentAdminQueryDto.visibilityCode', 'ListContentReadQueryDto.contentTypeCode', 'ListContentReadQueryDto.keyword', 'ListContentReadQueryDto.page', 'ListContentReadQueryDto.pageSize', 'ListContentReadQueryDto.tags', 'UpdateContentDto.body', 'UpdateContentDto.contentTypeCode', 'UpdateContentDto.pinned', 'UpdateContentDto.tags', 'UpdateContentDto.title', 'UpdateContentDto.visibilityCode', 'UpdateContentDto.visibleOrganizationIds'],
  'src/modules/contribution-rules/contribution-rules.dto.ts': ['ContributionRuleQueryDto.activityTypeCode', 'ContributionRuleQueryDto.attendanceRoleCode', 'ContributionRuleQueryDto.status', 'CreateContributionRuleDto.remark', 'CreateContributionRuleDto.status', 'UpdateContributionRuleDto.pointsBelow', 'UpdateContributionRuleDto.status'],
  'src/modules/dictionaries/dictionaries.dto.ts': ['CreateDictItemDto.parentId', 'CreateDictItemDto.sortOrder', 'CreateDictTypeDto.sortOrder', 'DictItemTreeQueryDto.status', 'ListDictItemsQueryDto.parentId', 'ListDictItemsQueryDto.status', 'ListDictTypesQueryDto.status', 'UpdateDictItemDto.label', 'UpdateDictItemDto.sortOrder', 'UpdateDictTypeDto.label', 'UpdateDictTypeDto.sortOrder'],
  'src/modules/emergency-contacts/emergency-contacts.dto.ts': ['CreateEmergencyContactDto.address', 'CreateEmergencyContactDto.phoneBackup', 'CreateEmergencyContactDto.priority', 'UpdateEmergencyContactDto.address', 'UpdateEmergencyContactDto.contactName', 'UpdateEmergencyContactDto.phoneBackup', 'UpdateEmergencyContactDto.phonePrimary', 'UpdateEmergencyContactDto.priority', 'UpdateEmergencyContactDto.relationCode'],
  'src/modules/insurances/dto/app/create-app-me-insurance.dto.ts': ['CreateAppMeInsuranceDto.coverageStart'],
  'src/modules/insurances/dto/app/delete-app-me-insurance-query.dto.ts': ['DeleteAppMeInsuranceQueryDto.expectedVersion'],
  'src/modules/insurances/dto/app/update-app-me-insurance.dto.ts': ['UpdateAppMeInsuranceDto.coverageEnd', 'UpdateAppMeInsuranceDto.coverageStart', 'UpdateAppMeInsuranceDto.expectedVersion', 'UpdateAppMeInsuranceDto.insurerName', 'UpdateAppMeInsuranceDto.policyNumber'],
  'src/modules/insurances/insurances.dto.ts': ['CreateTeamInsurancePolicyDto.note', 'UpdateTeamInsurancePolicyDto.coverageEnd', 'UpdateTeamInsurancePolicyDto.coverageStart', 'UpdateTeamInsurancePolicyDto.insurerName', 'UpdateTeamInsurancePolicyDto.note', 'UpdateTeamInsurancePolicyDto.policyNumber'],
  'src/modules/member-departments/memberships.dto.ts': ['CreateMembershipDto.reason', 'MembershipConflictsQueryDto.includeDescendants', 'MembershipConflictsQueryDto.organizationId', 'OrgMembersOptionsQueryDto.includeDescendants', 'OrgMembersOptionsQueryDto.limit', 'OrgMembersOptionsQueryDto.q', 'OrgMembershipsQueryDto.expand', 'OrgMembershipsQueryDto.includeDescendants', 'OrgMembershipsQueryDto.membershipType', 'OrgMembershipsQueryDto.q', 'OrgMembershipsQueryDto.status', 'PageMembershipsQueryDto.expand', 'PageMembershipsQueryDto.includeDescendants', 'PageMembershipsQueryDto.memberId', 'PageMembershipsQueryDto.membershipType', 'PageMembershipsQueryDto.organizationId', 'PageMembershipsQueryDto.q', 'PageMembershipsQueryDto.status', 'TransferMembershipDto.reason', 'UpdateMembershipDto.endedAt', 'UpdateMembershipDto.membershipType', 'UpdateMembershipDto.reason', 'UpdateMembershipDto.startedAt'],
  'src/modules/member-profiles/dto/create-member-profile.dto.ts': ['CreateMemberProfileDto.bloodTypeCode', 'CreateMemberProfileDto.educationCode', 'CreateMemberProfileDto.ethnicityCode', 'CreateMemberProfileDto.exerciseFrequencyCode', 'CreateMemberProfileDto.exerciseMethods', 'CreateMemberProfileDto.exerciseSportCode', 'CreateMemberProfileDto.eyesight', 'CreateMemberProfileDto.firstAidKnowledgeCode', 'CreateMemberProfileDto.firstAidSkills', 'CreateMemberProfileDto.hasVehicle', 'CreateMemberProfileDto.heightCm', 'CreateMemberProfileDto.isVeteran', 'CreateMemberProfileDto.landline', 'CreateMemberProfileDto.major', 'CreateMemberProfileDto.maritalStatusCode', 'CreateMemberProfileDto.medicalNotes', 'CreateMemberProfileDto.noCriminalRecordSigned', 'CreateMemberProfileDto.otherSkills', 'CreateMemberProfileDto.politicalStatusCode', 'CreateMemberProfileDto.privacyConsentSignedAt', 'CreateMemberProfileDto.qq', 'CreateMemberProfileDto.residenceArea', 'CreateMemberProfileDto.vehicleType', 'CreateMemberProfileDto.volunteerNo', 'CreateMemberProfileDto.wechat', 'CreateMemberProfileDto.weightKg', 'CreateMemberProfileDto.workArea', 'CreateMemberProfileDto.workNatureCode'],
  'src/modules/member-profiles/dto/member-profile.shared.dto.ts': ['MedicalNoteItemDto.note'],
  'src/modules/member-profiles/dto/update-member-profile.dto.ts': ['UpdateMemberProfileDto.birthDate', 'UpdateMemberProfileDto.bloodTypeCode', 'UpdateMemberProfileDto.documentNumber', 'UpdateMemberProfileDto.documentTypeCode', 'UpdateMemberProfileDto.educationCode', 'UpdateMemberProfileDto.email', 'UpdateMemberProfileDto.ethnicityCode', 'UpdateMemberProfileDto.exerciseFrequencyCode', 'UpdateMemberProfileDto.exerciseMethods', 'UpdateMemberProfileDto.exerciseSportCode', 'UpdateMemberProfileDto.eyesight', 'UpdateMemberProfileDto.firstAidKnowledgeCode', 'UpdateMemberProfileDto.firstAidSkills', 'UpdateMemberProfileDto.genderCode', 'UpdateMemberProfileDto.hasVehicle', 'UpdateMemberProfileDto.heightCm', 'UpdateMemberProfileDto.isVeteran', 'UpdateMemberProfileDto.joinSourceCode', 'UpdateMemberProfileDto.joinedDate', 'UpdateMemberProfileDto.landline', 'UpdateMemberProfileDto.major', 'UpdateMemberProfileDto.maritalStatusCode', 'UpdateMemberProfileDto.medicalNotes', 'UpdateMemberProfileDto.mobile', 'UpdateMemberProfileDto.noCriminalRecordSigned', 'UpdateMemberProfileDto.otherSkills', 'UpdateMemberProfileDto.politicalStatusCode', 'UpdateMemberProfileDto.privacyConsentSigned', 'UpdateMemberProfileDto.privacyConsentSignedAt', 'UpdateMemberProfileDto.qq', 'UpdateMemberProfileDto.realName', 'UpdateMemberProfileDto.residenceArea', 'UpdateMemberProfileDto.vehicleType', 'UpdateMemberProfileDto.volunteerNo', 'UpdateMemberProfileDto.wechat', 'UpdateMemberProfileDto.weightKg', 'UpdateMemberProfileDto.workArea', 'UpdateMemberProfileDto.workNatureCode'],
  'src/modules/members/members.dto.ts': ['CreateMemberDto.gradeCode', 'ListMembersQueryDto.gradeCode', 'ListMembersQueryDto.hasAccount', 'ListMembersQueryDto.includeDescendants', 'ListMembersQueryDto.memberNo', 'ListMembersQueryDto.organizationId', 'ListMembersQueryDto.q', 'ListMembersQueryDto.status', 'MemberOptionsQueryDto.includeDescendants', 'MemberOptionsQueryDto.limit', 'MemberOptionsQueryDto.organizationId', 'MemberOptionsQueryDto.q', 'UpdateMemberDto.displayName', 'UpdateMemberDto.gradeCode'],
  'src/modules/meta/participation-overview.dto.ts': ['ParticipationOverviewQueryDto.activityTypeCode', 'ParticipationOverviewQueryDto.dateFrom', 'ParticipationOverviewQueryDto.dateTo', 'ParticipationOverviewQueryDto.includeDescendants', 'ParticipationOverviewQueryDto.organizationId'],
  'src/modules/notifications/notification.dto.ts': ['CreateNotificationDto.channels', 'CreateNotificationDto.pinned', 'CreateNotificationDto.visibleOrganizationIds', 'ListNotificationAdminQueryDto.notificationTypeCode', 'ListNotificationAdminQueryDto.page', 'ListNotificationAdminQueryDto.pageSize', 'ListNotificationAdminQueryDto.pinned', 'ListNotificationAdminQueryDto.statusCode', 'ListNotificationAdminQueryDto.visibilityCode', 'ListNotificationReadQueryDto.page', 'ListNotificationReadQueryDto.pageSize', 'UpdateNotificationDto.body', 'UpdateNotificationDto.channels', 'UpdateNotificationDto.notificationTypeCode', 'UpdateNotificationDto.pinned', 'UpdateNotificationDto.title', 'UpdateNotificationDto.visibilityCode', 'UpdateNotificationDto.visibleOrganizationIds', 'UpsertWechatSubscribeTemplateDto.enabled', 'UpsertWechatSubscribeTemplateDto.remarks', 'UpsertWechatSubscribeTemplateDto.templateId'],
  'src/modules/organizations/organizations.dto.ts': ['CreateOrganizationDto.code', 'CreateOrganizationDto.establishmentStatusCode', 'CreateOrganizationDto.groupFunctionCode', 'CreateOrganizationDto.parentId', 'CreateOrganizationDto.sortOrder', 'ListOrganizationsQueryDto.codeContains', 'ListOrganizationsQueryDto.nameContains', 'ListOrganizationsQueryDto.nodeTypeCode', 'ListOrganizationsQueryDto.parentId', 'ListOrganizationsQueryDto.q', 'ListOrganizationsQueryDto.status', 'OrganizationOptionsQueryDto.limit', 'OrganizationOptionsQueryDto.nodeTypeCode', 'OrganizationOptionsQueryDto.q', 'OrganizationOptionsQueryDto.status', 'OrganizationTreeQueryDto.status', 'UpdateOrganizationDto.code', 'UpdateOrganizationDto.name', 'UpdateOrganizationDto.nodeTypeCode', 'UpdateOrganizationDto.sortOrder'],
  'src/modules/permissions/permissions.dto.ts': ['CreatePermissionDto.description', 'ListPermissionsQueryDto.module', 'ListPermissionsQueryDto.resourceType', 'UpdatePermissionDto.description'],
  'src/modules/permissions/rbac-roles.dto.ts': ['CreateRbacRoleDto.description', 'ListRbacRolesQueryDto.code', 'RoleOptionsQueryDto.limit', 'RoleOptionsQueryDto.q', 'UpdateRbacRoleDto.description', 'UpdateRbacRoleDto.displayName'],
  'src/modules/permissions/rbac.dto.ts': ['ReloadRbacDto.roleId', 'ReloadRbacDto.scope', 'ReloadRbacDto.userId'],
  'src/modules/position-assignments/position-assignments.dto.ts': ['CreatePositionAssignmentDto.appointmentSource', 'CreatePositionAssignmentDto.endedAt', 'CreatePositionAssignmentDto.isConcurrent', 'CreatePositionAssignmentDto.note', 'PagePositionAssignmentsQueryDto.expand', 'PagePositionAssignmentsQueryDto.includeDescendants', 'PagePositionAssignmentsQueryDto.memberId', 'PagePositionAssignmentsQueryDto.organizationId', 'PagePositionAssignmentsQueryDto.positionId', 'PagePositionAssignmentsQueryDto.q', 'PagePositionAssignmentsQueryDto.status', 'PreviewPositionAssignmentDto.appointmentSource', 'PreviewPositionAssignmentDto.endedAt', 'PreviewPositionAssignmentDto.isConcurrent', 'PreviewPositionAssignmentDto.note'],
  'src/modules/positions/position-rules.dto.ts': ['CreatePositionRuleDto.allowConcurrent', 'CreatePositionRuleDto.requireMembership', 'CreatePositionRuleDto.required', 'CreatePositionRuleDto.status', 'PositionRuleQueryDto.nodeTypeCode', 'PositionRuleQueryDto.positionId', 'PositionRuleQueryDto.status', 'UpdatePositionRuleDto.allowConcurrent', 'UpdatePositionRuleDto.requireMembership', 'UpdatePositionRuleDto.required', 'UpdatePositionRuleDto.status'],
  'src/modules/positions/positions.dto.ts': ['CreatePositionDto.allowConcurrent', 'CreatePositionDto.allowMultiple', 'CreatePositionDto.description', 'CreatePositionDto.isLeadership', 'CreatePositionDto.rank', 'CreatePositionDto.sortOrder', 'CreatePositionDto.status', 'PositionOptionsQueryDto.categoryCode', 'PositionOptionsQueryDto.limit', 'PositionOptionsQueryDto.q', 'PositionOptionsQueryDto.status', 'PositionQueryDto.categoryCode', 'PositionQueryDto.status', 'UpdatePositionDto.allowConcurrent', 'UpdatePositionDto.allowMultiple', 'UpdatePositionDto.categoryCode', 'UpdatePositionDto.isLeadership', 'UpdatePositionDto.name', 'UpdatePositionDto.rank', 'UpdatePositionDto.sortOrder', 'UpdatePositionDto.status'],
  'src/modules/realname/realname.dto.ts': ['UpdateRealnameSettingsDto.enabled', 'UpdateRealnameSettingsDto.providerType', 'UpdateRealnameSettingsDto.region', 'UpdateRealnameSettingsDto.remarks'],
  'src/modules/recruitment/recruitment.dto.ts': ['BatchMarkThresholdDto.cycleId', 'BatchMarkThresholdMatchDto.phone', 'BatchMarkThresholdMatchDto.realName', 'BatchMarkThresholdMatchDto.tempNo', 'CreateRecruitmentCycleDto.capacity', 'EvaluateRecruitmentApplicationDto.note', 'ExportRecruitmentApplicationsDto.cycleId', 'ExportRecruitmentApplicationsDto.filter', 'RecruitmentApplicationListQueryDto.cycleId', 'RecruitmentApplicationListQueryDto.riskLevel', 'RecruitmentApplicationListQueryDto.statusCode', 'RecruitmentRebindPhoneDto.reason', 'RecruitmentSubmitPayloadDto.applicantConfirmedOcrWrong', 'RecruitmentSubmitPayloadDto.privacyConsentVersion', 'RecruitmentSubmitPayloadDto.profileExtra', 'RecruitmentSubmitPayloadDto.wechatCode', 'RecruitmentWithdrawDto.code', 'RecruitmentWithdrawDto.phone', 'RecruitmentWithdrawDto.wechatCode', 'ResolveRecruitmentApplicationDto.reviewNote', 'UpdateRecruitmentApplicationDto.birthDate', 'UpdateRecruitmentApplicationDto.cityDistrict', 'UpdateRecruitmentApplicationDto.detailedAddress', 'UpdateRecruitmentApplicationDto.emergencyContacts', 'UpdateRecruitmentApplicationDto.genderCode', 'UpdateRecruitmentApplicationDto.idCardNumber', 'UpdateRecruitmentApplicationDto.profileExtra', 'UpdateRecruitmentApplicationDto.realName', 'UpdateRecruitmentApplicationDto.sourceChannel', 'UpdateRecruitmentCycleDto.meetingInfo', 'UpdateRecruitmentCycleDto.notifyTemplate', 'UpdateRecruitmentCycleDto.qqGroup', 'UpdateRecruitmentCycleDto.statusCode'],
  'src/modules/role-bindings/role-bindings.dto.ts': ['CreateRoleBindingDto.endedAt', 'CreateRoleBindingDto.note', 'CreateRoleBindingDto.principalId', 'CreateRoleBindingDto.scopeActivityId', 'CreateRoleBindingDto.scopeOrgId', 'CreateRoleBindingDto.scopeResourceId', 'CreateRoleBindingDto.scopeResourceType', 'CreateRoleBindingDto.startedAt', 'ListRoleBindingsQueryDto.principalId', 'ListRoleBindingsQueryDto.principalType', 'ListRoleBindingsQueryDto.roleId', 'ListRoleBindingsQueryDto.scopeType', 'ListRoleBindingsQueryDto.status', 'PageRoleBindingsQueryDto.expand', 'PageRoleBindingsQueryDto.includeExpired', 'PageRoleBindingsQueryDto.principalId', 'PageRoleBindingsQueryDto.principalQ', 'PageRoleBindingsQueryDto.principalType', 'PageRoleBindingsQueryDto.q', 'PageRoleBindingsQueryDto.roleCode', 'PageRoleBindingsQueryDto.roleId', 'PageRoleBindingsQueryDto.scopeOrgId', 'PageRoleBindingsQueryDto.scopeType', 'PageRoleBindingsQueryDto.status', 'PreviewRoleBindingQueryDto.endedAt', 'PreviewRoleBindingQueryDto.note', 'PreviewRoleBindingQueryDto.principalId', 'PreviewRoleBindingQueryDto.scopeActivityId', 'PreviewRoleBindingQueryDto.scopeOrgId', 'PreviewRoleBindingQueryDto.scopeResourceId', 'PreviewRoleBindingQueryDto.scopeResourceType', 'PreviewRoleBindingQueryDto.startedAt', 'UpdateRoleBindingDto.endedAt', 'UpdateRoleBindingDto.note', 'UpdateRoleBindingDto.startedAt', 'UpdateRoleBindingDto.status'],
  'src/modules/sms/sms.dto.ts': ['SmsSendLogQueryDto.phone', 'SmsSendLogQueryDto.status', 'UpdateSmsSettingsDto.enabled', 'UpdateSmsSettingsDto.providerType', 'UpdateSmsSettingsDto.region', 'UpdateSmsSettingsDto.remarks', 'UpdateSmsSettingsDto.sdkAppId', 'UpdateSmsSettingsDto.signName', 'UpdateSmsSettingsDto.templateIdBirthday', 'UpdateSmsSettingsDto.templateIdNotification', 'UpdateSmsSettingsDto.templateIdVerifyCode'],
  'src/modules/storage/storage-settings.dto.ts': ['UpdateStorageSettingsDto.allowedMimePolicyMode', 'UpdateStorageSettingsDto.downloadUrlTtlSeconds', 'UpdateStorageSettingsDto.enableSignedUrl', 'UpdateStorageSettingsDto.enableVersioning', 'UpdateStorageSettingsDto.enabled', 'UpdateStorageSettingsDto.lifecycleDays', 'UpdateStorageSettingsDto.providerType', 'UpdateStorageSettingsDto.uploadUrlTtlSeconds'],
  'src/modules/supervision-assignments/supervision-assignments.dto.ts': ['CreateSupervisionAssignmentDto.endedAt', 'CreateSupervisionAssignmentDto.note', 'CreateSupervisionAssignmentDto.scopeMode', 'PageSupervisionAssignmentsQueryDto.expand', 'PageSupervisionAssignmentsQueryDto.includeDescendants', 'PageSupervisionAssignmentsQueryDto.organizationId', 'PageSupervisionAssignmentsQueryDto.q', 'PageSupervisionAssignmentsQueryDto.scopeMode', 'PageSupervisionAssignmentsQueryDto.status', 'PageSupervisionAssignmentsQueryDto.supervisorMemberId', 'SupervisionCoveragePreviewDto.scopeMode', 'UpdateSupervisionAssignmentDto.endedAt', 'UpdateSupervisionAssignmentDto.note', 'UpdateSupervisionAssignmentDto.scopeMode', 'UpdateSupervisionAssignmentDto.startedAt'],
  'src/modules/team-join/team-join.dto.ts': ['CreateTeamJoinCycleDto.requiresInsurance', 'EvaluateTeamJoinApplicationDto.evaluationExtendedUntil', 'EvaluateTeamJoinApplicationDto.note', 'ListTeamJoinApplicationsQueryDto.cycleId', 'ListTeamJoinApplicationsQueryDto.statusCode', 'MarkGateDto.extendedUntil', 'UpdateTeamJoinCycleDto.name', 'UpdateTeamJoinCycleDto.requiresInsurance', 'UpdateTeamJoinCycleDto.statusCode'],
  'src/modules/users/dto/app/update-app-self-profile.dto.ts': ['UpdateAppSelfProfileDto.avatarKey', 'UpdateAppSelfProfileDto.nickname'],
  'src/modules/users/users.dto.ts': ['CreateUserDto.avatarKey', 'CreateUserDto.email', 'CreateUserDto.nickname', 'CreateUserDto.role', 'ListUsersQueryDto.memberId', 'ListUsersQueryDto.q', 'ListUsersQueryDto.role', 'ListUsersQueryDto.status', 'UpdateMyProfileDto.avatarKey', 'UpdateMyProfileDto.nickname', 'UpdateUserDto.avatarKey', 'UpdateUserDto.email', 'UpdateUserDto.nickname', 'UserOptionsQueryDto.limit', 'UserOptionsQueryDto.q'],
  'src/modules/wechat/wechat.dto.ts': ['UpdateWechatSettingsDto.appId', 'UpdateWechatSettingsDto.enabled', 'UpdateWechatSettingsDto.providerType', 'UpdateWechatSettingsDto.remarks'],
};

const FORBIDDEN_IMPORT_PATHS = [
  {
    name: 'passport-local',
    message:
      '不引入 LocalStrategy。[AGENTS §2 永久铁律] 正确做法:登录在 AuthService 内显式校验凭据 + JwtStrategy 单轨。',
  },
  {
    name: '@nestjs/mapped-types',
    message:
      '禁 Mapped Types 派生 DTO。[AGENTS §1 DTO 边界] 正确做法:显式重写字段,保持 App / Admin DTO 物理隔离。',
  },
  {
    name: '@nestjs/cache-manager',
    message:
      '不引入缓存层。[AGENTS §2 身份/权限不缓存 + 基础设施冻结] 身份与权限必须每请求直读 PostgreSQL;任何 TTL 都会制造「改了权限没生效」的正确性链。',
  },
  {
    name: 'cache-manager',
    message:
      '不引入缓存层。[AGENTS §2 身份/权限不缓存 + 基础设施冻结] 身份与权限必须每请求直读 PostgreSQL。',
  },
  {
    name: 'ioredis',
    message:
      'Redis 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结] 正确做法:异步派发走既有 notification_outbox 表 + cron(全仓恰 2 个)。',
  },
  { name: 'redis', message: 'Redis 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结]' },
  {
    name: 'bullmq',
    message: 'queue 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结] 正确做法:outbox 表 + cron。',
  },
  {
    name: 'bull',
    message: 'queue 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结] 正确做法:outbox 表 + cron。',
  },
  {
    name: '@nestjs/bull',
    message: 'queue 不引入(改锁需 D 档评审)。[AGENTS §2 基础设施冻结] 正确做法:outbox 表 + cron。',
  },
];

const FORBIDDEN_IMPORT_PATTERNS = [
  {
    // ⚠ group 匹配的是 import 说明符字面量(不是解析后的绝对路径),必须写相对形态。
    group: [
      '../*/controllers/*',
      '../*/strategies/*',
      '../*/providers/*',
      '../../*/controllers/*',
      '../../*/strategies/*',
      '../../*/providers/*',
      '**/modules/*/controllers/*',
      '**/modules/*/strategies/*',
      '**/modules/*/providers/*',
    ],
    message:
      '禁跨模块深引另一模块的 controllers/ · strategies/ · providers/ 私有子目录(grab-bag)。[AGENTS §1 模块结构] 正确做法:只经对方 *.service.ts / *.module.ts / *.types.ts / *.constants.ts 公开面交互。',
  },
];

const harnessConfigBlocks = [
  // (a) test / prisma:通用集(不判 process.env / 硬删 —— e2e 造数清场与 seed 合法)
  {
    name: 'srvf/harness:test-prisma',
    files: ['test/**/*.ts', 'prisma/**/*.ts'],
    rules: {
      'no-restricted-syntax': syntax(...BASE),
      'no-restricted-imports': ['error', { paths: FORBIDDEN_IMPORT_PATHS }],
    },
  },

  // (b) src 业务代码:通用集 + 禁 process.env + 禁硬删 + 禁跨模块深引私有子目录
  {
    name: 'srvf/harness:src',
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': syntax(...SRC),
      'no-restricted-imports': [
        'error',
        { paths: FORBIDDEN_IMPORT_PATHS, patterns: FORBIDDEN_IMPORT_PATTERNS },
      ],
    },
  },

  // (c) src 内单测:可直连另一模块 providers 做桩、可 new ValidationPipe 验 DTO
  {
    name: 'srvf/harness:src-spec',
    files: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: FORBIDDEN_IMPORT_PATHS }],
      'no-restricted-syntax': syntax(...SRC.filter((k) => k !== 'no-local-validation-pipe')),
    },
  },

  // (d) 配置 / 启动 / 一次性 CLI:env 的唯一合法读取点(实测越界 0 处)
  {
    name: 'srvf/harness:config-bootstrap',
    files: [
      'src/config/**/*.ts',
      'src/bootstrap/**/*.ts',
      'src/modules/storage/storage-settings-bootstrap.ts',
      'src/local-activity-frontend-fixture.cli.ts',
    ],
    rules: {
      // 去掉 no-process-env(本目录就是 env 归属地);
      // bootstrap 是全局 ValidationPipe 的注册处,去掉 no-local-validation-pipe
      'no-restricted-syntax': syntax(...BASE.filter((k) => k !== 'no-local-validation-pipe')),
    },
  },

  // (e) Guard / 装饰器 / 全局注册处:允许出现被禁装饰器的「定义」与注释样例
  {
    name: 'srvf/harness:guard-definitions',
    files: ['src/common/decorators/**/*.ts', 'src/common/guards/**/*.ts', 'src/app.module.ts'],
    rules: {
      'no-restricted-syntax': syntax(
        ...SRC.filter(
          (k) => !['no-use-guards', 'no-roles-decorator', 'no-bare-api-ok-response'].includes(k),
        ),
      ),
    },
  },

  // (f) controller:额外禁 @Param('id')
  {
    name: 'srvf/harness:controller',
    files: ['src/**/*.controller.ts'],
    rules: { 'no-restricted-syntax': syntax(...SRC, 'no-param-id-string') },
  },

  // (g) BASELINE:19 个存量 controller 暂免 no-param-id-string
  {
    name: 'srvf/harness:controller-param-id-baseline',
    files: LEGACY_PARAM_ID_CONTROLLERS,
    rules: { 'no-restricted-syntax': syntax(...SRC) },
  },

  // (h) 判权 / 身份路径:额外禁缓存与定时器
  //     ⚠ 必须放在 (f)/(g) 之后 —— flat config 同 ruleId 后块整体覆盖前块,
  //     若放前面,permissions/*.controller.ts 会丢掉本块的两条选择器。
  {
    name: 'srvf/harness:no-identity-cache',
    files: ['src/modules/permissions/**/*.ts', 'src/modules/auth/strategies/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': syntax(
        ...SRC,
        'no-param-id-string',
        'no-identity-cache',
        'no-identity-timer',
      ),
    },
  },

  // (i) App DTO 边界:用 @typescript-eslint/no-restricted-imports —— 与核心规则
  //     不同 ruleId,故可与 (b) 的核心 no-restricted-imports 同时生效。
  {
    name: 'srvf/harness:app-dto-boundary',
    files: ['src/**/dto/app/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Admin 专属 DTO 目录:整目录禁引(零存量)
              group: ['../admin/*', '**/dto/admin/*'],
              message:
                'App DTO 禁引 Admin DTO。[AGENTS §1 DTO 边界 + §2 D-6] 正确做法:在 dto/app/ 内显式重写字段;只允许从 common/dto(PaginationQueryDto)与 *.constants / *.types 取值。',
            },
            {
              // 模块平铺 *.dto.ts(管理面 DTO 的实际落点):
              // 常量 / 枚举值数组可引,**类不可引**(类复用 = 隐式契约联动)
              group: ['../../*.dto', '../../../*/*.dto'],
              importNamePattern: '^[A-Z].*Dto$',
              message:
                'App DTO 禁复用管理面 DTO 类(类复用 = Admin 加字段自动漏进 App 出参)。[AGENTS §1 DTO 边界 + §2 D-6] 正确做法:在 dto/app/ 内显式重写该结构;常量 / 枚举值数组可以继续从 *.dto / *.constants 引。',
            },
          ],
        },
      ],
    },
  },

  // (j) Presenter / Policy / StateMachine 纯函数化:不碰 DB
  {
    name: 'srvf/harness:service-boundary',
    files: ['src/**/*.policy.ts', 'src/**/*presenter*.ts', 'src/**/*state-machine*.ts'],
    ignores: [
      'src/**/*.spec.ts',
      // BASELINE(唯一存量,待拍板):RoleDelegationPolicy 注入 PrismaService 作
      // TransactionClient 默认值并自行查 roleBinding/user。只冻结不放宽。
      'src/modules/permissions/role-delegation.policy.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/database/prisma.service', '**/prisma.service'],
              message:
                'Presenter / Policy / StateMachine 不碰 DB,必须是纯函数(入参即全部依赖)。[AGENTS §2 D-7 六类职责边界] 正确做法:由调用方 Service 取数后传入;需要落库的判定放回 Service。',
            },
          ],
        },
      ],
    },
  },
];

// (k) BASELINE 块:每个存量文件一块,把**该文件已冻结的那些字段**从第 18 条里挖掉。
//     豁免用 `:not(<selector list>)` 精确到 `类名.字段名` —— 所以往一个已在基线里的
//     文件**新增**一个违规字段依然会红。这就是「基线只能缩不能涨」在 lint 侧的执行位。
//
//     ⚠️ 必须放在**所有**其他 no-restricted-syntax 块之后:flat config 同 ruleId
//     后块整体覆盖前块。放前面会被 (b)/(f)/(h) 覆盖掉,豁免失效 → 641 处全红。
//     ⚠️ 每块必须重列该文件作用域内的**完整**规则集(用 filter 减掉第 18 条,
//     再把带豁免的版本加回去),只写第 18 条会把其余 17 条对这些文件静默关掉。
//     permissions/ 下的三个文件要多带 (h) 的三条,否则它们会丢掉判权路径的防线。
const isOptionalNullBaselineBlocks = Object.entries(IS_OPTIONAL_NULL_BASELINE).map(
  ([file, frozenFields]) => {
    const exemptions = frozenFields
      .map((entry) => {
        const dot = entry.indexOf('.');
        const className = entry.slice(0, dot);
        const fieldName = entry.slice(dot + 1);
        return `ClassDeclaration[id.name='${className}'] > ClassBody > PropertyDefinition[key.name='${fieldName}']`;
      })
      .join(', ');
    const scopedIds = file.startsWith('src/modules/permissions/')
      ? [...SRC, 'no-param-id-string', 'no-identity-cache', 'no-identity-timer']
      : SRC;
    return {
      name: `srvf/harness:is-optional-null-baseline:${file}`,
      files: [file],
      rules: {
        'no-restricted-syntax': [
          'error',
          ...scopedIds.filter((id) => id !== 'no-nullable-is-optional').map((id) => HARNESS_SYNTAX[id]),
          {
            selector: `${IS_OPTIONAL_NULL_SELECTOR}:not(${exemptions})`,
            message: HARNESS_SYNTAX['no-nullable-is-optional'].message,
          },
        ],
      },
    };
  },
);

harnessConfigBlocks.push(...isOptionalNullBaselineBlocks);

export { HARNESS_SYNTAX, IS_OPTIONAL_NULL_BASELINE, IS_OPTIONAL_NULL_SELECTOR, harnessConfigBlocks };
