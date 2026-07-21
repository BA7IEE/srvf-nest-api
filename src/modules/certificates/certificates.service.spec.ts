import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthzService } from '../authz/authz.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { RbacService } from '../permissions/rbac.service';
import type {
  CreateCertificateDto,
  RejectCertificateDto,
  UpdateCertificateDto,
  VerifyCertificateDto,
} from './certificates.dto';
import { CertificatesService } from './certificates.service';

// certificates service-level characterization spec(B 档 test-only,scoped;沿 srvf-god-service-refactor）。
// 锁定 `certificates.service.ts`(556L,L 体量)内部「编排契约」现状行为,作为后续
// Presenter / QueryService 抽离前的快速重构护栏。
//
// 风格沿 src/modules/activities/activities.service.spec.ts
//      + src/modules/attendances/attendances.service.spec.ts:
// - 纯构造器注入 mock,不使用 NestJS TestingModule、不连库、不起 Nest。
// - certificates 仅用回调式 `$transaction`(create / update / softDelete / verify / reject);
//   mock 把 prisma 自身当 tx 传入(service 在 tx 与 this.prisma 上调同名方法)。
//
// 边界(本 spec 只到 service 编排层;不改任何业务代码 / BizCode / audit event 名):
// - **不**断言 `toCertSnapshot` 内部 before/after 快照结构(Date→ISO 等细节);只断言
//   `auditLogs.log` 被调用 + event 名 + tx 接线(snapshot 归 certificates-audit-characterization e2e)。
// - 读审计只锁 event/resource/extra 与 fail-closed 编排,不复刻 AuditLogsService 内部写库。
// - **不**复刻字典校验内部查询(mock `dictItem.findFirst` 返回值即可)。
// - **不**测深事务 happy-path 全链(完整状态流 / 真实库写入归 certificates*.e2e)。
// - **不**测 `app-my-certificates.service.ts`(App 视角独立类,非本 service)。

// ============ 固定 fixture ============

// normalizeDateOnly 已规范化后的颁发日(纯日期语义,UTC 00:00:00)。
const FIXED_ISSUED = new Date('2026-03-15T00:00:00.000Z');
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const META: AuditMeta = { requestId: 'req-cert-1', ip: '127.0.0.1', ua: 'jest' };

// 状态字典 code(对齐 certificates.service.ts 内部常量;4 态闭集中的 3 个写入态)。
const CERT_STATUS_PENDING = 'pending';
const CERT_STATUS_VERIFIED = 'verified';
const CERT_STATUS_REJECTED = 'rejected';

// ============ 行形(= certificateSafeSelect 16 字段;list select 为其子集) ============

interface CertRow {
  id: string;
  memberId: string;
  certTypeCode: string;
  certSubTypeCode: string | null;
  issuingOrg: string;
  certNumber: string | null;
  issuedAt: Date;
  expiredAt: Date | null;
  certStatusCode: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  verifyNote: string | null;
  isInternal: boolean;
  supersededByCertId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeCertRow(overrides: Partial<CertRow> = {}): CertRow {
  return {
    id: 'cert-1',
    memberId: 'mem-1',
    certTypeCode: 'cert_first_aid',
    certSubTypeCode: null,
    issuingOrg: 'Red Cross',
    certNumber: null,
    issuedAt: FIXED_ISSUED,
    expiredAt: null,
    certStatusCode: CERT_STATUS_PENDING,
    verifiedBy: null,
    verifiedAt: null,
    verifyNote: null,
    isInternal: false,
    supersededByCertId: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

function makeCurrentUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'admin-1',
    username: 'admin',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
    ...overrides,
  };
}

// ============ DTO 工厂(只填 service 实际读取的字段;结构性 cast) ============

function makeCreateDto(overrides: Partial<Record<string, unknown>> = {}): CreateCertificateDto {
  return {
    certTypeCode: 'cert_first_aid',
    issuingOrg: 'Red Cross',
    issuedAt: '2026-03-15T10:30:00.000Z', // 带时间分量;normalizeDateOnly 应抹平到 00:00:00
    ...overrides,
  };
}

function makeUpdateDto(overrides: Partial<Record<string, unknown>> = {}): UpdateCertificateDto {
  return { ...overrides };
}

function makeVerifyDto(verifyNote?: string): VerifyCertificateDto {
  return verifyNote === undefined ? {} : { verifyNote };
}

function makeRejectDto(verifyNote = 'rejected reason'): RejectCertificateDto {
  return { verifyNote };
}

// ============ mock 工厂 ============

function makePrismaMock() {
  const member = { findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>() };
  const certificate = {
    findFirst: jest.fn<Promise<CertRow | null>, [unknown]>(),
    findMany: jest.fn<Promise<CertRow[]>, [unknown]>(),
    create: jest.fn<Promise<CertRow>, [unknown]>(),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 1 }),
    update: jest.fn<Promise<CertRow>, [unknown]>(),
  };
  const dictItem = { findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>() };
  const user = { findFirst: jest.fn<Promise<{ memberId: string | null } | null>, [unknown]>() };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const $queryRaw = jest.fn().mockResolvedValue([{ id: 'cert-1' }]);
  const prisma = { member, certificate, dictItem, user, $queryRaw, $transaction };
  // certificates 仅回调式:把 prisma mock 自身当 tx 传入(helper 内 `tx ?? this.prisma` 同源)。
  $transaction.mockImplementation((arg: unknown) =>
    (arg as (tx: typeof prisma) => Promise<unknown>)(prisma),
  );
  return prisma;
}
type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeAuditLogsMock() {
  return { log: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined) };
}
type AuditLogsMock = ReturnType<typeof makeAuditLogsMock>;

