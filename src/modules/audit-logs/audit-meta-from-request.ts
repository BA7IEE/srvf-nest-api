import type { Request } from 'express';

import type { AuditMeta } from './audit-logs.types';

/** HTTP 控制面生成审计元数据时允许读取的、已由全局边界规范化的请求事实。 */
export type AuditMetaRequest = Pick<Request, 'headers'> & {
  id?: unknown;
  ip?: string;
};

/**
 * 审计来源唯一入口。
 *
 * request-id 与客户端 IP 已在 applyGlobalSetup() 中完成校验和规范化；Controller
 * 不得重新读取原始 x-request-id、X-Forwarded-For、Forwarded 或 X-Real-IP。
 */
export function auditMetaFromRequest(req: AuditMetaRequest): AuditMeta {
  if (typeof req.id !== 'string' || req.id.length === 0) {
    throw new Error('Canonical request id is missing');
  }

  const userAgent = req.headers['user-agent'];
  return {
    requestId: req.id,
    ip: req.ip ?? null,
    ua: typeof userAgent === 'string' ? userAgent : null,
  };
}
