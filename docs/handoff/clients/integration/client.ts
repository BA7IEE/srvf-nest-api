// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// surface: Integration 外部系统面
// contractVersion: 0.69.0
// generatorVersion: 1.0.0
// inputDigest: sha256:a2991bd65b98212909486232db5e5e83b6997b6b66317e936f6d76222a7caa60
//
// ⚠️ 本文件**只有类型与调用签名**:不含 baseURL、不含令牌、不含任何鉴权逻辑。
//    登录态怎么带、令牌怎么刷新,由消费方在注入的 Fetcher 里自理
//    (登录/刷新的三步接线见 docs/handoff/admin-web.md §3.1)。

import type {
  ApiEnvelope,
  PageResult,
  FetchRequest,
  Fetcher,
  IntegrationMeResponseDto,
  IntegrationServicePrincipalDto,
} from './types';

export type { ApiEnvelope, PageResult, FetchRequest, Fetcher };

export function createIntegrationClient(fetcher: Fetcher) {
  return {
    /** 查看当前 Integration 主体最小身份 [auth] */
    IntegrationApiControllerGetMe(): Promise<ApiEnvelope<IntegrationMeResponseDto>> {
      return fetcher<IntegrationMeResponseDto>({ method: "GET", path: "/api/integration/v1/me" });
    },
  };
}
