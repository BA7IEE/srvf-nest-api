// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// 真相源:后端 live /api/docs-json;本文件派生自 docs/handoff/openapi.json 快照。
// surface: System 系统面
// contractVersion: 0.69.0
// generatorVersion: 1.0.0
// inputDigest: sha256:97f62261ea00cbe38e101371ba40c787dfaa40a523e289a00aaca51ceb9573b2

// 共用类型不在本文件重复定义 —— 从 shared 引入并再导出,保证仓内每个类型只有一份定义。
import type { ApiEnvelope, PageResult, FetchRequest, Fetcher, PageResultDto } from '../shared/types';
export type { ApiEnvelope, PageResult, FetchRequest, Fetcher, PageResultDto };

export interface AssignUserRoleDto {
  "roleCode": string;
}

export interface AttachmentMimeConfigResponseDto {
  "id": string;
  "typeConfigId": string;
  "mime": string;
  "status": "ACTIVE" | "INACTIVE";
  "remark"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
  "typeConfig": AttachmentMimeConfigTypeConfigSummaryDto;
}

export interface AttachmentMimeConfigTypeConfigSummaryDto {
  "id": string;
  "code": string;
  "displayName": string;
}

export interface AttachmentSizeLimitConfigResponseDto {
  "id": string;
  "typeConfigId": string;
  "maxSizeBytes": number;
  "remark"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
  "typeConfig": AttachmentSizeLimitConfigTypeConfigSummaryDto;
}

export interface AttachmentSizeLimitConfigTypeConfigSummaryDto {
  "id": string;
  "code": string;
  "displayName": string;
}

export interface AttachmentTypeConfigResponseDto {
  "id": string;
  "code": string;
  "displayName": string;
  "description"?: Record<string, unknown> | null;
  "ownerTable": string;
  "defaultMaxSizeBytes"?: Record<string, unknown> | null;
  "defaultMimeWhitelist": string[];
  "status": "ACTIVE" | "INACTIVE";
  "createdAt": string;
  "updatedAt": string;
}

export interface AuditContextDto {
  "requestId": string;
  "ip"?: Record<string, unknown> | null;
  "ua"?: Record<string, unknown> | null;
  "before"?: Record<string, unknown> | null;
  "after"?: Record<string, unknown> | null;
  "extra"?: Record<string, unknown> | null;
}

export interface AuditLogResponseDto {
  "id": string;
  "createdAt": string;
  "actorUserId"?: Record<string, unknown> | null;
  "actorRoleSnap"?: "SUPER_ADMIN" | "ADMIN" | "USER" | null;
  "resourceType": string;
  "resourceId"?: Record<string, unknown> | null;
  "event": string;
  "context": AuditContextDto;
  "success": boolean;
}

export interface ContributionRuleResponseDto {
  "id": string;
  "activityTypeCode": string;
  "attendanceRoleCode": string;
  "durationThreshold"?: number | null;
  "pointsBelow": number;
  "pointsAbove"?: number | null;
  "dailyCap"?: number | null;
  "status": "ACTIVE" | "INACTIVE";
  "remark"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
  "createdByUserId"?: Record<string, unknown> | null;
  "updatedByUserId"?: Record<string, unknown> | null;
}

export interface CreateAttachmentMimeConfigDto {
  "typeConfigId": string;
  "mime": string;
  "remark"?: string;
}

export interface CreateAttachmentSizeLimitConfigDto {
  "typeConfigId": string;
  "maxSizeBytes": number;
  "remark"?: string;
}

export interface CreateAttachmentTypeConfigDto {
  "code": string;
  "displayName": string;
  "description"?: string;
  "ownerTable": string;
  "defaultMaxSizeBytes"?: Record<string, unknown> | null;
  "defaultMimeWhitelist"?: string[];
}

export interface CreateContributionRuleDto {
  "activityTypeCode": string;
  "attendanceRoleCode": string;
  "durationThreshold"?: number | null;
  "pointsBelow": number;
  "pointsAbove"?: number | null;
  "status"?: "ACTIVE" | "INACTIVE";
  "remark"?: string;
}

export interface CreateDictItemDto {
  "typeId": string;
  "code": string;
  "label": string;
  "parentId"?: string;
  "sortOrder"?: number;
}

export interface CreateDictTypeDto {
  "code": string;
  "label": string;
  "sortOrder"?: number;
}

