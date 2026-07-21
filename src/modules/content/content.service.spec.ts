import { Role, UserStatus, type Content } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { RbacService } from '../permissions/rbac.service';
import { ContentService } from './content.service';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const META = { requestId: 'content-storage-unit', ip: null, ua: null };
const USER: CurrentUserPayload = {
  id: 'content-admin',
  username: 'content-admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function content(overrides: Partial<Content> = {}): Content {
  return {
    id: 'content-1',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    title: 'Content',
    summary: null,
    body: '![a](attachment:attbody1) ![again](attachment:attbody1)',
    contentTypeCode: 'announcement',
    statusCode: 'draft',
    visibilityCode: 'public',
    visibleOrganizationIds: [],
    tags: [],
    coverImageKey: 'attachments/content/cover.png',
    coverAttachmentId: 'attcover1',
    viewCount: 0,
    pinned: false,
    publishedAt: null,
    authorUserId: USER.id,
    ...overrides,
  };
}

function harness(rows: Content[]) {
  const order: string[] = [];
  let rowIndex = 0;
  let lockIndex = 0;
  const updateMock = jest.fn(() => {
    order.push('update');
    return Promise.resolve(content({ statusCode: 'published', publishedAt: NOW }));
  });
  const tx = {
    $queryRaw: jest.fn(() => {
      order.push(`lock-${++lockIndex}`);
      return Promise.resolve([{ id: 'content-1' }]);
    }),
    content: {
      findFirst: jest.fn(() => {
        order.push(`reread-${rowIndex + 1}`);
        const row = rows[Math.min(rowIndex, rows.length - 1)] ?? null;
        rowIndex += 1;
        return Promise.resolve(row);
      }),
      update: updateMock,
    },
  };
  const transactionMock = jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  const prisma = {
    $transaction: transactionMock,
  } as unknown as PrismaService;
  const rbac = {
    can: jest.fn(() => Promise.resolve(true)),
  } as unknown as RbacService;
  const auditLogMock = jest.fn(() => {
    order.push('audit');
    return Promise.resolve();
  });
  const auditLogs = {
    log: auditLogMock,
  } as unknown as AuditLogsService;
  const attachments = {
    lockContentPublishStorageBoundaryTrusted: jest.fn(() => {
      order.push('publish-boundary');
      return Promise.resolve();
    }),
    guardContentUploadConfirm: jest.fn(() => {
      order.push('guard');
      return Promise.resolve({ stage: 'guarded' });
    }),
    prepareContentUploadConfirmInTransactionTrusted: jest.fn(() => {
      order.push('prepare');
      return Promise.resolve({ stage: 'prepared' });
    }),
    verifyContentUploadConfirmEvidenceOutsideTransaction: jest.fn(() => {
      order.push('verify');
      return Promise.resolve({ stage: 'verified' });
    }),
    finalizeContentUploadConfirmInTransactionTrusted: jest.fn(() => {
      order.push('finalize');
      return Promise.resolve({ stage: 'finalized' });
    }),
    resolveContentUploadConfirmResponseTrusted: jest.fn(() => {
      order.push('resolve');
      return Promise.resolve({ id: 'attachment-1' });
    }),
    confirmUpload: jest.fn(),
    listOwnerAttachmentsTrusted: jest.fn(() => Promise.resolve([])),
    resolveSignedUrlTrusted: jest.fn(() => Promise.resolve(null)),
  } as unknown as AttachmentsService;

  return {
    service: new ContentService(prisma, rbac, auditLogs, attachments),
    order,
    prisma,
    tx,
    transactionMock,
    updateMock,
    auditLogMock,
    auditLogs: auditLogs as unknown as {
      log: jest.Mock;
    },
    attachments: attachments as unknown as {
      lockContentPublishStorageBoundaryTrusted: jest.Mock;
      guardContentUploadConfirm: jest.Mock;
      prepareContentUploadConfirmInTransactionTrusted: jest.Mock;
      verifyContentUploadConfirmEvidenceOutsideTransaction: jest.Mock;
      finalizeContentUploadConfirmInTransactionTrusted: jest.Mock;
      resolveContentUploadConfirmResponseTrusted: jest.Mock;
      confirmUpload: jest.Mock;
    },
  };
}

