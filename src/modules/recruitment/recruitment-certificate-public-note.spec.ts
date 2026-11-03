import { Prisma, RecruitmentCertificateClaimStatus as Status } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RecruitmentCertificateClaimsService } from './recruitment-certificate-claims.service';

const NOTE = 'SYNTHETIC_INTERNAL_APPROVAL_NOTE';
const META: AuditMeta = { requestId: 'claim-note-test', ip: '127.0.0.1', ua: 'jest' };
const CREDENTIAL = { wechatCode: 'synthetic-not-exchanged', version: 3 };

function fixture(status: Status = Status.APPROVED) {
  const standard = {
    id: 'standard-note-test',
    code: 'synthetic_standard',
    name: 'Synthetic credential',
    categoryCode: 'first_aid',
    levelCode: null,
  };
  const committed = {
    application: {
      id: 'application-note-test',
      openid: 'synthetic-owner',
      phone: null,
      deletedAt: null,
      statusCode: 'verified',
      thresholdMarks: { redCross: { at: '2026-11-01T00:00:00.000Z', by: 'system' } },
      evaluatedByUserId: null,
      evaluatedAt: null,
      evaluationNote: null,
    },
    claim: {
      id: 'claim-note-test',
      applicationId: 'application-note-test',
      version: 3,
      status,
      categoryHintCode: 'first_aid',
      rawCertificateName: 'Synthetic credential',
      suggestedStandardId: null,
      standardId: standard.id,
      recognitionPolicyId: 'policy-note-test',
      recognitionIssuerId: null,
      issuingOrg: 'Synthetic issuer',
      certNumber: null,
      issuedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiredAt: null,
      imageKeys: ['synthetic/claim-image'],
      reviewedByUserId: 'synthetic-reviewer',
      reviewedAt: new Date('2026-11-01T00:00:00.000Z'),
      reviewNote: NOTE,
      promotedAt: null,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
      suggestedStandard: null,
      standard,
    },
  };
  const draft = structuredClone(committed);
  const tx = {
    $queryRaw: jest.fn((query: Prisma.Sql) => {
      expect(query.sql).toContain('FOR NO KEY UPDATE');
      expect(query.values).toEqual([committed.application.id]);
      return Promise.resolve([{ id: draft.application.id }]);
    }),
    recruitmentApplication: {
      findFirst: jest.fn(() => Promise.resolve(structuredClone(draft.application))),
      update: jest.fn(({ data }: { data: Partial<typeof draft.application> }) => {
        Object.assign(draft.application, data);
        return Promise.resolve(structuredClone(draft.application));
      }),
    },
    recruitmentCertificateClaim: {
      findFirst: jest.fn(() => Promise.resolve(structuredClone(draft.claim))),
      update: jest.fn(({ data }: { data: { status: Status; version: { increment: number } } }) => {
        draft.claim.status = data.status;
        draft.claim.version += data.version.increment;
        return Promise.resolve(structuredClone(draft.claim));
      }),
      findMany: jest.fn(() =>
        Promise.resolve([{ status: draft.claim.status, standard: draft.claim.standard }]),
      ),
      count: jest.fn(() => Promise.resolve(1)),
    },
  };
  // Run the real service callback, ownership/version/state checks and threshold
  // derivation. This store models callback success/failure, not PostgreSQL locks
  // or a real COMMIT; there is no PrismaClient or database connection here.
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      Object.assign(committed, structuredClone(draft));
      return result;
    }),
  };
  const identity = {
    resolveActiveApplicationByCredential: jest.fn(() =>
      Promise.resolve({ app: structuredClone(committed.application), channel: 'wechat' as const }),
    ),
  };
  const audit = { log: jest.fn(() => Promise.resolve()) };
  const external = jest.fn(() => {
    throw new Error('External provider forbidden in claim note regression');
  });
  const service = new RecruitmentCertificateClaimsService(
    prisma as never,
    {} as never,
    audit as never,
    {} as never,
    identity as never,
    {} as never,
    { putObject: external, deleteObject: external, generateDownloadUrl: external } as never,
    { sign: external } as never,
  );
  return { service, committed, draft, tx, prisma, identity, audit, external };
}

