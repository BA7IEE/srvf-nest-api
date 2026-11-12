// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// 真相源:后端 live /api/docs-json;本文件派生自 docs/handoff/openapi.json 快照。
// surface: Integration 外部系统面
// contractVersion: 0.72.0
// generatorVersion: 1.0.0
// inputDigest: sha256:256c4e6ddf3172b94dc11bb59e8d5e60ba337460c645fb225f848f1ebf9c177f

// 共用类型不在本文件重复定义 —— 从 shared 引入并再导出,保证仓内每个类型只有一份定义。
import type { ApiEnvelope, PageResult, FetchRequest, Fetcher, PageResultDto } from '../shared/types';
export type { ApiEnvelope, PageResult, FetchRequest, Fetcher, PageResultDto };

export interface IntegrationActivityTypeItemDto {
  "code": string;
  "label": string;
  "sortOrder": number;
}

export interface IntegrationMeResponseDto {
  "principalKind": "SERVICE" | "DELEGATED";
  "servicePrincipal": IntegrationServicePrincipalDto;
  "delegated": boolean;
}

export interface IntegrationServicePrincipalDto {
  "clientId": string;
  "name": string;
}
