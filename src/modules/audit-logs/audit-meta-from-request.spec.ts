import { auditMetaFromRequest, type AuditMetaRequest } from './audit-meta-from-request';

function requestOf(input: {
  id?: string;
  ip?: string;
  headers?: Record<string, string | undefined>;
}): AuditMetaRequest {
  return {
    id: input.id,
    ip: input.ip,
    headers: input.headers ?? {},
  };
}

describe('auditMetaFromRequest', () => {
  it('只采用全局边界已建立的 req.id 和 req.ip，不读取原始代理头', () => {
    const meta = auditMetaFromRequest(
      requestOf({
        id: 'canonical-request-id',
        ip: '203.0.113.10',
        headers: {
          'x-request-id': 'forged-request-id',
          'x-forwarded-for': '198.51.100.20',
          'user-agent': 'audit-meta-spec',
        },
      }),
    );

    expect(meta).toEqual({
      requestId: 'canonical-request-id',
      ip: '203.0.113.10',
      ua: 'audit-meta-spec',
    });
  });

  it('缺少 canonical req.id 时 fail-closed', () => {
    expect(() => auditMetaFromRequest(requestOf({ ip: '203.0.113.10' }))).toThrow(
      'Canonical request id is missing',
    );
    expect(() => auditMetaFromRequest(requestOf({ id: '', ip: '203.0.113.10' }))).toThrow(
      'Canonical request id is missing',
    );
  });

  it('缺少 user-agent 时显式写入 null', () => {
    expect(
      auditMetaFromRequest(
        requestOf({ id: 'canonical-request-id', ip: '203.0.113.10', headers: {} }),
      ),
    ).toEqual({ requestId: 'canonical-request-id', ip: '203.0.113.10', ua: null });
  });
});