// Slow-4 T2(2026-06-11,评审稿 D-S4-6):service 构造函数注入 rbac mock,`can` 恒 true
// (本 spec 锁业务行为而非判权;判权矩阵由 e2e 权限边界 spec 锁定)。断言零修改。
function makeRbacMock() {
  return { can: jest.fn<Promise<boolean>, [unknown, string]>().mockResolvedValue(true) };
}

function makeAuthzMock() {
  return { explain: jest.fn().mockResolvedValue({ allow: true, reason: 'matched' }) };
}

function makeService(
  prisma: PrismaMock,
  opts: { auditLogs?: AuditLogsMock } = {},
): CertificatesService {
  const auditLogs = opts.auditLogs ?? makeAuditLogsMock();
  return new CertificatesService(
    prisma as unknown as PrismaService,
    auditLogs as unknown as AuditLogsService,
    makeRbacMock() as unknown as RbacService,
    makeAuthzMock() as unknown as AuthzService,
  );
}

describe('CertificatesService (characterization, scoped)', () => {
  // ============ 1. read paths — list / findOne ============
  describe('read paths — list / findOne', () => {
    it('findOne → 安全字段透传(含 certNumber / verifiedBy / verifyNote)', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({
          id: 'cert-1',
          memberId: 'mem-1',
          certStatusCode: CERT_STATUS_VERIFIED,
          certNumber: 'CN-1',
          verifiedBy: 'mem-9',
          verifyNote: 'ok',
        }),
      );
      const service = makeService(prisma, { auditLogs });

      const res = await service.findOne('mem-1', 'cert-1', makeCurrentUser(), META);

      expect(res.id).toBe('cert-1');
      expect(res.certStatusCode).toBe(CERT_STATUS_VERIFIED);
      expect(res.certNumber).toBe('CN-1');
      expect(res.verifiedBy).toBe('mem-9');
      expect(res.verifyNote).toBe('ok');
      expect(auditLogs.log).toHaveBeenCalledWith({
        event: 'certificate.read.other',
        actorUserId: 'admin-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'certificate',
        resourceId: 'cert-1',
        meta: META,
        extra: { operation: 'detail' },
      });
    });

    it('findOne:查询完成后审计失败原样上抛,调用方拿不到 DTO', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      const auditError = new Error('certificate detail audit unavailable');
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(makeCertRow());
      auditLogs.log.mockRejectedValue(auditError);
      const service = makeService(prisma, { auditLogs });
      let receivedDto: unknown;

      await expect(
        service.findOne('mem-1', 'cert-1', makeCurrentUser(), META).then((dto) => {
          receivedDto = dto;
          return dto;
        }),
      ).rejects.toBe(auditError);

      expect(prisma.certificate.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.certificate.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        auditLogs.log.mock.invocationCallOrder[0],
      );
      expect(receivedDto).toBeUndefined();
    });

    it('findOne 不存在 → CERTIFICATE_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.findOne('mem-1', 'missing', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.CERTIFICATE_NOT_FOUND),
      );
    });

    it('findOne 跨 member(cert.memberId ≠ :memberId)→ CERTIFICATE_NOT_BELONGS_TO_MEMBER', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(makeCertRow({ memberId: 'mem-OTHER' }));
      const service = makeService(prisma);

      await expect(service.findOne('mem-1', 'cert-1', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER),
      );
    });

    it('findOne:member 不存在 → MEMBER_NOT_FOUND;不查 certificate', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.findOne('missing', 'cert-1', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.MEMBER_NOT_FOUND),
      );
      expect(prisma.certificate.findFirst).not.toHaveBeenCalled();
    });

    it('list → where{memberId, deletedAt:null};orderBy[status asc, createdAt desc];返回 items', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findMany.mockResolvedValue([
        makeCertRow({ id: 'cert-1' }),
        makeCertRow({ id: 'cert-2' }),
      ]);
      const service = makeService(prisma, { auditLogs });

      const items = await service.list('mem-1', makeCurrentUser(), META);

      expect(items).toHaveLength(2);
      const findManyArg = prisma.certificate.findMany.mock.calls[0][0] as {
        where: { memberId: string; deletedAt: null };
        orderBy: unknown;
      };
      expect(findManyArg.where.memberId).toBe('mem-1');
      expect(findManyArg.where.deletedAt).toBeNull();
      expect(findManyArg.orderBy).toEqual([{ certStatusCode: 'asc' }, { createdAt: 'desc' }]);
      expect(auditLogs.log).toHaveBeenCalledWith({
        event: 'certificate.read.other',
        actorUserId: 'admin-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'member',
        resourceId: 'mem-1',
        meta: META,
        extra: { operation: 'list', count: 2 },
      });
      expect(prisma.certificate.findMany.mock.invocationCallOrder[0]).toBeLessThan(
        auditLogs.log.mock.invocationCallOrder[0],
      );
    });

    it('list:member 不存在 → MEMBER_NOT_FOUND;不查 certificate', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.list('missing', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.MEMBER_NOT_FOUND),
      );
      expect(prisma.certificate.findMany).not.toHaveBeenCalled();
    });

    it('list:审计失败直接上抛,不返回敏感读取结果', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findMany.mockResolvedValue([makeCertRow()]);
      auditLogs.log.mockRejectedValue(new Error('audit unavailable'));
      const service = makeService(prisma, { auditLogs });

      await expect(service.list('mem-1', makeCurrentUser(), META)).rejects.toThrow(
        'audit unavailable',
      );
    });
  });

  // ============ 2. create — validation chain & audit wiring ============
  describe('create — validation chain & audit wiring', () => {
    it('member 不存在 → MEMBER_NOT_FOUND;不 create / 不审计', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, { auditLogs });

      await expect(
        service.create('missing', makeCreateDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.MEMBER_NOT_FOUND));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('certTypeCode 无效 → CERTIFICATE_TYPE_CODE_INVALID;不 create', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.create('mem-1', makeCreateDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_TYPE_CODE_INVALID));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
    });

    it('certSubTypeCode 提供且无效 → CERTIFICATE_SUB_TYPE_CODE_INVALID;不 create', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      // 第 1 次 dictItem.findFirst(cert_type)通过;第 2 次(cert_sub_type)null。
      prisma.dictItem.findFirst
        .mockResolvedValueOnce({ id: 'di-type' })
        .mockResolvedValueOnce(null);
      const service = makeService(prisma);

      await expect(
        service.create(
          'mem-1',
          makeCreateDto({ certSubTypeCode: 'sub-x' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
    });

    it('happy → create(certStatusCode=pending, isInternal=false);issuedAt 抹平到 00:00:00;audit 接线', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.certificate.create.mockResolvedValue(
        makeCertRow({ id: 'cert-new', certStatusCode: CERT_STATUS_PENDING }),
      );
      const service = makeService(prisma, { auditLogs });

      const res = await service.create(
        'mem-1',
        makeCreateDto({ issuedAt: '2026-03-15T10:30:00.000Z' }),
        makeCurrentUser({ id: 'admin-1' }),
        META,
      );

      expect(prisma.certificate.create).toHaveBeenCalledTimes(1);
      const createArg = prisma.certificate.create.mock.calls[0][0] as {
        data: { memberId: string; certStatusCode: string; isInternal: boolean; issuedAt: Date };
      };
      expect(createArg.data.memberId).toBe('mem-1');
      expect(createArg.data.certStatusCode).toBe(CERT_STATUS_PENDING);
      expect(createArg.data.isInternal).toBe(false);
      expect(createArg.data.issuedAt).toEqual(new Date('2026-03-15T00:00:00.000Z'));
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'certificate.create',
          actorUserId: 'admin-1',
          resourceType: 'certificate',
          resourceId: 'cert-new',
          tx: prisma,
        }),
      );
      expect(res.id).toBe('cert-new');
    });

    it('optional 字段(certSubTypeCode / certNumber / expiredAt)透传进 create data;expiredAt 抹平', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.certificate.create.mockResolvedValue(makeCertRow({ id: 'cert-new' }));
      const service = makeService(prisma);

      await service.create(
        'mem-1',
        makeCreateDto({
          certSubTypeCode: 'sub-1',
          certNumber: 'CN-9',
          expiredAt: '2027-01-01T08:00:00.000Z',
        }),
        makeCurrentUser(),
        META,
      );

      const createArg = prisma.certificate.create.mock.calls[0][0] as {
        data: { certSubTypeCode?: string; certNumber?: string; expiredAt?: Date };
      };
      expect(createArg.data.certSubTypeCode).toBe('sub-1');
      expect(createArg.data.certNumber).toBe('CN-9');
      expect(createArg.data.expiredAt).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    });
  });

  // ============ 3. update — ownership & audit wiring ============
  describe('update — ownership & audit wiring', () => {
    it('跨 member → CERTIFICATE_NOT_BELONGS_TO_MEMBER;不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(makeCertRow({ memberId: 'mem-OTHER' }));
      const service = makeService(prisma, { auditLogs });

      await expect(
        service.update(
          'mem-1',
          'cert-1',
          makeUpdateDto({ issuingOrg: 'X' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER));
      expect(prisma.certificate.update).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('不存在 → CERTIFICATE_NOT_FOUND;不 update', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.update(
          'mem-1',
          'missing',
          makeUpdateDto({ issuingOrg: 'X' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_NOT_FOUND));
      expect(prisma.certificate.update).not.toHaveBeenCalled();
    });

    it('certTypeCode 提供且无效 → CERTIFICATE_TYPE_CODE_INVALID;不 update', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(makeCertRow({ memberId: 'mem-1' }));
      prisma.dictItem.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.update(
          'mem-1',
          'cert-1',
          makeUpdateDto({ certTypeCode: 'bad' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_TYPE_CODE_INVALID));
      expect(prisma.certificate.update).not.toHaveBeenCalled();
    });

    it('happy → update 透传字段;audit event=certificate.update + tx', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      const observed = makeCertRow({
        id: 'cert-1',
        memberId: 'mem-1',
        issuingOrg: 'stale-before-lock',
      });
      const locked = makeCertRow({
        id: 'cert-1',
        memberId: 'mem-1',
        issuingOrg: 'locked-authoritative',
      });
      prisma.certificate.findFirst.mockResolvedValueOnce(observed).mockResolvedValueOnce(locked);
      prisma.certificate.update.mockResolvedValue(
        makeCertRow({ id: 'cert-1', memberId: 'mem-1', issuingOrg: 'New Org' }),
      );
      const service = makeService(prisma, { auditLogs });

      const res = await service.update(
        'mem-1',
        'cert-1',
        makeUpdateDto({ issuingOrg: 'New Org' }),
        makeCurrentUser(),
        META,
      );

      expect(prisma.certificate.update).toHaveBeenCalledTimes(1);
      const updateArg = prisma.certificate.update.mock.calls[0][0] as {
        data: { issuingOrg?: string };
      };
      expect(updateArg.data.issuingOrg).toBe('New Org');
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'certificate.update',
          resourceId: 'cert-1',
          tx: prisma,
        }),
      );
      const auditArg = auditLogs.log.mock.calls[0][0] as {
        before: { issuingOrg: string };
      };
      expect(auditArg.before.issuingOrg).toBe('locked-authoritative');
      expect(res.issuingOrg).toBe('New Org');
    });
  });

  // ============ 4. softDelete — audit wiring(独立 certificate.delete 事件) ============
  describe('softDelete — audit wiring', () => {
    it('happy → update{deletedAt:Date};audit event=certificate.delete;extra.priorStatusCode', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ id: 'cert-1', memberId: 'mem-1', certStatusCode: CERT_STATUS_VERIFIED }),
      );
      prisma.certificate.update.mockResolvedValue(makeCertRow({ id: 'cert-1', memberId: 'mem-1' }));
      const service = makeService(prisma, { auditLogs });

      await service.softDelete('mem-1', 'cert-1', makeCurrentUser(), META);

      const updateArg = prisma.certificate.update.mock.calls[0][0] as {
        data: { deletedAt: unknown };
      };
      expect(updateArg.data.deletedAt).toBeInstanceOf(Date);
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'certificate.delete',
          resourceId: 'cert-1',
          tx: prisma,
        }),
      );
      const logArg = auditLogs.log.mock.calls[0][0] as { extra: { priorStatusCode: string } };
      expect(logArg.extra.priorStatusCode).toBe(CERT_STATUS_VERIFIED);
    });

    it('不存在 → CERTIFICATE_NOT_FOUND;不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, { auditLogs });

      await expect(service.softDelete('mem-1', 'missing', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.CERTIFICATE_NOT_FOUND),
      );
      expect(prisma.certificate.update).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });
  });

  // ============ 5. verify / reject — state gate & verifiedBy wiring ============
  describe('verify / reject — state gate & verifiedBy wiring', () => {
    it('verify 非 pending → CERTIFICATE_INVALID_STATE_TRANSITION;不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ memberId: 'mem-1', certStatusCode: CERT_STATUS_VERIFIED }),
      );
      const service = makeService(prisma, { auditLogs });

      await expect(
        service.verify('mem-1', 'cert-1', makeVerifyDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_INVALID_STATE_TRANSITION));
      expect(prisma.certificate.update).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('verify pending → update{verified, verifiedBy=user.memberId, verifyNote};audit=certificate.verify', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ id: 'cert-1', memberId: 'mem-1', certStatusCode: CERT_STATUS_PENDING }),
      );
      prisma.user.findFirst.mockResolvedValue({ memberId: 'verifier-mem' });
      prisma.certificate.update.mockResolvedValue(
        makeCertRow({ id: 'cert-1', memberId: 'mem-1', certStatusCode: CERT_STATUS_VERIFIED }),
      );
      const service = makeService(prisma, { auditLogs });

      const res = await service.verify(
        'mem-1',
        'cert-1',
        makeVerifyDto('looks good'),
        makeCurrentUser(),
        META,
      );

      const updateArg = prisma.certificate.update.mock.calls[0][0] as {
        data: { certStatusCode: string; verifiedBy: string | null; verifyNote: string | null };
      };
      expect(updateArg.data.certStatusCode).toBe(CERT_STATUS_VERIFIED);
      expect(updateArg.data.verifiedBy).toBe('verifier-mem');
      expect(updateArg.data.verifyNote).toBe('looks good');
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'certificate.verify',
          before: { status: CERT_STATUS_PENDING },
          tx: prisma,
        }),
      );
      expect(prisma.certificate.findFirst).toHaveBeenCalledTimes(1);
      expect(res.certStatusCode).toBe(CERT_STATUS_VERIFIED);
    });

    it('verify:user 无 memberId → verifiedBy=null;verifyNote 缺省 → null', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ memberId: 'mem-1', certStatusCode: CERT_STATUS_PENDING }),
      );
      prisma.user.findFirst.mockResolvedValue({ memberId: null });
      prisma.certificate.update.mockResolvedValue(
        makeCertRow({ memberId: 'mem-1', certStatusCode: CERT_STATUS_VERIFIED }),
      );
      const service = makeService(prisma);

      await service.verify('mem-1', 'cert-1', makeVerifyDto(), makeCurrentUser(), META);

      const updateArg = prisma.certificate.update.mock.calls[0][0] as {
        data: { verifiedBy: string | null; verifyNote: string | null };
      };
      expect(updateArg.data.verifiedBy).toBeNull();
      expect(updateArg.data.verifyNote).toBeNull();
    });

    it('reject 非 pending → CERTIFICATE_INVALID_STATE_TRANSITION;不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ memberId: 'mem-1', certStatusCode: CERT_STATUS_REJECTED }),
      );
      const service = makeService(prisma, { auditLogs });

      await expect(
        service.reject('mem-1', 'cert-1', makeRejectDto('nope'), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_INVALID_STATE_TRANSITION));
      expect(prisma.certificate.update).not.toHaveBeenCalled();
      expect(auditLogs.log).not.toHaveBeenCalled();
    });

    it('reject pending → update{rejected, verifyNote=dto.verifyNote};audit=certificate.reject', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ id: 'cert-1', memberId: 'mem-1', certStatusCode: CERT_STATUS_PENDING }),
      );
      prisma.user.findFirst.mockResolvedValue({ memberId: 'verifier-mem' });
      prisma.certificate.update.mockResolvedValue(
        makeCertRow({ id: 'cert-1', memberId: 'mem-1', certStatusCode: CERT_STATUS_REJECTED }),
      );
      const service = makeService(prisma, { auditLogs });

      const res = await service.reject(
        'mem-1',
        'cert-1',
        makeRejectDto('insufficient evidence'),
        makeCurrentUser(),
        META,
      );

      const updateArg = prisma.certificate.update.mock.calls[0][0] as {
        data: { certStatusCode: string; verifiedBy: string | null; verifyNote: string | null };
      };
      expect(updateArg.data.certStatusCode).toBe(CERT_STATUS_REJECTED);
      expect(updateArg.data.verifiedBy).toBe('verifier-mem');
      expect(updateArg.data.verifyNote).toBe('insufficient evidence');
      expect(auditLogs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'certificate.reject',
          before: { status: CERT_STATUS_PENDING },
          tx: prisma,
        }),
      );
      expect(prisma.certificate.findFirst).toHaveBeenCalledTimes(1);
      expect(res.certStatusCode).toBe(CERT_STATUS_REJECTED);
    });
  });

  // ============ 6. isQualified — shallow ============
  describe('isQualified — shallow', () => {
    it('certTypeCode 无效 → CERTIFICATE_TYPE_CODE_INVALID', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.isQualified('mem-1', 'cert_unknown', makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_TYPE_CODE_INVALID));
    });

    it('命中 verified + 未过期 → qualified=true;where 锁 certStatusCode=verified', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.certificate.findFirst.mockResolvedValue(makeCertRow({ id: 'cert-1' }));
      const service = makeService(prisma, { auditLogs });

      const res = await service.isQualified('mem-1', 'cert_first_aid', makeCurrentUser(), META);

      expect(res.qualified).toBe(true);
      expect(res.memberId).toBe('mem-1');
      expect(res.certTypeCode).toBe('cert_first_aid');
      const findFirstArg = prisma.certificate.findFirst.mock.calls[0][0] as {
        where: { memberId: string; certTypeCode: string; certStatusCode: string };
      };
      expect(findFirstArg.where.certStatusCode).toBe(CERT_STATUS_VERIFIED);
      expect(findFirstArg.where.memberId).toBe('mem-1');
      expect(findFirstArg.where.certTypeCode).toBe('cert_first_aid');
      expect(auditLogs.log).toHaveBeenCalledWith({
        event: 'certificate.read.qualification-flag',
        actorUserId: 'admin-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'member',
        resourceId: 'mem-1',
        meta: META,
        extra: { operation: 'qualification-flag', filterFields: ['certTypeCode'] },
      });
      const auditInput = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(auditInput.extra).not.toHaveProperty('certTypeCode');
      expect(auditInput.extra).not.toHaveProperty('qualified');
    });

    it('无命中 → qualified=false', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.certificate.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      const res = await service.isQualified('mem-1', 'cert_first_aid', makeCurrentUser(), META);

      expect(res.qualified).toBe(false);
    });

    it('member 不存在 → MEMBER_NOT_FOUND;不校验字典 / 不查 certificate', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.isQualified('missing', 'cert_first_aid', makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.MEMBER_NOT_FOUND));
      expect(prisma.dictItem.findFirst).not.toHaveBeenCalled();
      expect(prisma.certificate.findFirst).not.toHaveBeenCalled();
    });
  });
});
