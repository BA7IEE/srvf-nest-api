import { Role, UserStatus } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { LedgerReadyBatchCommitter } from './ledger-ready-batch-committer.service';

describe('LedgerReadyBatchCommitter', () => {
  it('只把 final approve 的 actor 交给既有 commitBatch,不取系统或批次创建者', async () => {
    const finalReviewer = {
      id: 'final-reviewer',
      username: 'final-reviewer',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const batchCreator = {
      id: 'batch-creator',
      username: 'batch-creator',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const prisma = {
      ledgerPostingBatch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'batch-1',
          settlementVersionId: 'version-1',
          preparedBy: batchCreator,
        }),
      },
      settlementReviewAction: {
        findFirst: jest.fn().mockResolvedValue({ actor: finalReviewer }),
      },
    };
    const posting = {
      commitBatch: jest.fn().mockResolvedValue({
        postingBatchId: 'batch-1',
        batchStatus: 'committed',
      }),
    };
    const service = new LedgerReadyBatchCommitter(prisma as never, posting as never);

    await service.commitReadyBatch('batch-1');

    expect(prisma.settlementReviewAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          settlementVersionId: 'version-1',
          stageCode: 'final',
          actionCode: 'approve',
        },
      }),
    );
    expect(posting.commitBatch).toHaveBeenCalledWith(
      { postingBatchId: 'batch-1', operationKey: 'ledger-auto-commit:batch-1' },
      finalReviewer,
      expect.objectContaining({ ua: 'activity-batch-worker' }),
    );
    expect(posting.commitBatch).not.toHaveBeenCalledWith(
      expect.anything(),
      batchCreator,
      expect.anything(),
    );
  });

  it('没有 final approve 动作时具名拒绝,不拿 batch 字段兜底', async () => {
    const prisma = {
      ledgerPostingBatch: {
        findUnique: jest.fn().mockResolvedValue({ settlementVersionId: 'version-1' }),
      },
      settlementReviewAction: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const posting = { commitBatch: jest.fn() };
    const service = new LedgerReadyBatchCommitter(prisma as never, posting as never);

    const error = await service.commitReadyBatch('batch-1').then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz).toBe(BizCode.LEDGER_COMMIT_FINAL_APPROVER_MISSING);
    expect(posting.commitBatch).not.toHaveBeenCalled();
  });
});