describe('ContentService live storage boundary orchestration', () => {
  it('locks and rereads Content before publish boundary, then updates and audits in one tx', async () => {
    const h = harness([content()]);

    await h.service.publish('content-1', USER, META);

    expect(h.order.slice(0, 5)).toEqual([
      'lock-1',
      'reread-1',
      'publish-boundary',
      'update',
      'audit',
    ]);
    expect(h.attachments.lockContentPublishStorageBoundaryTrusted).toHaveBeenCalledWith(h.tx, {
      contentId: 'content-1',
      referencedAttachmentIds: ['attbody1'],
      coverAttachmentId: 'attcover1',
      coverImageKey: 'attachments/content/cover.png',
    });
    expect(h.updateMock).toHaveBeenCalledTimes(1);
  });

  it('does not update or audit when the publish storage boundary fails closed', async () => {
    const h = harness([content()]);
    h.attachments.lockContentPublishStorageBoundaryTrusted.mockRejectedValueOnce(
      new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING),
    );

    await expect(h.service.publish('content-1', USER, META)).rejects.toEqual(
      new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING),
    );
    expect(h.tx.content.update).not.toHaveBeenCalled();
    expect(h.auditLogs.log).not.toHaveBeenCalled();
  });

  it('guards before Content, brackets Provider evidence with two root-locked transactions', async () => {
    const h = harness([content(), content()]);

    await expect(
      h.service.confirmAttachmentUpload(
        'content-1',
        { uploadToken: 'signed-token', checksum: 'checksum' },
        USER,
        META,
      ),
    ).resolves.toEqual({ id: 'attachment-1' });

    expect(h.order).toEqual([
      'guard',
      'lock-1',
      'reread-1',
      'prepare',
      'verify',
      'lock-2',
      'reread-2',
      'finalize',
      'resolve',
    ]);
    expect(h.attachments.guardContentUploadConfirm).toHaveBeenCalledWith(
      { uploadToken: 'signed-token', checksum: 'checksum' },
      USER,
      { ownerType: ['content-image', 'content-file'], ownerId: 'content-1' },
    );
    expect(h.attachments.confirmUpload).not.toHaveBeenCalled();
    expect(h.transactionMock).toHaveBeenCalledTimes(2);
  });

  it('publish winning between confirm phases blocks finalization and response with 29030', async () => {
    const h = harness([content(), content({ statusCode: 'published', publishedAt: NOW })]);

    await expect(
      h.service.confirmAttachmentUpload('content-1', { uploadToken: 'signed-token' }, USER, META),
    ).rejects.toEqual(new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION));
    expect(h.order).toEqual([
      'guard',
      'lock-1',
      'reread-1',
      'prepare',
      'verify',
      'lock-2',
      'reread-2',
    ]);
    expect(h.attachments.finalizeContentUploadConfirmInTransactionTrusted).not.toHaveBeenCalled();
    expect(h.attachments.resolveContentUploadConfirmResponseTrusted).not.toHaveBeenCalled();
  });

  it('route/token guard failure performs zero Content, ledger, Provider or audit work', async () => {
    const h = harness([content()]);
    h.attachments.guardContentUploadConfirm.mockRejectedValueOnce(
      new BizException(BizCode.ATTACHMENT_NOT_FOUND),
    );

    await expect(
      h.service.confirmAttachmentUpload('content-1', { uploadToken: 'foreign-token' }, USER, META),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    expect(h.transactionMock).not.toHaveBeenCalled();
    expect(h.attachments.prepareContentUploadConfirmInTransactionTrusted).not.toHaveBeenCalled();
    expect(
      h.attachments.verifyContentUploadConfirmEvidenceOutsideTransaction,
    ).not.toHaveBeenCalled();
    expect(h.auditLogMock).not.toHaveBeenCalled();
  });
});
