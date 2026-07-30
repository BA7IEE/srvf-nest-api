import { Prisma, RecruitmentCertificateClaimStatus } from '@prisma/client';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';

// 冻结稿 §8.4 / §8.5:「报名进终态时,它下面的证书申报怎么办」的**唯一实现**。
//
// 跨模型评审(2026-07-30 第三轮 H1)抓到的是范式没铺完:发号与整份撤销各自写了一份
// 级联,而另外两条同样写终态的路径(综合评定淘汰 / 人工核验不通过)一条也没有。
// 后果不是并发窗口,是**永久卡死**:
//
//   `APP_INACTIVE_STATUS_CODES` 含 rejected ⇒ `lockActiveApplicationOrThrow` 之后
//   拒绝一切 Claim 写路径 ⇒ 那些 APPROVED / SUBMITTED 的申报再也不可能被撤回审核、
//   拒绝、重传、撤回或转 PROMOTED。而留存 SOP 只扫 status ∈ {REJECTED, WITHDRAWN},
//   证据闸 `CLAIM_EVIDENCE_DENIED` 只含 {WITHDRAWN, PROMOTED} ——
//   于是一个没进队的人的证件照永久留存,后台还能继续签出下载 URL。
//
// 所以这里把它做成函数而不是写成注释:**任何把报名写成终态的路径都必须调它一次**,
// 且必须在已持有该报名行锁的同一事务内 —— 否则并发的申请人重传会插在级联之后。
//
// 与 `recomputeCertificateThresholds` 的关系:本函数只管 Claim 侧,不碰报名行。
// 派生门槛的重算归调用方 —— 它对报名 statusCode 有副作用,而各条终态路径写
// statusCode 的时机不同(发号在级联之后写、撤销在级联之前写),调用点必须由
// 调用方按自己的 CAS 顺序决定,不能藏进这里。

/**
 * 报名进终态时收尾其证书申报:锁该报名全部未软删 Claim(id ASC),
 * 把**非 PROMOTED** 的一律转 WITHDRAWN,返回级联条数。
 *
 * PROMOTED 保留:那批申报已经生成正式证书,改成 WITHDRAWN 会让档案与申报事实脱钩
 * (`Certificate.sourceClaimId` 指过来的那一行必须仍是 PROMOTED)。
 *
 * 锁按 **id ASC**:与发号路径(§8.5 第 2 步)同一顺序,两条路径并发时不会交叉等待。
 *
 * 返回值只用于审计计数 —— 调用方**只许记条数**,不记 claimId / 证书编号 / 图片 key。
 */
export async function withdrawClaimsOnApplicationTerminal(
  tx: Prisma.TransactionClient,
  applicationId: string,
): Promise<number> {
  const claimIds = (
    await tx.recruitmentCertificateClaim.findMany({
      where: notDeletedWhere({ applicationId }),
      orderBy: { id: 'asc' },
      select: { id: true },
    })
  ).map((c) => c.id);
  if (claimIds.length === 0) return 0;

  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "RecruitmentCertificateClaim" WHERE "id" IN (${Prisma.join(
      claimIds,
    )}) ORDER BY "id" ASC FOR UPDATE`,
  );

  // 锁后按状态过滤,不按上面读到的 id 列表逐行写:等锁期间某一行可能刚被转成
  // PROMOTED(发号),`notIn [PROMOTED]` 在锁内重新判定才不会把它错误撤掉。
  const cascaded = await tx.recruitmentCertificateClaim.updateMany({
    where: {
      applicationId,
      deletedAt: null,
      status: { notIn: [RecruitmentCertificateClaimStatus.PROMOTED] },
    },
    data: { status: RecruitmentCertificateClaimStatus.WITHDRAWN },
  });
  return cascaded.count;
}
