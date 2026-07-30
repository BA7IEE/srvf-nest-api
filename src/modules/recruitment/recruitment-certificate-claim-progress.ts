import type { Prisma } from '@prisma/client';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import type { PrismaService } from '../../database/prisma.service';
import type { ProgressClaimLike } from './recruitment-progress-presenter';

// 证书标准库 PR-4a-2(冻结稿 §8.1):申请人进度里的证书段取数。
//
// 为什么是**普通导出函数**而不是 service 方法:
//   `RecruitmentCertificateClaimsService` 已经注入了 `RecruitmentIdentityService`
//   (公开面共用同一条双通道凭证链),而进度组装的两个调用方之一正是 identity service。
//   把这段取数放进 ClaimsService 会立刻形成 identity ↔ claims 循环依赖。
//   它只是一条窄查询,不需要 DI 也不持有事务,做成纯函数是最省的解法。
//
// select 刻意只取组装需要的字段:**不含** imageKeys / certNumber / 审核人 ——
// 传不进 presenter 就不可能从公开进度里泄出去(§15.4)。
export async function loadProgressClaims(
  client: PrismaService | Prisma.TransactionClient,
  applicationId: string,
): Promise<ProgressClaimLike[]> {
  const rows = await client.recruitmentCertificateClaim.findMany({
    where: notDeletedWhere({ applicationId }),
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      version: true,
      status: true,
      categoryHintCode: true,
      rawCertificateName: true,
      reviewNote: true,
      imageKeys: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    categoryHintCode: r.categoryHintCode,
    rawCertificateName: r.rawCertificateName,
    reviewNote: r.reviewNote,
    // key 在这里就地折成计数,数组本身不出这个函数。
    imageCount: Array.isArray(r.imageKeys) ? r.imageKeys.length : 0,
  }));
}
