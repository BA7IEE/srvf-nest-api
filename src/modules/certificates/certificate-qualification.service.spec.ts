import type { PrismaService } from '../../database/prisma.service';
import {
  CertificateQualificationService,
  type CertificateQualificationFacts,
} from './certificate-qualification.service';

function makeService(rows: unknown[][]): {
  service: CertificateQualificationService;
  queryRaw: jest.Mock;
} {
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve(rows.shift() ?? [])),
  };
  return {
    service: new CertificateQualificationService(prisma as unknown as PrismaService),
    queryRaw: prisma.$queryRaw,
  };
}

describe('CertificateQualificationService', () => {
  it('projects the verified certificates that cover the complete activity interval', async () => {
    const { service } = makeService([
      [
        {
          id: 'cert-b',
          standardId: 'standard-b',
          issuedAt: new Date('2099-10-31T00:00:00.000Z'),
          expiredAt: null,
        },
        {
          id: 'cert-a',
          standardId: 'standard-a',
          issuedAt: new Date('2099-01-01T00:00:00.000Z'),
          expiredAt: new Date('2099-12-31T00:00:00.000Z'),
        },
      ],
    ]);

    await expect(
      service.readCoveringFacts('member-1', {
        startAt: new Date('2099-11-01T08:00:00.000Z'),
        endAt: new Date('2099-11-03T18:00:00.000Z'),
      }),
    ).resolves.toEqual({
      coveringCertificates: [
        {
          certificateId: 'cert-b',
          standardId: 'standard-b',
          issuedAt: new Date('2099-10-31T00:00:00.000Z'),
          expiredAt: null,
        },
        {
          certificateId: 'cert-a',
          standardId: 'standard-a',
          issuedAt: new Date('2099-01-01T00:00:00.000Z'),
          expiredAt: new Date('2099-12-31T00:00:00.000Z'),
        },
      ],
      coveringStandardIds: ['standard-a', 'standard-b'],
    });
  });

  it('keeps standard arrays as OR, not an accidental all-of requirement', () => {
    const { service } = makeService([]);
    const facts: CertificateQualificationFacts = {
      coveringCertificates: [],
      coveringStandardIds: ['standard-b'],
    };

    expect(service.hasAnyCoveringStandard(facts, ['standard-a', 'standard-b'])).toBe(true);
    expect(service.hasAnyCoveringStandard(facts, ['standard-a', 'standard-c'])).toBe(false);
  });

  it('binds the activity Beijing end day as the certificate coverage boundary', async () => {
    const { service, queryRaw } = makeService([[]]);

    await service.readCoveringFacts('member-1', {
      startAt: new Date('2099-11-01T00:00:00.000Z'),
      endAt: new Date('2099-11-03T00:00:00.000Z'),
    });

    const calls = queryRaw.mock.calls as unknown as Array<[{ values: unknown[] }]>;
    const statement = calls[0]?.[0];
    expect(statement?.values).toEqual([
      'member-1',
      new Date('2099-11-01T00:00:00.000Z'),
      new Date('2099-11-03T00:00:00.000Z'),
    ]);
  });
});