export interface CreatePermissionDto {
  "code": string;
  "module": string;
  "action": string;
  "resourceType": string;
  "description"?: string;
}

export interface CreateRbacRoleDto {
  "code": string;
  "displayName": string;
  "description"?: string;
}

export interface CreateServicePrincipalDto {
  "name": string;
  "description"?: string;
  "ownerOrganizationId"?: string;
}

export interface DictItemResponseDto {
  "id": string;
  "typeId": string;
  "code": string;
  "label": string;
  "parentId"?: Record<string, unknown> | null;
  "sortOrder": number;
  "status": "ACTIVE" | "INACTIVE";
  "createdAt": string;
  "updatedAt": string;
}

export interface DictItemTreeNodeDto {
  "id": string;
  "typeId": string;
  "code": string;
  "label": string;
  "parentId"?: Record<string, unknown> | null;
  "sortOrder": number;
  "status": "ACTIVE" | "INACTIVE";
  "createdAt": string;
  "updatedAt": string;
  "children": DictItemTreeNodeDto[];
}

export interface DictTypeResponseDto {
  "id": string;
  "code": string;
  "label": string;
  "status": "ACTIVE" | "INACTIVE";
  "sortOrder": number;
  "createdAt": string;
  "updatedAt": string;
}

export interface EffectivePermissionsResponseDto {
  "permissions": string[];
}

export interface EffectiveRoleDto {
  "code": string;
  "displayName": string;
}

export interface HealthResponseDto {
  "status": "ok";
  "db"?: "up" | "down";
}

export interface MyPermissionsResponseDto {
  "permissions": string[];
  "effectiveRoles": EffectiveRoleDto[];
}

export interface PermissionCatalogGroupDto {
  "code": string;
  "displayName": string;
  "sortOrder": number;
  "items": PermissionCatalogItemDto[];
}

export interface PermissionCatalogItemDto {
  "code": string;
  "displayName": string;
  "businessDescription": string;
  "module": string;
  "action": string;
  "resourceType": string;
  "sectionCode": string;
  "groupCode": string;
  "sortOrder": number;
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  "riskTags": "READ" | "WRITE" | "DESTRUCTIVE" | "SENSITIVE_DATA" | "ACCOUNT_SECURITY" | "CREDENTIAL" | "CONTROL_PLANE" | "FINAL_APPROVAL" | "MASS_EFFECT" | "LEDGER" | "WORKFLOW_INTERNAL"[];
  "grantPolicy": "CUSTOM_ROLE_ALLOWED" | "SUPER_ADMIN_ONLY" | "ROLE_ALLOWLIST_ONLY" | "SYSTEM_ROLE_ONLY";
  "status": "ACTIVE" | "DEPRECATED" | "INTERNAL";
  "uiVisibility": "DEFAULT" | "ADVANCED" | "HIDDEN";
}

export interface PermissionCatalogResponseDto {
  "totalItems": number;
  "sections": PermissionCatalogSectionDto[];
}

export interface PermissionCatalogSectionDto {
  "code": string;
  "displayName": string;
  "sortOrder": number;
  "groups": PermissionCatalogGroupDto[];
}

export interface PermissionResponseDto {
  "id": string;
  "code": string;
  "module": string;
  "action": string;
  "resourceType": string;
  "description"?: Record<string, unknown>;
  "createdAt": string;
  "updatedAt": string;
}

export interface RbacRoleDetailResponseDto {
  "id": string;
  "code": string;
  "displayName": string;
  "description"?: Record<string, unknown>;
  "permissionRevision": number;
  "createdAt": string;
  "updatedAt": string;
  "kind": "SYSTEM" | "CUSTOM";
  "permissionManagementMode": "RELEASE_MANAGED" | "ADMIN_EDITABLE";
  "bindingManagementMode": "SYSTEM_ONLY" | "MANUAL_ALLOWED" | "POLICY_DERIVED";
  "permissions": PermissionResponseDto[];
}

export interface RbacRoleResponseDto {
  "id": string;
  "code": string;
  "displayName": string;
  "description"?: Record<string, unknown>;
  "permissionRevision": number;
  "createdAt": string;
  "updatedAt": string;
  "kind": "SYSTEM" | "CUSTOM";
  "permissionManagementMode": "RELEASE_MANAGED" | "ADMIN_EDITABLE";
  "bindingManagementMode": "SYSTEM_ONLY" | "MANUAL_ALLOWED" | "POLICY_DERIVED";
}

