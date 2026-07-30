import type { Prisma, Role } from '@prisma/client';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  deriveSatisfiedCertificateCategories,
  recalcApplicationStatusForThresholds,
} from './recruitment-certificate-claim-state-machine';
import {
  CERTIFICATE_THRESHOLD_BY_CATEGORY,
  RECRUITMENT_CERT_CATEGORIES,
  allThresholdsComplete,
  type ThresholdMarks,
} from './recruitment.constants';

// 派生门槛标记的 `by` 位。人工标记那三项写的是操作人 User.id;这两项没有「标记人」——
// 它是审核结论的投影。写一个显式常量而不是塞审核员 id:塞审核员会让人误以为
// 那是一次人工标记,从而误以为可以人工撤销。
const DERIVED_THRESHOLD_ACTOR = 'system:certificate-claim-derived';

/**
 * 证书标准库 PR-4a-2:把 `redCross` / `bsafe` 两个门槛重算成
 * 「该报名当前全部未软删 Claim」的聚合投影,并按需推进 / 回退报名状态。
 *
 * **本方法是这两个门槛的唯一写者。** 所有会改变 Claim 状态的路径
 * (提交 / 重传 / 撤回 / 审核 / 撤回审核 / 整份撤销 / 发号)都必须在**同一事务**、
 * **持有报名行锁之后**调它一次。少调一次,派生就会静默落后于事实。
 *
 * 为什么必须是「重算聚合」而不是「这次审核的结论直接写」——§8.4 第一条推论:
 * 两张急救证里拒掉一张,聚合仍看得见另一张已通过的证书;而逐次覆写的标记
 * 记不住「还有另一张」,会把已满足的门槛错误清掉。
 *
 * 门槛值仍物化在 `thresholdMarks` JSON 里(所有既有读侧因此逐字不变),
 * 但它对这两个 code 是**投影而不是事实源** —— 人工标记入口已在
 * `markThreshold` 与两个 DTO 上被拒(28063 + 契约层 @IsIn)。
 */
export async function recomputeCertificateThresholds(
  auditLogs: AuditLogsService,
  tx: Prisma.TransactionClient,
  applicationId: string,
  ctx: {
    actorUserId: string | null;
    actorRoleSnap: Role | null;
    meta: AuditMeta;
    now: Date;
  },
): Promise<void> {
  const { actorUserId, actorRoleSnap, meta, now } = ctx;
  const app = await tx.recruitmentApplication.findFirst({
    where: notDeletedWhere({ id: applicationId }),
    select: {
      id: true,
      statusCode: true,
      thresholdMarks: true,
      evaluatedByUserId: true,
      evaluatedAt: true,
      evaluationNote: true,
    },
  });
  // 报名不存在 / 已软删 → 无门槛可算。调用方各自已校验过存在性,这里只是不越权抛错。
  if (!app) return;

  // 只取聚合需要的两个字段。**categoryCode 取自已解析的 Standard**,
  // 不是申请人填的 categoryHintCode —— 提示只是提示,门槛只认审核结论(D-CERT-016)。
  const claims = await tx.recruitmentCertificateClaim.findMany({
    where: notDeletedWhere({ applicationId }),
    select: { status: true, standard: { select: { categoryCode: true } } },
  });
  const satisfied = deriveSatisfiedCertificateCategories(
    claims.map((c) => ({ status: c.status, categoryCode: c.standard?.categoryCode ?? null })),
  );

  const marks: ThresholdMarks = { ...((app.thresholdMarks as ThresholdMarks | null) ?? {}) };
  for (const category of RECRUITMENT_CERT_CATEGORIES) {
    const code = CERTIFICATE_THRESHOLD_BY_CATEGORY[category];
    if (satisfied.has(category)) {
      // 已有标记就保留原 at/by(不因为每次重算都刷新完成时刻 —— 那会让
      // 「什么时候满足的」这个事实随任意一次无关重算漂移)。
      if (marks[code] == null) {
        marks[code] = { at: now.toISOString(), by: DERIVED_THRESHOLD_ACTOR };
      }
    } else {
      delete marks[code];
    }
  }

  const { nextStatus, mustClearEvaluation } = recalcApplicationStatusForThresholds(
    app.statusCode,
    allThresholdsComplete(marks),
  );

  const data: Prisma.RecruitmentApplicationUncheckedUpdateInput = {
    thresholdMarks: marks as Prisma.InputJsonValue,
    statusCode: nextStatus,
  };
  // §8.4:从 publicity 掉回 verified 必须**同步清空**评定字段。
  // 保留「已评定通过」却把状态退回,等于让一份未达门槛的报名带着通过痕迹留在库里。
  if (mustClearEvaluation) {
    data.evaluatedByUserId = null;
    data.evaluatedAt = null;
    data.evaluationNote = null;
  }

  const changed =
    nextStatus !== app.statusCode ||
    JSON.stringify(marks) !== JSON.stringify(app.thresholdMarks ?? {}) ||
    mustClearEvaluation;
  if (!changed) return;

  await tx.recruitmentApplication.update({ where: { id: applicationId }, data });

  await auditLogs.log({
    event: 'recruitment-application.threshold-recompute',
    actorUserId,
    actorRoleSnap,
    resourceType: 'recruitment_application',
    resourceId: applicationId,
    meta,
    before: { statusCode: app.statusCode },
    after: { statusCode: nextStatus },
    extra: {
      operation: 'derive-certificate-thresholds',
      // 只记「哪些证书门槛现在成立」与是否清了评定 —— 不记 Claim 明细,更不记编号 / key。
      satisfiedCategories: [...satisfied].sort(),
      evaluationCleared: mustClearEvaluation,
    },
    tx,
  });
}
