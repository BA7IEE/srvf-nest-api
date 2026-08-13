// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// surface: System 系统面
// generatorVersion: 1.0.0
// inputDigest: sha256:d88934361521b2775cd66626de6a4a9575dde99901851316d61e366668a57acb
//
// ⚠️ 本文件**只有类型与调用签名**:不含 baseURL、不含令牌、不含任何鉴权逻辑。
//    登录态怎么带、令牌怎么刷新,由消费方在注入的 Fetcher 里自理
//    (登录/刷新的三步接线见 docs/handoff/admin-web.md §3.1)。

import type {
  ApiEnvelope,
  PageResult,
  FetchRequest,
  Fetcher,
  AssignRolePermissionsDto,
  AssignUserRoleDto,
  AttachmentMimeConfigResponseDto,
  AttachmentMimeConfigTypeConfigSummaryDto,
  AttachmentSizeLimitConfigResponseDto,
  AttachmentSizeLimitConfigTypeConfigSummaryDto,
  AttachmentTypeConfigResponseDto,
  AuditContextDto,
  AuditLogResponseDto,
  ContributionRuleResponseDto,
  CreateAttachmentMimeConfigDto,
  CreateAttachmentSizeLimitConfigDto,
  CreateAttachmentTypeConfigDto,
  CreateContributionRuleDto,
  CreateDictItemDto,
  CreateDictTypeDto,
  CreatePermissionDto,
  CreateRbacRoleDto,
  DictItemResponseDto,
  DictItemTreeNodeDto,
  DictTypeResponseDto,
  EffectivePermissionsResponseDto,
  EffectiveRoleDto,
  HealthResponseDto,
  MyPermissionsResponseDto,
  PageResultDto,
  PermissionResponseDto,
  RbacRoleDetailResponseDto,
  RbacRoleResponseDto,
  RealnameSettingsResponseDto,
  ReloadRbacDto,
  ReloadRbacResponseDto,
  ResetRealnameCredentialsDto,
  ResetSmsCredentialsDto,
  ResetStorageCredentialsDto,
  ResetWechatCredentialsDto,
  ResetWecomCredentialsDto,
  RoleOptionItemDto,
  RoleOptionsResponseDto,
  SmsSendLogResponseDto,
  SmsSettingsResponseDto,
  StorageSettingsResponseDto,
  UpdateAttachmentMimeConfigDto,
  UpdateAttachmentMimeConfigStatusDto,
  UpdateAttachmentSizeLimitConfigDto,
  UpdateAttachmentTypeConfigDto,
  UpdateAttachmentTypeConfigStatusDto,
  UpdateContributionRuleDto,
  UpdateDictItemDto,
  UpdateDictItemStatusDto,
  UpdateDictTypeDto,
  UpdateDictTypeStatusDto,
  UpdatePermissionDto,
  UpdateRbacRoleDto,
  UpdateRealnameSettingsDto,
  UpdateSmsSettingsDto,
  UpdateStorageSettingsDto,
  UpdateWechatSettingsDto,
  UpdateWecomSettingsDto,
  UserRoleResponseDto,
  WechatSettingsResponseDto,
  WecomSettingsResponseDto,
  WecomTestConnectionResponseDto,
  WecomVisibilitySummaryDto,
} from './types';

export type { ApiEnvelope, PageResult, FetchRequest, Fetcher };