describe('certificate claim public reviewNote boundary', () => {
  it('real withdrawPublic hides an approval note while preserving history and transactional work', async () => {
    const f = fixture();
    const result = await f.service.withdrawPublic(f.committed.claim.id, CREDENTIAL, META);

    expect(result.claim.status).toBe(Status.WITHDRAWN);
    expect(result.claim.version).toBe(4);
    expect(result.claim.reviewNote).toBeNull();
    expect(result.claimCount).toBe(1);
    expect(result.claim).not.toHaveProperty('imageKeys');
    expect(f.committed.claim).toMatchObject({
      reviewNote: NOTE,
      reviewedByUserId: 'synthetic-reviewer',
      reviewedAt: new Date('2026-11-01T00:00:00.000Z'),
      status: Status.WITHDRAWN,
    });
    expect(f.identity.resolveActiveApplicationByCredential).toHaveBeenCalledWith(CREDENTIAL);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(f.tx.recruitmentCertificateClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: Status.WITHDRAWN, version: { increment: 1 } },
      }),
    );
    expect(f.committed.application.thresholdMarks).toEqual({});
    expect(f.tx.recruitmentApplication.update).toHaveBeenCalledTimes(1);
    expect(f.audit.log).toHaveBeenCalledTimes(2);
    for (const [input] of f.audit.log.mock.calls as unknown as Array<[{ tx: unknown }]>) {
      expect(input.tx).toBe(f.tx);
    }
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain(NOTE);
    expect(f.external).not.toHaveBeenCalled();
  });

  // Exercise the actual private projection as a contract matrix; do not invent
  // an impossible database return status for the real withdrawal above.
  it.each([
    [Status.REJECTED, NOTE],
    [Status.NEEDS_INFO, NOTE],
    [Status.SUBMITTED, null],
    [Status.APPROVED, null],
    [Status.PROMOTED, null],
    [Status.WITHDRAWN, null],
  ])('%s exposes only applicant-action feedback', (status, expected) => {
    const f = fixture(status);
    expect(f.service['presentPublic'](f.committed.claim).reviewNote).toBe(expected);
    expect(f.committed.claim.reviewNote).toBe(NOTE);
    expect(f.external).not.toHaveBeenCalled();
  });

  it.each([
    [
      'another application',
      (f: ReturnType<typeof fixture>) => (f.draft.claim.applicationId = 'other'),
    ],
    [
      'changed owner after lock',
      (f: ReturnType<typeof fixture>) => (f.draft.application.openid = 'other'),
    ],
  ])('%s is still refused before mutation', async (_name, change) => {
    const f = fixture();
    change(f);
    await expect(
      f.service.withdrawPublic(f.committed.claim.id, CREDENTIAL, META),
    ).rejects.toMatchObject({
      biz:
        _name === 'another application'
          ? BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND
          : BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    });
    expect(f.tx.recruitmentCertificateClaim.update).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
    expect(f.external).not.toHaveBeenCalled();
  });

  it('stale version is still refused before mutation', async () => {
    const f = fixture();
    await expect(
      f.service.withdrawPublic(f.committed.claim.id, { ...CREDENTIAL, version: 2 }, META),
    ).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_CERTIFICATE_CLAIM_VERSION_CONFLICT });
    expect(f.tx.recruitmentCertificateClaim.update).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });

  it.each([Status.WITHDRAWN, Status.PROMOTED])('%s remains terminal', async (status) => {
    const f = fixture(status);
    await expect(
      f.service.withdrawPublic(f.committed.claim.id, CREDENTIAL, META),
    ).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID });
    expect(f.tx.recruitmentCertificateClaim.update).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });
});