export interface RealnameSettingsResponseDto {
  "id": string;
  "providerType": "DEV_STUB" | "TENCENT_CLOUD";
  "enabled": boolean;
  "region"?: Record<string, unknown> | null;
  "credentialStatus": "configured" | "missing" | "invalid";
  "credentialConfigured": boolean;
  "remarks"?: Record<string, unknown> | null;
  "updatedBy"?: Record<string, unknown> | null;
  "updatedAt": string;
  "createdAt": string;
}

export interface ReloadRbacDto {
  "scope"?: "all" | "user" | "role";
  "userId"?: string;
  "roleId"?: string;
}

export interface ReloadRbacResponseDto {
  "reloaded": boolean;
}

export interface ReplaceRolePermissionsDto {
  "permissionCodes": string[];
  "expectedRevision": number;
  "stepUpToken"?: string;
}

export interface ResetRealnameCredentialsDto {
  "secretId": string;
  "secretKey": string;
}

export interface ResetSmsCredentialsDto {
  "secretId": string;
  "secretKey": string;
}

export interface ResetStorageCredentialsDto {
  "secretId": string;
  "secretKey": string;
}

export interface ResetWechatCredentialsDto {
  "appSecret": string;
}

export interface ResetWecomCredentialsDto {
  "corpSecret": string;
}

export interface RoleOptionItemDto {
  "id": string;
  "label": string;
  "code": string;
}

export interface RoleOptionsResponseDto {
  "items": RoleOptionItemDto[];
}

export interface RolePermissionDiffItemDto {
  "code": string;
  "displayName": Record<string, unknown> | null;
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
}

export interface RolePermissionImpactDto {
  "completeness": "EXACT" | "PARTIAL";
  "partialReason": Record<string, unknown> | null;
  "totalGrantCount": number;
  "roleBinding": RolePermissionImpactSourceDto;
  "positionPolicy": RolePermissionImpactSourceDto;
  "supervision": RolePermissionImpactSourceDto;
  "scopeBreakdown": RolePermissionImpactScopeBreakdownDto;
  "principalBreakdown": RolePermissionImpactPrincipalBreakdownDto;
}

export interface RolePermissionImpactPrincipalBreakdownDto {
  "USER": number;
  "MEMBER": number;
  "POSITION_ASSIGNMENT": number;
  "SYSTEM": number;
}

export interface RolePermissionImpactScopeBreakdownDto {
  "GLOBAL": number;
  "ORGANIZATION": number;
  "ORGANIZATION_TREE": number;
  "ACTIVITY": number;
  "RESOURCE": number;
  "SELF": number;
}

export interface RolePermissionImpactSourceDto {
  "grantCount": number;
  "completeness": "EXACT" | "PARTIAL";
  "partialReason": Record<string, unknown> | null;
}

export interface RolePermissionPreviewIssueDto {
  "bizCode": number;
  "message": string;
  "httpStatus": number;
}

export interface RolePermissionPreviewOutcomeDto {
  "noOp": boolean;
  "currentRevision": number;
  "nextRevision": number;
  "added": RolePermissionDiffItemDto[];
  "removed": RolePermissionDiffItemDto[];
  "unchangedCount": number;
  "resultCodes": string[];
  "requiresStepUp": boolean;
  "impact": RolePermissionImpactDto;
}

export interface RolePermissionPreviewResponseDto {
  "valid": boolean;
  "blockingIssues": RolePermissionPreviewIssueDto[];
  "outcome": RolePermissionPreviewOutcomeDto;
}

export interface RolePermissionSetEditPolicyDto {
  "canEdit": boolean;
  "readOnlyReason": Record<string, unknown> | null;
}

export interface RolePermissionSetResponseDto {
  "role": RolePermissionSetRoleDto;
  "permissionRevision": number;
  "permissionCodes": string[];
  "editPolicy": RolePermissionSetEditPolicyDto;
}

export interface RolePermissionSetRoleDto {
  "id": string;
  "code": string;
  "displayName": string;
  "kind": "SYSTEM" | "CUSTOM";
  "permissionManagementMode": "RELEASE_MANAGED" | "ADMIN_EDITABLE";
  "bindingManagementMode": "SYSTEM_ONLY" | "MANUAL_ALLOWED" | "POLICY_DERIVED";
}

