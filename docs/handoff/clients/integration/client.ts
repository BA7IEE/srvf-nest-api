// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// surface: Integration 外部系统面
// contractVersion: 0.72.0
// generatorVersion: 1.0.0
// inputDigest: sha256:0fde43e83d3011a782d38d88dd9752c057dc4aea29ee0ae0ecfd2ae21f86c6ed
//
// ⚠️ 本文件**只有类型与调用签名**:不含 baseURL、不含令牌、不含任何鉴权逻辑。
//    登录态怎么带、令牌怎么刷新,由消费方在注入的 Fetcher 里自理
//    (登录/刷新的三步接线见 docs/handoff/admin-web.md §3.1)。

import type {
  ApiEnvelope,
  PageResult,
  FetchRequest,
  Fetcher,
  IntegrationActivityTypeItemDto,
  IntegrationMeResponseDto,
  IntegrationServicePrincipalDto,
  PageResultDto,
} from './types';

export type { ApiEnvelope, PageResult, FetchRequest, Fetcher };

export function createIntegrationClient(fetcher: Fetcher) {
  return {
    /** 查看当前 Integration 主体最小身份 [auth] */
    IntegrationApiControllerGetMe(): Promise<ApiEnvelope<IntegrationMeResponseDto>> {
      return fetcher<IntegrationMeResponseDto>({ method: "GET", path: "/api/integration/v1/me" });
    },
    /** 分页读取活动类型参考数据（仅 Service 主体） [rbac: dict.read.item] */
    IntegrationActivityTypesControllerList(query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": IntegrationActivityTypeItemDto[] }>> {
      return fetcher<PageResultDto & { "items": IntegrationActivityTypeItemDto[] }>({ method: "GET", path: "/api/integration/v1/reference/activity-types", query });
    },
  };
}