export function createSystemClient(fetcher: Fetcher) {
  return {
    /** 列出附件 MIME 配置(分页;可选 typeConfigId / status / mime 过滤;默认排序 createdAt DESC) [rbac: attachment-config.read.mime] */
    AttachmentMimeConfigsControllerList(query?: { "page"?: number; "pageSize"?: number; "typeConfigId"?: string; "status"?: "ACTIVE" | "INACTIVE"; "mime"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AttachmentMimeConfigResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": AttachmentMimeConfigResponseDto[] }>({ method: "GET", path: "/api/system/v1/attachment-mime-configs", query });
    },
    /** 创建附件 MIME 配置(typeConfigId 不存在 → 13020;mime 格式不合法 → 13025;(typeConfigId, mime) 重复 → 13024;含软删历史) [rbac: attachment-config.create.mime] */
    AttachmentMimeConfigsControllerCreate(body: CreateAttachmentMimeConfigDto): Promise<ApiEnvelope<AttachmentMimeConfigResponseDto>> {
      return fetcher<AttachmentMimeConfigResponseDto>({ method: "POST", path: "/api/system/v1/attachment-mime-configs", body });
    },
    /** 附件 MIME 配置详情(不存在 / 已软删统一返 13022) [rbac: attachment-config.read.mime] */
    AttachmentMimeConfigsControllerGetById(id: string): Promise<ApiEnvelope<AttachmentMimeConfigResponseDto>> {
      return fetcher<AttachmentMimeConfigResponseDto>({ method: "GET", path: `/api/system/v1/attachment-mime-configs/${id}` });
    },
    /** 更新附件 MIME 配置(仅 remark;**禁止** mime(Q3 v1.0)/ typeConfigId(Q4 v1.0)/ status / deletedAt / id) [rbac: attachment-config.update.mime] */
    AttachmentMimeConfigsControllerUpdate(id: string, body: UpdateAttachmentMimeConfigDto): Promise<ApiEnvelope<AttachmentMimeConfigResponseDto>> {
      return fetcher<AttachmentMimeConfigResponseDto>({ method: "PATCH", path: `/api/system/v1/attachment-mime-configs/${id}`, body });
    },
    /** 软删附件 MIME 配置(deletedAt = now() + 同步置 status=INACTIVE;V2.x Slow-6:仍被附件引用时返 13031) [rbac: attachment-config.delete.mime] */
    AttachmentMimeConfigsControllerSoftDelete(id: string): Promise<ApiEnvelope<AttachmentMimeConfigResponseDto>> {
      return fetcher<AttachmentMimeConfigResponseDto>({ method: "DELETE", path: `/api/system/v1/attachment-mime-configs/${id}` });
    },
    /** 更新附件 MIME 配置启停状态(沿 PR #3 type config status 端点范式;V2.x Slow-6:ACTIVE → INACTIVE 仍被附件引用时返 13031) [rbac: attachment-config.update.mime] */
    AttachmentMimeConfigsControllerUpdateStatus(id: string, body: UpdateAttachmentMimeConfigStatusDto): Promise<ApiEnvelope<AttachmentMimeConfigResponseDto>> {
      return fetcher<AttachmentMimeConfigResponseDto>({ method: "PATCH", path: `/api/system/v1/attachment-mime-configs/${id}/status`, body });
    },
    /** 列出附件尺寸限制配置(分页;可选 typeConfigId 过滤;默认排序 createdAt DESC) [rbac: attachment-config.read.size-limit] */
    AttachmentSizeLimitConfigsControllerList(query?: { "page"?: number; "pageSize"?: number; "typeConfigId"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AttachmentSizeLimitConfigResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": AttachmentSizeLimitConfigResponseDto[] }>({ method: "GET", path: "/api/system/v1/attachment-size-limit-configs", query });
    },
    /** 创建附件尺寸限制配置(1:1 与 typeConfig;typeConfigId 不存在 → 13020;重复 → 13027;含软删历史) [rbac: attachment-config.create.size-limit] */
    AttachmentSizeLimitConfigsControllerCreate(body: CreateAttachmentSizeLimitConfigDto): Promise<ApiEnvelope<AttachmentSizeLimitConfigResponseDto>> {
      return fetcher<AttachmentSizeLimitConfigResponseDto>({ method: "POST", path: "/api/system/v1/attachment-size-limit-configs", body });
    },
    /** 附件尺寸限制配置详情(不存在 / 已软删统一返 13026) [rbac: attachment-config.read.size-limit] */
    AttachmentSizeLimitConfigsControllerGetById(id: string): Promise<ApiEnvelope<AttachmentSizeLimitConfigResponseDto>> {
      return fetcher<AttachmentSizeLimitConfigResponseDto>({ method: "GET", path: `/api/system/v1/attachment-size-limit-configs/${id}` });
    },
    /** 更新附件尺寸限制配置(仅 maxSizeBytes / remark;**禁止** typeConfigId(Q4 PR #4)/ deletedAt / id;Q5 v1.0:maxSizeBytes 不允许 null) [rbac: attachment-config.update.size-limit] */
    AttachmentSizeLimitConfigsControllerUpdate(id: string, body: UpdateAttachmentSizeLimitConfigDto): Promise<ApiEnvelope<AttachmentSizeLimitConfigResponseDto>> {
      return fetcher<AttachmentSizeLimitConfigResponseDto>({ method: "PATCH", path: `/api/system/v1/attachment-size-limit-configs/${id}`, body });
    },
    /** 软删附件尺寸限制配置(deletedAt = now();本表无 status 字段不需要同步置;V2.x Slow-6:同 type 仍被附件引用时返 13032) [rbac: attachment-config.delete.size-limit] */
    AttachmentSizeLimitConfigsControllerSoftDelete(id: string): Promise<ApiEnvelope<AttachmentSizeLimitConfigResponseDto>> {
      return fetcher<AttachmentSizeLimitConfigResponseDto>({ method: "DELETE", path: `/api/system/v1/attachment-size-limit-configs/${id}` });
    },
    /** 列出附件类型配置(分页;可选 status / ownerTable 过滤;默认排序 createdAt DESC) [rbac: attachment-config.read.type] */
    AttachmentTypeConfigsControllerList(query?: { "page"?: number; "pageSize"?: number; "status"?: "ACTIVE" | "INACTIVE"; "ownerTable"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AttachmentTypeConfigResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": AttachmentTypeConfigResponseDto[] }>({ method: "GET", path: "/api/system/v1/attachment-type-configs", query });
    },
    /** 创建附件类型配置(code 全局唯一 / kebab-case 3-32;失败抛 13023 / 13021;status 默认 ACTIVE) [rbac: attachment-config.create.type] */
    AttachmentTypeConfigsControllerCreate(body: CreateAttachmentTypeConfigDto): Promise<ApiEnvelope<AttachmentTypeConfigResponseDto>> {
      return fetcher<AttachmentTypeConfigResponseDto>({ method: "POST", path: "/api/system/v1/attachment-type-configs", body });
    },
    /** 附件类型配置详情(不存在 / 已软删统一返 13020) [rbac: attachment-config.read.type] */
    AttachmentTypeConfigsControllerGetById(id: string): Promise<ApiEnvelope<AttachmentTypeConfigResponseDto>> {
      return fetcher<AttachmentTypeConfigResponseDto>({ method: "GET", path: `/api/system/v1/attachment-type-configs/${id}` });
    },
    /** 更新附件类型配置(仅 displayName / description / ownerTable / defaultMaxSizeBytes / defaultMimeWhitelist;**禁止** code / status / deletedAt / id) [rbac: attachment-config.update.type] */
    AttachmentTypeConfigsControllerUpdate(id: string, body: UpdateAttachmentTypeConfigDto): Promise<ApiEnvelope<AttachmentTypeConfigResponseDto>> {
      return fetcher<AttachmentTypeConfigResponseDto>({ method: "PATCH", path: `/api/system/v1/attachment-type-configs/${id}`, body });
    },
    /** 软删附件类型配置(deletedAt = now() + 同步置 status=INACTIVE;V2.x Slow-6:仍被附件引用时返 13030) [rbac: attachment-config.delete.type] */
    AttachmentTypeConfigsControllerSoftDelete(id: string): Promise<ApiEnvelope<AttachmentTypeConfigResponseDto>> {
      return fetcher<AttachmentTypeConfigResponseDto>({ method: "DELETE", path: `/api/system/v1/attachment-type-configs/${id}` });
    },
    /** 更新附件类型配置启停状态(沿 dictionaries 独立 status 端点范式;V2.x Slow-6:ACTIVE → INACTIVE 仍被附件引用时返 13030) [rbac: attachment-config.update.type] */
    AttachmentTypeConfigsControllerUpdateStatus(id: string, body: UpdateAttachmentTypeConfigStatusDto): Promise<ApiEnvelope<AttachmentTypeConfigResponseDto>> {
      return fetcher<AttachmentTypeConfigResponseDto>({ method: "PATCH", path: `/api/system/v1/attachment-type-configs/${id}/status`, body });
    },
    /** 列出审计记录(分页 + 过滤 resourceType / resourceId / event / actorUserId / startDate / endDate;SUPER_ADMIN 可读取全部;其他持有 audit-log.read.entry 的账号仅能读取本人或 USER 操作的记录;稳定排序 createdAt desc + id desc) [rbac: audit-log.read.entry] */
    AuditLogsControllerList(query?: { "page"?: number; "pageSize"?: number; "resourceType"?: string; "resourceId"?: string; "event"?: string; "actorUserId"?: string; "startDate"?: string; "endDate"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AuditLogResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": AuditLogResponseDto[] }>({ method: "GET", path: "/api/system/v1/audit-logs", query });
    },
    /** 审计记录详情(SUPER_ADMIN 可读取全部;其他持有 audit-log.read.entry 的账号仅能读取本人或 USER 操作的记录;超出范围 → 14101;不存在 → 14001;无 update / delete 接口) [rbac: audit-log.read.entry] */
    AuditLogsControllerFindOne(id: string): Promise<ApiEnvelope<AuditLogResponseDto>> {
      return fetcher<AuditLogResponseDto>({ method: "GET", path: `/api/system/v1/audit-logs/${id}` });
    },
    /** 查当前用户三源授权合并后的有效权限码(直接绑定 + 职务策略 + 分管;SUPER_ADMIN 返全集) [auth] */
    EffectivePermissionsControllerGetEffectivePermissions(): Promise<ApiEnvelope<EffectivePermissionsResponseDto>> {
      return fetcher<EffectivePermissionsResponseDto>({ method: "GET", path: "/api/system/v1/authz/me/effective-permissions" });
    },
    /** 列出贡献值规则(分页 + 过滤 activityTypeCode / attendanceRoleCode / status;沿基础稳定排序) [rbac: contribution.read.rule] */
    ContributionRulesControllerList(query?: { "page"?: number; "pageSize"?: number; "activityTypeCode"?: string; "attendanceRoleCode"?: string; "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<PageResultDto & { "items": ContributionRuleResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": ContributionRuleResponseDto[] }>({ method: "GET", path: "/api/system/v1/contribution-rules", query });
    },
    /** 创建贡献值规则(字典校验 + 字段语义 + ACTIVE 唯一性兜底含 NULL durationThreshold) [rbac: contribution.create.rule] */
    ContributionRulesControllerCreate(body: CreateContributionRuleDto): Promise<ApiEnvelope<ContributionRuleResponseDto>> {
      return fetcher<ContributionRuleResponseDto>({ method: "POST", path: "/api/system/v1/contribution-rules", body });
    },
    /** 贡献值规则详情(含软删返 404) [rbac: contribution.read.rule] */
    ContributionRulesControllerFindOne(id: string): Promise<ApiEnvelope<ContributionRuleResponseDto>> {
      return fetcher<ContributionRuleResponseDto>({ method: "GET", path: `/api/system/v1/contribution-rules/${id}` });
    },
    /** 部分更新贡献值规则(白名单仅 pointsBelow / pointsAbove / status / remark;禁改 activityTypeCode / attendanceRoleCode / durationThreshold,由 ValidationPipe 拦截抛 40000) [rbac: contribution.update.rule] */
    ContributionRulesControllerUpdate(id: string, body: UpdateContributionRuleDto): Promise<ApiEnvelope<ContributionRuleResponseDto>> {
      return fetcher<ContributionRuleResponseDto>({ method: "PATCH", path: `/api/system/v1/contribution-rules/${id}`, body });
    },
    /** 软删贡献值规则(写 deletedAt + deletedByUserId;不强制改 status;删完该维度 attendance 预填走 22048 不抛错路径) [rbac: contribution.delete.rule] */
    ContributionRulesControllerSoftDelete(id: string): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "DELETE", path: `/api/system/v1/contribution-rules/${id}` });
    },
    /** 列出字典项(分页;typeId 必填) [rbac: dict.read.item] */
    DictItemsControllerList(query: { "page"?: number; "pageSize"?: number; "typeId": string; "parentId"?: string; "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<PageResultDto & { "items": DictItemResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": DictItemResponseDto[] }>({ method: "GET", path: "/api/system/v1/dict-items", query });
    },
    /** 创建字典项 [rbac: dict.create.item] */
    DictItemsControllerCreate(body: CreateDictItemDto): Promise<ApiEnvelope<DictItemResponseDto>> {
      return fetcher<DictItemResponseDto>({ method: "POST", path: "/api/system/v1/dict-items", body });
    },
    /** 字典项树形(按 typeId 过滤;深度无限制) [rbac: dict.read.item] */
    DictItemsControllerTree(query: { "typeId": string; "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<DictItemTreeNodeDto[]>> {
      return fetcher<DictItemTreeNodeDto[]>({ method: "GET", path: "/api/system/v1/dict-items/tree", query });
    },
    /** 字典项详情 [rbac: dict.read.item] */
    DictItemsControllerFindOne(id: string): Promise<ApiEnvelope<DictItemResponseDto>> {
      return fetcher<DictItemResponseDto>({ method: "GET", path: `/api/system/v1/dict-items/${id}` });
    },
    /** 更新字典项(label / sortOrder;禁止改 typeId / code / parentId) [rbac: dict.update.item] */
    DictItemsControllerUpdate(id: string, body: UpdateDictItemDto): Promise<ApiEnvelope<DictItemResponseDto>> {
      return fetcher<DictItemResponseDto>({ method: "PATCH", path: `/api/system/v1/dict-items/${id}`, body });
    },
    /** 软删字典项(P0-F PR-2A D3=A 放宽:ops-admin 可调;闭集 / 国标 / 队内内置类型下的项拒删;有子节点 / organizations / members 引用则拒绝) [rbac: dict.delete.item] */
    DictItemsControllerSoftDelete(id: string): Promise<ApiEnvelope<DictItemResponseDto>> {
      return fetcher<DictItemResponseDto>({ method: "DELETE", path: `/api/system/v1/dict-items/${id}` });
    },
    /** 启停字典项(只改 status) [rbac: dict.update.item] */
    DictItemsControllerUpdateStatus(id: string, body: UpdateDictItemStatusDto): Promise<ApiEnvelope<DictItemResponseDto>> {
      return fetcher<DictItemResponseDto>({ method: "PATCH", path: `/api/system/v1/dict-items/${id}/status`, body });
    },
    /** 列出字典类型(分页) [rbac: dict.read.type] */
    DictTypesControllerList(query?: { "page"?: number; "pageSize"?: number; "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<PageResultDto & { "items": DictTypeResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": DictTypeResponseDto[] }>({ method: "GET", path: "/api/system/v1/dict-types", query });
    },
    /** 创建字典类型 [rbac: dict.create.type] */
    DictTypesControllerCreate(body: CreateDictTypeDto): Promise<ApiEnvelope<DictTypeResponseDto>> {
      return fetcher<DictTypeResponseDto>({ method: "POST", path: "/api/system/v1/dict-types", body });
    },
    /** 字典类型详情 [rbac: dict.read.type] */
    DictTypesControllerFindOne(id: string): Promise<ApiEnvelope<DictTypeResponseDto>> {
      return fetcher<DictTypeResponseDto>({ method: "GET", path: `/api/system/v1/dict-types/${id}` });
    },
    /** 更新字典类型(label / sortOrder;禁止改 code) [rbac: dict.update.type] */
    DictTypesControllerUpdate(id: string, body: UpdateDictTypeDto): Promise<ApiEnvelope<DictTypeResponseDto>> {
      return fetcher<DictTypeResponseDto>({ method: "PATCH", path: `/api/system/v1/dict-types/${id}`, body });
    },
    /** 软删字典类型(P0-F PR-2A D3=A 放宽:ops-admin 可调;系统内置类型拒删;有 dict_items / organizations / members 引用则拒绝) [rbac: dict.delete.type] */
    DictTypesControllerSoftDelete(id: string): Promise<ApiEnvelope<DictTypeResponseDto>> {
      return fetcher<DictTypeResponseDto>({ method: "DELETE", path: `/api/system/v1/dict-types/${id}` });
    },
    /** 启停字典类型(只改 status) [rbac: dict.update.type] */
    DictTypesControllerUpdateStatus(id: string, body: UpdateDictTypeStatusDto): Promise<ApiEnvelope<DictTypeResponseDto>> {
      return fetcher<DictTypeResponseDto>({ method: "PATCH", path: `/api/system/v1/dict-types/${id}/status`, body });
    },
    /** 服务健康检查(根端点,实现等同 /api/system/v1/health/live) [public] */
    HealthControllerCheck(): Promise<ApiEnvelope<HealthResponseDto>> {
      return fetcher<HealthResponseDto>({ method: "GET", path: "/api/system/v1/health" });
    },
    /** 存活探针(K8s liveness)— 仅证明进程在跑,不查外部依赖 [public] */
    HealthControllerLive(): Promise<ApiEnvelope<HealthResponseDto>> {
      return fetcher<HealthResponseDto>({ method: "GET", path: "/api/system/v1/health/live" });
    },
    /** 就绪探针(K8s readiness)— 含数据库连通检查;DB 不可用时 HTTP 500 + code 50000 [public] */
    HealthControllerReady(): Promise<ApiEnvelope<HealthResponseDto>> {
      return fetcher<HealthResponseDto>({ method: "GET", path: "/api/system/v1/health/ready" });
    },
    /** 列出权限点(分页;按 module / resourceType 过滤) [rbac: rbac.permission.read] */
    PermissionsControllerList(query?: { "page"?: number; "pageSize"?: number; "module"?: string; "resourceType"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": PermissionResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": PermissionResponseDto[] }>({ method: "GET", path: "/api/system/v1/permissions", query });
    },
    /** 创建权限点(code 格式 <module>.<action>.<resource_type>;失败抛 30008) [rbac: rbac.permission.create] */
    PermissionsControllerCreate(body: CreatePermissionDto): Promise<ApiEnvelope<PermissionResponseDto>> {
      return fetcher<PermissionResponseDto>({ method: "POST", path: "/api/system/v1/permissions", body });
    },
    /** 更新权限点(仅 description;code / module / action / resourceType 不可改) [rbac: rbac.permission.update] */
    PermissionsControllerUpdate(id: string, body: UpdatePermissionDto): Promise<ApiEnvelope<PermissionResponseDto>> {
      return fetcher<PermissionResponseDto>({ method: "PATCH", path: `/api/system/v1/permissions/${id}`, body });
    },
    /** 物理删除权限点(D4 v1.0;RolePermission FK Cascade 自动联级清理) [rbac: rbac.permission.delete] */
    PermissionsControllerDelete(id: string): Promise<ApiEnvelope<PermissionResponseDto>> {
      return fetcher<PermissionResponseDto>({ method: "DELETE", path: `/api/system/v1/permissions/${id}` });
    },
    /** 查当前用户的有效权限点集 + 业务角色摘要(SUPER_ADMIN 返 Permission.code 全集;沿 D7 v1.1 §5.3) [auth] */
    RbacControllerGetMyPermissions(): Promise<ApiEnvelope<MyPermissionsResponseDto>> {
      return fetcher<MyPermissionsResponseDto>({ method: "GET", path: "/api/system/v1/rbac/me/permissions" });
    },
    /** 兼容校验 RBAC reload 三档请求(当前无跨请求缓存,无内部状态变更) [rbac: rbac.config.reload] */
    RbacControllerReload(body: ReloadRbacDto): Promise<ApiEnvelope<ReloadRbacResponseDto>> {
      return fetcher<ReloadRbacResponseDto>({ method: "POST", path: "/api/system/v1/rbac/reload", body });
    },
    /** 读 Realname Verification Settings singleton row(不存在返 data=null;不抛 BizCode;不回显凭证) [rbac: realname-setting.read.singleton] */
    RealnameSettingsControllerGet(): Promise<ApiEnvelope<RealnameSettingsResponseDto>> {
      return fetcher<RealnameSettingsResponseDto>({ method: "GET", path: "/api/system/v1/realname-settings" });
    },
    /** upsert 更新实名核验设置(不存在则创建 default providerType=DEV_STUB;production-like 拒绝 DEV_STUB;**拒绝**任何凭证字段;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: realname-setting.update.singleton] */
    RealnameSettingsControllerUpdate(body: UpdateRealnameSettingsDto): Promise<ApiEnvelope<RealnameSettingsResponseDto>> {
      return fetcher<RealnameSettingsResponseDto>({ method: "PATCH", path: "/api/system/v1/realname-settings", body });
    },
    /** 重置腾讯云实名核验 secretId/secretKey(**仅 SUPER_ADMIN 短路通过**,码不绑 ops-admin;两段 AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=TENCENT_CLOUD;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: realname-setting.reset.credentials] */
    RealnameSettingsControllerResetCredentials(body: ResetRealnameCredentialsDto): Promise<ApiEnvelope<RealnameSettingsResponseDto>> {
      return fetcher<RealnameSettingsResponseDto>({ method: "POST", path: "/api/system/v1/realname-settings/reset-credentials", body });
    },
    /** 列出角色(分页;按 code 模糊过滤;排除已软删) [rbac: rbac.role.read] */
    RbacRolesControllerList(query?: { "page"?: number; "pageSize"?: number; "code"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": RbacRoleResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": RbacRoleResponseDto[] }>({ method: "GET", path: "/api/system/v1/roles", query });
    },
    /** 创建角色(code 格式 kebab-case 3-32 字符;失败抛 30009;含软删历史撞唯一抛 30004) [rbac: rbac.role.create] */
    RbacRolesControllerCreate(body: CreateRbacRoleDto): Promise<ApiEnvelope<RbacRoleResponseDto>> {
      return fetcher<RbacRoleResponseDto>({ method: "POST", path: "/api/system/v1/roles", body });
    },
    /** 角色选择器投影(q 模糊 code+displayName;limit≤100,默认 20) [rbac: rbac.role.read] */
    RbacRolesControllerOptions(query?: { "q"?: string; "limit"?: number }): Promise<ApiEnvelope<RoleOptionsResponseDto>> {
      return fetcher<RoleOptionsResponseDto>({ method: "GET", path: "/api/system/v1/roles/options", query });
    },
    /** 角色详情(含已分配 permissions 数组;不存在返 30003 / 已软删返 30005) [rbac: rbac.role.read] */
    RbacRolesControllerFindOne(id: string): Promise<ApiEnvelope<RbacRoleDetailResponseDto>> {
      return fetcher<RbacRoleDetailResponseDto>({ method: "GET", path: `/api/system/v1/roles/${id}` });
    },
    /** 更新角色(仅 displayName / description;code 不可改;不存在或已软删返 30003) [rbac: rbac.role.update] */
    RbacRolesControllerUpdate(id: string, body: UpdateRbacRoleDto): Promise<ApiEnvelope<RbacRoleResponseDto>> {
      return fetcher<RbacRoleResponseDto>({ method: "PATCH", path: `/api/system/v1/roles/${id}`, body });
    },
    /** 软删角色(D4 v1.0;update deletedAt;user_roles / role_permissions 不联动;不存在或已软删返 30003) [rbac: rbac.role.delete] */
    RbacRolesControllerDelete(id: string): Promise<ApiEnvelope<RbacRoleResponseDto>> {
      return fetcher<RbacRoleResponseDto>({ method: "DELETE", path: `/api/system/v1/roles/${id}` });
    },
    /** 批量给角色加权限点(幂等:已存在的 (roleId, permissionId) 静默跳过;入参 permissionCodes[],非 ids;SA-only 保留码仅 SUPER_ADMIN 可分配,否则 30103) [rbac: rbac.role-permission.create] */
    RolePermissionsControllerAssign(id: string, body: AssignRolePermissionsDto): Promise<ApiEnvelope<RbacRoleDetailResponseDto>> {
      return fetcher<RbacRoleDetailResponseDto>({ method: "POST", path: `/api/system/v1/roles/${id}/permissions`, body });
    },
    /** 撤销角色的某个权限点(精确路径 :permissionId 是 permission.id 非 code;关系不存在返 30011) [rbac: rbac.role-permission.delete] */
    RolePermissionsControllerRevoke(id: string, permissionId: string): Promise<ApiEnvelope<RbacRoleDetailResponseDto>> {
      return fetcher<RbacRoleDetailResponseDto>({ method: "DELETE", path: `/api/system/v1/roles/${id}/permissions/${permissionId}` });
    },
    /** 分页查询短信发送日志(只读;响应手机号一律掩码 138****1234;可选 status / phone 精确过滤) [rbac: sms-send-log.read.list] */
    SmsSendLogsControllerList(query?: { "page"?: number; "pageSize"?: number; "status"?: "SENT" | "FAILED"; "phone"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": SmsSendLogResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": SmsSendLogResponseDto[] }>({ method: "GET", path: "/api/system/v1/sms-send-logs", query });
    },
    /** 读 SMS Settings singleton row(不存在返 data=null;不抛 BizCode;不回显凭证) [rbac: sms-setting.read.singleton] */
    SmsSettingsControllerGet(): Promise<ApiEnvelope<SmsSettingsResponseDto>> {
      return fetcher<SmsSettingsResponseDto>({ method: "GET", path: "/api/system/v1/sms-settings" });
    },
    /** upsert 更新 SMS Settings(不存在则创建 default providerType=DEV_STUB;production-like 拒绝 DEV_STUB;**拒绝**任何凭证字段;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: sms-setting.update.singleton] */
    SmsSettingsControllerUpdate(body: UpdateSmsSettingsDto): Promise<ApiEnvelope<SmsSettingsResponseDto>> {
      return fetcher<SmsSettingsResponseDto>({ method: "PATCH", path: "/api/system/v1/sms-settings", body });
    },
    /** 重置腾讯云 SecretId / SecretKey(**仅 SUPER_ADMIN 短路通过**,码不绑 ops-admin;AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=TENCENT_SMS;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: sms-setting.reset.credentials] */
    SmsSettingsControllerResetCredentials(body: ResetSmsCredentialsDto): Promise<ApiEnvelope<SmsSettingsResponseDto>> {
      return fetcher<SmsSettingsResponseDto>({ method: "POST", path: "/api/system/v1/sms-settings/reset-credentials", body });
    },
    /** 读 Storage Settings singleton row(沿 Q-11-1:不存在返 data=null;不抛 BizCode;不回显凭证) [rbac: storage-setting.read.singleton] */
    StorageSettingsControllerGet(): Promise<ApiEnvelope<StorageSettingsResponseDto>> {
      return fetcher<StorageSettingsResponseDto>({ method: "GET", path: "/api/system/v1/storage-settings" });
    },
    /** upsert 更新 Storage Settings(沿 Q-11-1 + Q-11-17:不存在则创建 default;providerType 缺省 LOCAL;**拒绝**任何凭证字段;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: storage-setting.update.singleton] */
    StorageSettingsControllerUpdate(body: UpdateStorageSettingsDto): Promise<ApiEnvelope<StorageSettingsResponseDto>> {
      return fetcher<StorageSettingsResponseDto>({ method: "PATCH", path: "/api/system/v1/storage-settings", body });
    },
    /** 重置 SecretId / SecretKey(沿 §6.6.2 / Q-11-1 / Q-11-5 + P0-F PR-2B D2=A:**仅 SUPER_ADMIN 短路通过**;ADMIN+ops-admin 调用 → 30100;AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=COS;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: storage-setting.reset.credentials] */
    StorageSettingsControllerResetCredentials(body: ResetStorageCredentialsDto): Promise<ApiEnvelope<StorageSettingsResponseDto>> {
      return fetcher<StorageSettingsResponseDto>({ method: "POST", path: "/api/system/v1/storage-settings/reset-credentials", body });
    },
    /** 查用户角色列表(排除已软删 RBAC 角色) [rbac: rbac.user-role.read] */
    UserRolesControllerList(userId: string): Promise<ApiEnvelope<UserRoleResponseDto[]>> {
      return fetcher<UserRoleResponseDto[]>({ method: "GET", path: `/api/system/v1/users/${userId}/roles` });
    },
    /** 给用户分配角色(入参 roleCode;Q7 角色分级 C2 中庸:SUPER_ADMIN 通过任何 / 持 ops-admin 通过非 ops-admin / 其他 30102;重复分配 30006) [rbac: rbac.user-role.create] */
    UserRolesControllerAssign(userId: string, body: AssignUserRoleDto): Promise<ApiEnvelope<UserRoleResponseDto>> {
      return fetcher<UserRoleResponseDto>({ method: "POST", path: `/api/system/v1/users/${userId}/roles`, body });
    },
    /** 撤销用户角色(路径 :roleId 是 RbacRole.id;Q7 角色分级判定;撤 ops-admin 时事务内"最后一个 ops-admin 保护"30101;关系不存在 30007) [rbac: rbac.user-role.delete] */
    UserRolesControllerRevoke(userId: string, roleId: string): Promise<ApiEnvelope<UserRoleResponseDto>> {
      return fetcher<UserRoleResponseDto>({ method: "DELETE", path: `/api/system/v1/users/${userId}/roles/${roleId}` });
    },
    /** 读 WeChat Settings singleton row(不存在返 data=null;不抛 BizCode;不回显凭证) [rbac: wechat-setting.read.singleton] */
    WechatSettingsControllerGet(): Promise<ApiEnvelope<WechatSettingsResponseDto>> {
      return fetcher<WechatSettingsResponseDto>({ method: "GET", path: "/api/system/v1/wechat-settings" });
    },
    /** upsert 更新 WeChat Settings(不存在则创建 default providerType=DEV_STUB;production-like 拒绝 DEV_STUB;**拒绝**任何凭证字段;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: wechat-setting.update.singleton] */
    WechatSettingsControllerUpdate(body: UpdateWechatSettingsDto): Promise<ApiEnvelope<WechatSettingsResponseDto>> {
      return fetcher<WechatSettingsResponseDto>({ method: "PATCH", path: "/api/system/v1/wechat-settings", body });
    },
    /** 重置微信小程序 AppSecret(**仅 SUPER_ADMIN 短路通过**,码不绑 ops-admin;AES-256-GCM 加密落库;响应不回显;不存在则 upsert 创建 default providerType=WECHAT;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: wechat-setting.reset.credentials] */
    WechatSettingsControllerResetCredentials(body: ResetWechatCredentialsDto): Promise<ApiEnvelope<WechatSettingsResponseDto>> {
      return fetcher<WechatSettingsResponseDto>({ method: "POST", path: "/api/system/v1/wechat-settings/reset-credentials", body });
    },
    /** 读 WeCom Settings singleton row(不存在返 data=null;不抛 BizCode;不回显凭证,corpId 仅掩码) [rbac: wecom-setting.read.singleton] */
    WecomSettingsControllerGet(): Promise<ApiEnvelope<WecomSettingsResponseDto>> {
      return fetcher<WecomSettingsResponseDto>({ method: "GET", path: "/api/system/v1/wecom-settings" });
    },
    /** upsert 更新 WeCom Settings(不存在则创建 default providerType=DEV_STUB;production-like 拒绝 DEV_STUB;loginEnabled/messageEnabled=true 必须 enabled=true;webBaseUrl 仅 origin 且 production 必须 HTTPS;corpId 仅在 active identity=0 时可改否则 36020;**拒绝**任何凭证字段;事务提交后任一实例下一次调用直读 PostgreSQL 新值,无需 invalidate/reload/restart) [rbac: wecom-setting.update.singleton] */
    WecomSettingsControllerUpdate(body: UpdateWecomSettingsDto): Promise<ApiEnvelope<WecomSettingsResponseDto>> {
      return fetcher<WecomSettingsResponseDto>({ method: "PATCH", path: "/api/system/v1/wecom-settings", body });
    },
    /** 重置企业微信 CorpSecret(**仅 SUPER_ADMIN 短路通过**,码不绑 ops-admin;AES-256-GCM 加密落库,独立 WECOM_ENCRYPTION_KEY 与小程序不共域;响应不回显;audit 不含任何凭证字段名或值;不存在则 upsert 创建 default providerType=WECOM) [rbac: wecom-setting.reset.credentials] */
    WecomSettingsControllerResetCredentials(body: ResetWecomCredentialsDto): Promise<ApiEnvelope<WecomSettingsResponseDto>> {
      return fetcher<WecomSettingsResponseDto>({ method: "POST", path: "/api/system/v1/wecom-settings/reset-credentials", body });
    },
    /** 企业微信连接诊断(强制跳过 token 缓存取新 access_token → agent/get 核对 agentid 与 close;**不发消息、不读完整通讯录、不改身份**;可见范围**只返计数不返任何成员/部门/标签 ID**;只读诊断不写 audit;失败 36030/36031 且不回显上游 URL/token/Secret/完整 errmsg) [rbac: wecom-setting.test.connection] */
    WecomSettingsControllerTestConnection(): Promise<ApiEnvelope<WecomTestConnectionResponseDto>> {
      return fetcher<WecomTestConnectionResponseDto>({ method: "POST", path: "/api/system/v1/wecom-settings/test-connection" });
    },
  };
}
