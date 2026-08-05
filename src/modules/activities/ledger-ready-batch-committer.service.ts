import { Injectable } from '@nestjs/common';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { LedgerPostingService, type LedgerCommitResult } from './ledger-posting.service';

/**
 * `ready` 批次的自动提交入口。
 *
 * 这里只负责解析责任人并调用第五刀的统一生效协议。baseline、日上限与锁槽预算
 * 仍全部由 `LedgerPostingService.commitBatch` 执行，本服务不复制任何一条判定。
 */
@Injectable()
export class LedgerReadyBatchCommitter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: LedgerPostingService,
  ) {}

  async commitReadyBatch(postingBatchId: string): Promise<LedgerCommitResult> {
    const batch = await this.prisma.ledgerPostingBatch.findUnique({
      where: { id: postingBatchId },
      select: { settlementVersionId: true },
    });
    if (batch === null) throw new BizException(BizCode.LEDGER_COMMIT_BATCH_STATUS_INVALID);

    const decision = await this.prisma.settlementReviewAction.findFirst({
      where: {
        settlementVersionId: batch.settlementVersionId,
        stageCode: 'final',
        actionCode: 'approve',
      },
      select: {
        actor: {
          select: {
            id: true,
            username: true,
            role: true,
            status: true,
            memberId: true,
          },
        },
      },
      orderBy: [{ actedAt: 'desc' }, { id: 'desc' }],
    });
    if (decision === null) {
      throw new BizException(BizCode.LEDGER_COMMIT_FINAL_APPROVER_MISSING);
    }

    return await this.posting.commitBatch(
      {
        postingBatchId,
        operationKey: `ledger-auto-commit:${postingBatchId}`,
      },
      decision.actor,
      {
        requestId: `activity-batch-worker:${postingBatchId}`,
        ip: null,
        ua: 'activity-batch-worker',
      },
    );
  }
}