export interface ServicePrincipalCredentialCreatedDto {
  "id": string;
  "createdAt": string;
  "clientSecret": string;
}

export interface ServicePrincipalCredentialResponseDto {
  "id": string;
  "createdAt": string;
  "expiresAt": Record<string, unknown> | null;
  "revokedAt": Record<string, unknown> | null;
  "lastUsedAt": Record<string, unknown> | null;
}

export interface ServicePrincipalResponseDto {
  "id": string;
  "clientId": string;
  "name": string;
  "description": Record<string, unknown> | null;
  "status": "ACTIVE" | "SUSPENDED";
  "ownerOrganizationId": Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface SmsSendLogResponseDto {
  "id": string;
  "phone": string;
  "templateKey": string;
  "providerType": "DEV_STUB" | "TENCENT_SMS";
  "status": "SENT" | "FAILED";
  "providerMsgId"?: Record<string, unknown> | null;
  "errCode"?: Record<string, unknown> | null;
  "errMsg"?: Record<string, unknown> | null;
  "codeId"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface SmsSettingsResponseDto {
  "id": string;
  "providerType": "DEV_STUB" | "TENCENT_SMS";
  "enabled": boolean;
  "sdkAppId"?: Record<string, unknown> | null;
  "signName"?: Record<string, unknown> | null;
  "region"?: Record<string, unknown> | null;
  "templateIdVerifyCode"?: Record<string, unknown> | null;
  "templateIdBirthday"?: Record<string, unknown> | null;
  "templateIdNotification"?: Record<string, unknown> | null;
  "credentialStatus": "configured" | "missing" | "invalid";
  "credentialConfigured": boolean;
  "remarks"?: Record<string, unknown> | null;
  "updatedBy"?: Record<string, unknown> | null;
  "updatedAt": string;
  "createdAt": string;
}

export interface StorageSettingsResponseDto {
  "id": string;
  "providerType": "LOCAL" | "COS";
  "enabled": boolean;
  "bucket"?: Record<string, unknown> | null;
  "region"?: Record<string, unknown> | null;
  "envPrefix"?: Record<string, unknown> | null;
  "uploadUrlTtlSeconds": number;
  "downloadUrlTtlSeconds": number;
  "lifecycleDays": number;
  "enableSignedUrl": boolean;
  "enableVersioning": boolean;
  "corsAllowedOrigins"?: string[] | null;
  "maxObjectSizeBytes"?: Record<string, unknown> | null;
  "allowedMimePolicyMode": "INHERIT" | "OVERRIDE";
  "credentialStatus": "configured" | "missing" | "invalid";
  "credentialConfigured": boolean;
  "remarks"?: Record<string, unknown> | null;
  "updatedBy"?: Record<string, unknown> | null;
  "updatedAt": string;
  "createdAt": string;
}

export interface UpdateAttachmentMimeConfigDto {
  "remark"?: string;
}

export interface UpdateAttachmentMimeConfigStatusDto {
  "status": "ACTIVE" | "INACTIVE";
}

export interface UpdateAttachmentSizeLimitConfigDto {
  "maxSizeBytes"?: number;
  "remark"?: string;
}

export interface UpdateAttachmentTypeConfigDto {
  "displayName"?: string;
  "description"?: string;
  "ownerTable"?: string;
  "defaultMaxSizeBytes"?: Record<string, unknown> | null;
  "defaultMimeWhitelist"?: string[];
}

export interface UpdateAttachmentTypeConfigStatusDto {
  "status": "ACTIVE" | "INACTIVE";
}

export interface UpdateContributionRuleDto {
  "pointsBelow"?: number;
  "pointsAbove"?: number | null;
  "status"?: "ACTIVE" | "INACTIVE";
  "remark"?: Record<string, unknown> | null;
}

export interface UpdateDictItemDto {
  "label"?: string;
  "sortOrder"?: number;
}

export interface UpdateDictItemStatusDto {
  "status": "ACTIVE" | "INACTIVE";
}

export interface UpdateDictTypeDto {
  "label"?: string;
  "sortOrder"?: number;
}

export interface UpdateDictTypeStatusDto {
  "status": "ACTIVE" | "INACTIVE";
}

export interface UpdatePermissionDto {
  "description"?: string;
}

export interface UpdateRbacRoleDto {
  "displayName"?: string;
  "description"?: string;
}

export interface UpdateRealnameSettingsDto {
  "providerType"?: "DEV_STUB" | "TENCENT_CLOUD";
  "enabled"?: boolean;
  "region"?: string;
  "remarks"?: string;
}

export interface UpdateServicePrincipalDto {
  "name"?: string;
  "description"?: string;
  "ownerOrganizationId"?: string;
}

export interface UpdateServicePrincipalStatusDto {
  "status": "ACTIVE" | "SUSPENDED";
}

export interface UpdateSmsSettingsDto {
  "providerType"?: "DEV_STUB" | "TENCENT_SMS";
  "enabled"?: boolean;
  "sdkAppId"?: string;
  "signName"?: string;
  "region"?: string;
  "templateIdVerifyCode"?: string;
  "templateIdBirthday"?: string;
  "templateIdNotification"?: string;
  "remarks"?: string;
}

export interface UpdateStorageSettingsDto {
  "providerType"?: "LOCAL" | "COS";
  "enabled"?: boolean;
  "bucket"?: Record<string, unknown> | null;
  "region"?: Record<string, unknown> | null;
  "envPrefix"?: Record<string, unknown> | null;
  "uploadUrlTtlSeconds"?: number;
  "downloadUrlTtlSeconds"?: number;
  "lifecycleDays"?: number;
  "enableSignedUrl"?: boolean;
  "enableVersioning"?: boolean;
  "corsAllowedOrigins"?: string[] | null;
  "maxObjectSizeBytes"?: Record<string, unknown> | null;
  "allowedMimePolicyMode"?: "INHERIT" | "OVERRIDE";
  "remarks"?: Record<string, unknown> | null;
}

export interface UpdateWechatSettingsDto {
  "providerType"?: "DEV_STUB" | "WECHAT";
  "enabled"?: boolean;
  "appId"?: string;
  "remarks"?: string;
}

export interface UpdateWecomSettingsDto {
  "providerType"?: "DEV_STUB" | "WECOM";
  "enabled"?: boolean;
  "loginEnabled"?: boolean;
  "messageEnabled"?: boolean;
  "corpId"?: string;
  "agentId"?: number;
  "webBaseUrl"?: string;
  "remarks"?: string;
}

export interface UserRoleResponseDto {
  "id": string;
  "roleId": string;
  "roleCode": string;
  "roleDisplayName": string;
  "createdAt": string;
  "createdByUserId": string | null;
}

export interface WechatSettingsResponseDto {
  "id": string;
  "providerType": "DEV_STUB" | "WECHAT";
  "enabled": boolean;
  "appId"?: Record<string, unknown> | null;
  "credentialStatus": "configured" | "missing" | "invalid";
  "credentialConfigured": boolean;
  "remarks"?: Record<string, unknown> | null;
  "updatedBy"?: Record<string, unknown> | null;
  "updatedAt": string;
  "createdAt": string;
}

export interface WecomSettingsResponseDto {
  "id": string;
  "providerType": "DEV_STUB" | "WECOM";
  "enabled": boolean;
  "loginEnabled": boolean;
  "messageEnabled": boolean;
  "corpIdMasked"?: Record<string, unknown> | null;
  "agentId"?: Record<string, unknown> | null;
  "webBaseUrl"?: Record<string, unknown> | null;
  "credentialConfigured": boolean;
  "credentialStatus": "configured" | "missing" | "invalid";
  "remarks"?: Record<string, unknown> | null;
  "updatedBy"?: Record<string, unknown> | null;
  "updatedAt": string;
  "createdAt": string;
}

export interface WecomTestConnectionResponseDto {
  "ok": boolean;
  "providerType": "DEV_STUB" | "WECOM";
  "credentialStatus": "configured" | "missing" | "invalid";
  "tokenAcquired": boolean;
  "agentMatched": boolean;
  "agentEnabled": boolean;
  "agentName"?: Record<string, unknown> | null;
  "visibilitySummary": WecomVisibilitySummaryDto;
  "redirectDomainConfigured": boolean;
  "checkedAt": string;
}

export interface WecomVisibilitySummaryDto {
  "directUsers": number;
  "parties": number;
  "tags": number;
}
