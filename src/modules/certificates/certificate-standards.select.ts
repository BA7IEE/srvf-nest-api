import { Prisma } from '@prisma/client';

// 证书标准库 PR-3(冻结稿 §5.2 / §13.1):CertificateStandard 读出投影。
//
// 恒不含 `deletedAt`(软删是内部状态,不外泄;沿 positions.select 范式)。
// 必须与 `CertificateStandardResponseDto` 同步维护。
export const certificateStandardSafeSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  kind: true,
  categoryCode: true,
  levelCode: true,
  parentId: true,
  isInternal: true,
  status: true,
  sortOrder: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CertificateStandardSelect;

export type SafeCertificateStandard = Prisma.CertificateStandardGetPayload<{
  select: typeof certificateStandardSafeSelect;
}>;

// options 端点(§13.1)的窄投影 + 当前 ACTIVE Policy 摘要与 issuer 选项。
//
// 为什么带 policies:§13.1 要求 options「返回当前 Policy 摘要和 issuer 选项」——
// 前端建证/审核时要据此决定「编号填不填、到期日让不让填、机构是下拉还是自由文本」。
// 这里用 `where: status=ACTIVE` 的嵌套 take:1 一次取回,**不做 N+1**。
export const certificateStandardOptionSelect = {
  id: true,
  code: true,
  name: true,
  categoryCode: true,
  levelCode: true,
  isInternal: true,
  policies: {
    where: { status: 'ACTIVE' as const, deletedAt: null },
    take: 1,
    select: {
      id: true,
      version: true,
      issuerPolicy: true,
      validityMode: true,
      validityMonths: true,
      certNumberMode: true,
      issuers: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
        select: { id: true, name: true },
      },
    },
  },
} as const satisfies Prisma.CertificateStandardSelect;

export type CertificateStandardOptionRow = Prisma.CertificateStandardGetPayload<{
  select: typeof certificateStandardOptionSelect;
}>;
