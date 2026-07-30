import { Prisma, type RecruitmentApplication } from '@prisma/client';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { APP_INACTIVE_STATUS_CODES, APP_STATUS_PROMOTED } from './recruitment.constants';

// 冻结稿 §8.3 / §8.5 固定锁序第 1 步的**唯一实现**。
//
// 跨模型评审(2026-07-30)在四条写路径上抓到同一个形状的缺陷:
// 「锁了报名行,但判定依据仍是锁**之前**读到的那份快照」。锁本身不刷新快照 ——
// 等锁期间提交的撤销 / 换绑 / 发号在锁释放后才可见,而代码从不回头看。
//
// 所以这里把范式做成函数而不是写成注释:
//
//     锁(稳定顺序) → 锁后复读整行 → 判定状态与归属 → 迁移 → CAS 收尾
//
// 前三步归本文件,第四步归 `claimAtStatus`(common/prisma)—— 它带 `WHERE statusCode = ?`,
// 是「写入时该行仍在我判定的那个状态」的唯一保证。两者成对使用:
// 只锁不 CAS 会在锁跨事务边界时失效,只 CAS 不锁会让读到的关联数据(Claim 集合)不一致。
//
// 锁模式统一用 `FOR NO KEY UPDATE`,与 `claimAtStatus` 同款:
// 我们不改报名的主键或被引用列,只拿它当互斥量。它与并发的普通 UPDATE
// (PostgreSQL 对非键列更新也取 FOR NO KEY UPDATE)互斥,互斥性不打折。

/** 锁住报名行并返回**锁后复读**的整行;行不存在或已软删 → null。 */
export async function lockApplicationRow(
  tx: Prisma.TransactionClient,
  applicationId: string,
): Promise<RecruitmentApplication | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "recruitment_applications"
    WHERE "id" = ${applicationId} AND "deletedAt" IS NULL
    FOR NO KEY UPDATE
  `);
  if (locked.length === 0) return null;
  // 锁到之后再读业务字段:锁内读到的必然是最新已提交状态(沿 policies 的 lockStandardOrThrow)。
  return tx.recruitmentApplication.findFirst({
    where: { id: applicationId, deletedAt: null },
  });
}

/** 报名的三个终态 —— 到了这里就不再接受任何证书申报侧的变更。 */
export function isApplicationTerminal(statusCode: string): boolean {
  return APP_INACTIVE_STATUS_CODES.includes(statusCode) || statusCode === APP_STATUS_PROMOTED;
}

/** 锁 + 复读 + 断言仍处于非终态(管理端路径:调用方已按 claimId / applicationId 判过权)。 */
export async function lockActiveApplicationOrThrow(
  tx: Prisma.TransactionClient,
  applicationId: string,
  inactiveBiz: BizCodeEntry = BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
): Promise<RecruitmentApplication> {
  const row = await lockApplicationRow(tx, applicationId);
  if (!row) throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
  if (isApplicationTerminal(row.statusCode)) throw new BizException(inactiveBiz);
  return row;
}

/**
 * 公开面(申请人自助)专用:锁 + 复读 + **复核归属** + 断言非终态。
 *
 * 归属复核是 §13.3「claimId 不能单独构成授权」的时间维度补丁:
 * 凭证在事务**之外**解析(要调微信 / 消费短信码,不能放进事务),
 * 而报名的 openid / phone 在等锁期间可能被自助换绑改掉。此时旧凭证不该再写这份报名。
 *
 * 不匹配按 `RECRUITMENT_APPLICATION_NOT_FOUND` 泛化返回 —— 逐字沿用整份撤销那条路径的口径:
 * 既不写入新身份对应的报名,也不通过错误码泄露旧凭证曾命中过哪条记录。
 */
export async function lockOwnActiveApplicationOrThrow(
  tx: Prisma.TransactionClient,
  pre: { id: string; openid: string | null; phone: string | null },
  channel: 'wechat' | 'phone',
): Promise<RecruitmentApplication> {
  const row = await lockApplicationRow(tx, pre.id);
  if (!row) throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);

  const identityStillMatches =
    channel === 'wechat'
      ? row.openid !== null && row.openid === pre.openid
      : (row.phone ?? '') !== '' && (row.phone ?? '').trim() === (pre.phone ?? '').trim();
  if (!identityStillMatches) {
    throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
  }

  // 终态报名不得再产生 / 变更证书申报 —— 这是「终态报名下不存在非终态 Claim」
  // 这条数据库级不变量在**写入侧**的守门人。整份撤销那条路径负责把存量 Claim 级联成
  // WITHDRAWN;没有这道闸,级联之后仍能插进一条新的 SUBMITTED,不变量当场破。
  if (isApplicationTerminal(row.statusCode)) {
    throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
  }
  return row;
}
