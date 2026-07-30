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
import { CertificateRecognitionResolver } from './certificate-recognition-resolver';
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
// - 一般只锁 `auditLogs.log` 的 event 与 tx 接线；隐私边界额外锁定 certNumber 掩码、
//   verifyNote 布尔摘要及 API 返回不变，完整真实库快照归 certificates audit e2e。
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
  issuingOrg: string;
  certNumber: string | null;
  issuedAt: Date;
  expiredAt: Date | null;
  certStatusCode: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  verifyNote: string | null;
  supersededByCertId: string | null;
  // 证书标准库 PR-4b:证据判定改看 sourceClaim.imageKeys(§13.5),
  // 实例侧 imageKeys 已 DROP;presenter 仍把整个 sourceClaim 从出参剥掉。
  sourceClaim: { imageKeys: string[] | null } | null;
  // 证书标准库 PR-4a-3:标准化事实四列(与 certificateSafeSelect 同步)。
  standardId: string | null;
  recognitionPolicyId: string | null;
  recognitionIssuerId: string | null;
  sourceCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeCertRow(overrides: Partial<CertRow> = {}): CertRow {
  return {
    id: 'cert-1',
    memberId: 'mem-1',
    issuingOrg: 'Red Cross',
    certNumber: null,
    issuedAt: FIXED_ISSUED,
    expiredAt: null,
    certStatusCode: CERT_STATUS_PENDING,
    verifiedBy: null,
    verifiedAt: null,
    verifyNote: null,
    supersededByCertId: null,
    sourceClaim: null,
    // 证书标准库 PR-4a-3:标准化事实四列。夹具默认给全 —— update 的
    // 「沿已锁定 policyId 校验」需要 recognitionPolicyId 作基准,缺它会拒改(18035)。
    standardId: 'std-1',
    recognitionPolicyId: 'pol-1',
    recognitionIssuerId: null,
    sourceCode: 'ADMIN',
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

// 证书标准库 PR-4a-3:入参从「字典 code + 自由文本机构」改为「Standard id + 按规则的机构」。
// `issuedAt` 也从「带时间分量、由 normalizeDateOnly 抹平」改为**纯日期**
// (PR-1 已在契约层收紧到 10 位;Resolver 的入参契约同样是纯日期)。
function makeCreateDto(overrides: Partial<Record<string, unknown>> = {}): CreateCertificateDto {
  return {
    standardId: 'std-1',
    issuingOrg: 'Red Cross', // 默认夹具用 FREE_TEXT 规则
    issuedAt: '2026-03-15',
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
  // 证书标准库 PR-4a-3:建证 / 改证经 CertificateRecognitionResolver 解析认定规则。
  // 这里注入**真实 Resolver**(它是零依赖纯类)+ 三张表的 mock,而不是打桩 Resolver ——
  // 打桩会让「机构 / 编号 / 日期按规则校验」这条在本 spec 里彻底测不到。
  // 默认夹具:ACTIVE CREDENTIAL Standard + FREE_TEXT / EXPLICIT_OPTIONAL / OPTIONAL 规则
  // (最宽松,让既有用例的断言逐字不变)。
  const certificateStandard = {
    findFirst: jest.fn<Promise<Record<string, unknown> | null>, [unknown]>().mockResolvedValue({
      id: 'std-1',
      kind: 'CREDENTIAL',
      status: 'ACTIVE',
      categoryCode: 'cert_first_aid',
    }),
  };
  const certificateRecognitionPolicy = {
    findFirst: jest.fn<Promise<Record<string, unknown> | null>, [unknown]>().mockResolvedValue({
      id: 'pol-1',
      standardId: 'std-1',
      issuerPolicy: 'FREE_TEXT',
      validityMode: 'EXPLICIT_OPTIONAL',
      validityMonths: null,
      certNumberMode: 'OPTIONAL',
    }),
  };
  const certificateRecognitionIssuer = {
    findFirst: jest
      .fn<Promise<Record<string, unknown> | null>, [unknown]>()
      .mockResolvedValue(null),
    findMany: jest.fn<Promise<Record<string, unknown>[]>, [unknown]>().mockResolvedValue([]),
  };
  const user = { findFirst: jest.fn<Promise<{ memberId: string | null } | null>, [unknown]>() };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const $queryRaw = jest.fn().mockResolvedValue([{ id: 'cert-1' }]);
  const prisma = {
    member,
    certificate,
    dictItem,
    user,
    certificateStandard,
    certificateRecognitionPolicy,
    certificateRecognitionIssuer,
    $queryRaw,
    $transaction,
  };
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
  return {
    explain: jest.fn().mockResolvedValue({ allow: true, reason: 'matched' }),
    can: jest.fn<Promise<boolean>, [unknown, string, unknown]>().mockResolvedValue(true),
  };
}
type AuthzMock = ReturnType<typeof makeAuthzMock>;

function makeService(
  prisma: PrismaMock,
  opts: { auditLogs?: AuditLogsMock; authz?: AuthzMock } = {},
): CertificatesService {
  const auditLogs = opts.auditLogs ?? makeAuditLogsMock();
  return new CertificatesService(
    prisma as unknown as PrismaService,
    auditLogs as unknown as AuditLogsService,
    makeRbacMock() as unknown as RbacService,
    (opts.authz ?? makeAuthzMock()) as unknown as AuthzService,
    new CertificateRecognitionResolver(),
    // PR-5:evidence-urls 用的 storage / attachments。本 spec 不测该端点
    // (它要真 attachments 判权链,行为锁在 e2e),故给空桩。
    {} as never,
    {} as never,
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
      // authz mock 恒 allow → 视为持有 certificate.read.sensitive,明文出参(§15.3)。
      expect(res.certNumberFull).toBe('CN-1');
      // maskIdentifier 对 ≤4 字符整体掩去(不暴露任何原字符),故 'CN-1' → '****'。
      expect(res.certNumberMasked).toBe('****');
      expect(res.verifiedBy).toBe('mem-9');
      expect(res.verifyNote).toBe('ok');
      expect(auditLogs.log).toHaveBeenCalledWith({
        event: 'certificate.read.other',
        actorUserId: 'admin-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'certificate',
        resourceId: 'cert-1',
        meta: META,
        // PR-1 §15.3:读审计增记 maskLevel(本次给了明文还是掩码),便于事后追
        // 「谁看过完整编号」;编号本身仍不入审计(§15.6)。
        extra: { operation: 'detail', maskLevel: 'plain' },
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

    it('standardId 指向证书族(FAMILY)→ 18012;不 create', async () => {
      // PR-4a-3:入参不再有字典 code,所以「字典 code 无效」这一格换成
      // 「Standard 本身不可持有」——D-CERT-003:FAMILY 是目录节点,不是可持有证书。
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificateStandard.findFirst.mockResolvedValue({
        id: 'std-1',
        kind: 'FAMILY',
        status: 'ACTIVE',
        categoryCode: 'cert_first_aid',
      });
      const service = makeService(prisma);

      await expect(
        service.create('mem-1', makeCreateDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_STANDARD_KIND_INVALID));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
    });

    it('standardId 未启用(DRAFT)→ 18031;不 create', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificateStandard.findFirst.mockResolvedValue({
        id: 'std-1',
        kind: 'CREDENTIAL',
        status: 'DRAFT',
        categoryCode: 'cert_first_aid',
      });
      const service = makeService(prisma);

      await expect(
        service.create('mem-1', makeCreateDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_STANDARD_INACTIVE));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
    });

    it('§11.2 已收录但无生效认定规则 → 18035;不 create(「待认定」≠「已认可」)', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificateRecognitionPolicy.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.create('mem-1', makeCreateDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_ACTIVE_POLICY_MISSING));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
    });

    it('happy → 写 standardId/policyId/sourceCode=ADMIN + pending;**旧四列停写**;audit 接线', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.create.mockResolvedValue(
        makeCertRow({
          id: 'cert-new',
          certNumber: 'CN-2026-SECRET-0001',
          certStatusCode: CERT_STATUS_PENDING,
        }),
      );
      const service = makeService(prisma, { auditLogs });

      const res = await service.create(
        'mem-1',
        makeCreateDto({ issuedAt: '2026-03-15' }),
        makeCurrentUser({ id: 'admin-1' }),
        META,
      );

      expect(prisma.certificate.create).toHaveBeenCalledTimes(1);
      const createArg = prisma.certificate.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArg.data.memberId).toBe('mem-1');
      expect(createArg.data.certStatusCode).toBe(CERT_STATUS_PENDING);
      // §9.1 步骤 7:标准化四列落库。
      expect(createArg.data.standardId).toBe('std-1');
      expect(createArg.data.recognitionPolicyId).toBe('pol-1');
      expect(createArg.data.sourceCode).toBe('ADMIN');
      // FREE_TEXT 规则 → issuerId 为 null,机构名取自由文本。
      expect(createArg.data.recognitionIssuerId).toBeNull();
      expect(createArg.data.issuingOrg).toBe('Red Cross');
      // PR-4b:四个重复事实列已 DROP —— 连过渡期的 certTypeCode 回填也没了。
      // 断言它们**根本不出现在 data 里**(不是写 null):这四个 key 一旦重现,
      // 就说明有人又在实例侧复制了 Standard 的属性(§6 数据权威表明令禁止)。
      expect(createArg.data).not.toHaveProperty('certTypeCode');
      expect(createArg.data).not.toHaveProperty('certSubTypeCode');
      expect(createArg.data).not.toHaveProperty('isInternal');
      expect(createArg.data).not.toHaveProperty('imageKeys');
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
      const auditArg = auditLogs.log.mock.calls[0][0] as { after: Record<string, unknown> };
      expect(auditArg.after).toEqual(
        expect.objectContaining({
          certNumber: 'CN****01',
          verifyNoteProvided: false,
          verifyNoteChanged: false,
        }),
      );
      expect(auditArg.after).not.toHaveProperty('verifyNote');
      expect(res.id).toBe('cert-new');
      expect(res.certNumberFull).toBe('CN-2026-SECRET-0001');
    });

    it('ALLOWLIST 规则:issuerId 必须属于本规则,机构名取 issuer 快照;编号与到期日按规则落库', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificateRecognitionPolicy.findFirst.mockResolvedValue({
        id: 'pol-1',
        standardId: 'std-1',
        issuerPolicy: 'ALLOWLIST',
        validityMode: 'EXPLICIT_OPTIONAL',
        validityMonths: null,
        certNumberMode: 'OPTIONAL',
      });
      prisma.certificateRecognitionIssuer.findFirst.mockResolvedValue({
        id: 'iss-1',
        name: '深圳市红十字会',
      });
      prisma.certificate.create.mockResolvedValue(makeCertRow({ id: 'cert-new' }));
      const service = makeService(prisma);

      await service.create(
        'mem-1',
        makeCreateDto({
          issuingOrg: undefined, // ALLOWLIST 不得传自由文本
          recognitionIssuerId: 'iss-1',
          certNumber: 'CN-9',
          expiredAt: '2027-01-01',
        }),
        makeCurrentUser(),
        META,
      );

      const createArg = prisma.certificate.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArg.data.recognitionIssuerId).toBe('iss-1');
      // §5.6:实例存机构**名称快照**,而不是只存 issuer 引用。
      expect(createArg.data.issuingOrg).toBe('深圳市红十字会');
      expect(createArg.data.certNumber).toBe('CN-9');
      expect(createArg.data.expiredAt).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    });

    it('ALLOWLIST 规则下 issuerId 不属于本规则 → 18014;不 create', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificateRecognitionPolicy.findFirst.mockResolvedValue({
        id: 'pol-1',
        standardId: 'std-1',
        issuerPolicy: 'ALLOWLIST',
        validityMode: 'EXPLICIT_OPTIONAL',
        validityMonths: null,
        certNumberMode: 'OPTIONAL',
      });
      prisma.certificateRecognitionIssuer.findFirst.mockResolvedValue(null); // 查不到 = 不属于本规则
      const service = makeService(prisma);

      await expect(
        service.create(
          'mem-1',
          makeCreateDto({ issuingOrg: undefined, recognitionIssuerId: 'iss-foreign' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_ISSUER_NOT_ALLOWED));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
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

    it('§9.2 非 pending 改 standardId → 18033;pending 可改(纠正选错的标准)', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ memberId: 'mem-1', certStatusCode: 'verified' }),
      );
      const service = makeService(prisma);

      await expect(
        service.update(
          'mem-1',
          'cert-1',
          makeUpdateDto({ standardId: 'std-2' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_STANDARD_IMMUTABLE));
      expect(prisma.certificate.update).not.toHaveBeenCalled();

      // pending 态可改:重选当前 ACTIVE Policy 并完整重校验。
      const pendingPrisma = makePrismaMock();
      pendingPrisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      pendingPrisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ memberId: 'mem-1', certStatusCode: CERT_STATUS_PENDING }),
      );
      pendingPrisma.certificateStandard.findFirst.mockResolvedValue({
        id: 'std-2',
        kind: 'CREDENTIAL',
        status: 'ACTIVE',
        categoryCode: 'cert_bsafe',
      });
      pendingPrisma.certificateRecognitionPolicy.findFirst.mockResolvedValue({
        id: 'pol-2',
        standardId: 'std-2',
        issuerPolicy: 'FREE_TEXT',
        validityMode: 'EXPLICIT_OPTIONAL',
        validityMonths: null,
        certNumberMode: 'OPTIONAL',
      });
      pendingPrisma.certificate.update.mockResolvedValue(makeCertRow({ standardId: 'std-2' }));
      const pendingService = makeService(pendingPrisma);

      await pendingService.update(
        'mem-1',
        'cert-1',
        makeUpdateDto({ standardId: 'std-2', issuingOrg: 'Red Cross' }),
        makeCurrentUser(),
        META,
      );
      const arg = pendingPrisma.certificate.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(arg.data.standardId).toBe('std-2');
      // 换标准就换规则:policyId 跟着重选。PR-4b 起不再有 certTypeCode 回填。
      expect(arg.data.recognitionPolicyId).toBe('pol-2');
      expect(arg.data).not.toHaveProperty('certTypeCode');
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
        certNumber: 'CN-2026-SECRET-0001',
        certStatusCode: CERT_STATUS_VERIFIED,
        verifyNote: 'private old verification note',
      });
      prisma.certificate.findFirst.mockResolvedValueOnce(observed).mockResolvedValueOnce(locked);
      prisma.certificate.update.mockResolvedValue(
        makeCertRow({
          id: 'cert-1',
          memberId: 'mem-1',
          issuingOrg: 'New Org',
          certNumber: 'NEW-CERT-SECRET-0002',
          certStatusCode: CERT_STATUS_PENDING,
          verifyNote: null,
        }),
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
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(auditArg.before.issuingOrg).toBe('locked-authoritative');
      expect(auditArg.before).toEqual(
        expect.objectContaining({
          certNumber: 'CN****01',
          verifyNoteProvided: true,
          verifyNoteChanged: false,
        }),
      );
      expect(auditArg.after).toEqual(
        expect.objectContaining({
          certNumber: 'NE****02',
          verifyNoteProvided: false,
          verifyNoteChanged: true,
        }),
      );
      expect(auditArg.before).not.toHaveProperty('verifyNote');
      expect(auditArg.after).not.toHaveProperty('verifyNote');
      const serializedAudit = JSON.stringify(auditArg);
      expect(serializedAudit).not.toContain('CN-2026-SECRET-0001');
      expect(serializedAudit).not.toContain('NEW-CERT-SECRET-0002');
      expect(serializedAudit).not.toContain('private old verification note');
      expect(res.issuingOrg).toBe('New Org');
      expect(res.certNumberFull).toBe('NEW-CERT-SECRET-0002');
    });
  });

  // ============ 4. softDelete — audit wiring(独立 certificate.delete 事件) ============
  describe('softDelete — audit wiring', () => {
    it('happy → update{deletedAt:Date};audit event=certificate.delete;extra.priorStatusCode', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({
          id: 'cert-1',
          memberId: 'mem-1',
          certNumber: 'DELETE-SECRET-0003',
          certStatusCode: CERT_STATUS_VERIFIED,
          verifyNote: 'private deletion note',
        }),
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
      const logArg = auditLogs.log.mock.calls[0][0] as {
        before: Record<string, unknown>;
        extra: { priorStatusCode: string };
      };
      expect(logArg.extra.priorStatusCode).toBe(CERT_STATUS_VERIFIED);
      expect(logArg.before).toEqual(
        expect.objectContaining({
          certNumber: 'DE****03',
          verifyNoteProvided: true,
          verifyNoteChanged: false,
        }),
      );
      expect(logArg.before).not.toHaveProperty('verifyNote');
      expect(JSON.stringify(logArg)).not.toContain('private deletion note');
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
        makeCertRow({
          id: 'cert-1',
          memberId: 'mem-1',
          certStatusCode: CERT_STATUS_VERIFIED,
          verifyNote: 'looks good',
        }),
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
          before: {
            status: CERT_STATUS_PENDING,
            verifyNoteProvided: false,
            verifyNoteChanged: false,
          },
          after: {
            status: CERT_STATUS_VERIFIED,
            verifyNoteProvided: true,
            verifyNoteChanged: true,
          },
          tx: prisma,
        }),
      );
      expect(JSON.stringify(auditLogs.log.mock.calls)).not.toContain('looks good');
      expect(prisma.certificate.findFirst).toHaveBeenCalledTimes(1);
      expect(res.certStatusCode).toBe(CERT_STATUS_VERIFIED);
      expect(res.verifyNote).toBe('looks good');
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
        makeCertRow({
          id: 'cert-1',
          memberId: 'mem-1',
          certStatusCode: CERT_STATUS_REJECTED,
          verifyNote: 'insufficient evidence',
        }),
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
          before: {
            status: CERT_STATUS_PENDING,
            verifyNoteProvided: false,
            verifyNoteChanged: false,
          },
          after: {
            status: CERT_STATUS_REJECTED,
            verifyNoteProvided: true,
            verifyNoteChanged: true,
          },
          tx: prisma,
        }),
      );
      expect(JSON.stringify(auditLogs.log.mock.calls)).not.toContain('insufficient evidence');
      expect(prisma.certificate.findFirst).toHaveBeenCalledTimes(1);
      expect(res.certStatusCode).toBe(CERT_STATUS_REJECTED);
      expect(res.verifyNote).toBe('insufficient evidence');
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
        where: {
          memberId: string;
          certTypeCode?: string;
          standard?: { categoryCode: string };
          certStatusCode: string;
        };
      };
      expect(findFirstArg.where.certStatusCode).toBe(CERT_STATUS_VERIFIED);
      expect(findFirstArg.where.memberId).toBe('mem-1');
      // PR-4b:类别过滤经关联走 standard.categoryCode(实例侧 certTypeCode 已 DROP)。
      // 正向断言新落点 + 反向断言旧 key 不再出现 —— 后者是本刀最险的一格:
      // `notDeletedWhere(...)` 入参是宽类型,旧写法删列后**仍能编译**,
      // 只会在真实查询时炸。少了这条反向断言,回退到旧写法不会红。
      expect(findFirstArg.where.standard).toEqual({ categoryCode: 'cert_first_aid' });
      expect(findFirstArg.where).not.toHaveProperty('certTypeCode');
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

  // ============ 7. 证书标准库 PR-1 · 冻结稿 §15.3 敏感分级 ============
  //
  // 入口码仍是 `certificate.read.record`;`certificate.read.sensitive` 只决定
  // 同一次响应给明文还是掩码(无权是降级,不是 403)。
  //
  // 必须逐条钉住**泄露方向**:无权时 certNumberFull / verifyNote / verifiedBy 恒 null,
  // 且 imageKeys 原值绝不出现在出参任何角落(D-CERT-024)。
  describe('§15.3 敏感分级 — certificate.read.sensitive', () => {
    // 无敏感权限的 authz:explain 恒 allow(入口码过),can 恒 false(明文闸关)。
    function makeNonSensitiveAuthz(): AuthzMock {
      return {
        explain: jest.fn().mockResolvedValue({ allow: true, reason: 'matched' }),
        can: jest.fn<Promise<boolean>, [unknown, string, unknown]>().mockResolvedValue(false),
      };
    }

    function primeFindOne(prisma: PrismaMock): void {
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({
          certNumber: 'SZ-2026-SECRET-0001',
          verifyNote: 'private reviewer note',
          verifiedBy: 'mem-reviewer-9',
          sourceClaim: { imageKeys: ['certificates/abc.jpg', 'certificates/def.jpg'] },
          certStatusCode: CERT_STATUS_VERIFIED,
        }),
      );
    }

    it('无 read.sensitive:编号只给掩码,明文/备注/审核人恒 null', async () => {
      const prisma = makePrismaMock();
      primeFindOne(prisma);
      const service = makeService(prisma, { authz: makeNonSensitiveAuthz() });

      const res = await service.findOne('mem-1', 'cert-1', makeCurrentUser(), META);

      expect(res.certNumberMasked).toBe('SZ****01');
      expect(res.certNumberFull).toBeNull();
      expect(res.verifyNote).toBeNull();
      expect(res.verifiedBy).toBeNull();
    });

    it('持 read.sensitive:明文编号 + 备注 + 审核人 id 都给', async () => {
      const prisma = makePrismaMock();
      primeFindOne(prisma);
      const service = makeService(prisma);

      const res = await service.findOne('mem-1', 'cert-1', makeCurrentUser(), META);

      expect(res.certNumberFull).toBe('SZ-2026-SECRET-0001');
      expect(res.certNumberMasked).toBe('SZ****01');
      expect(res.verifyNote).toBe('private reviewer note');
      expect(res.verifiedBy).toBe('mem-reviewer-9');
    });

    it('明文闸按 certificate ref 判权(不是全局裸开)', async () => {
      const prisma = makePrismaMock();
      primeFindOne(prisma);
      const authz = makeNonSensitiveAuthz();
      const service = makeService(prisma, { authz });

      await service.findOne('mem-1', 'cert-1', makeCurrentUser(), META);

      expect(authz.can).toHaveBeenCalledWith(expect.anything(), 'certificate.read.sensitive', {
        type: 'certificate',
        id: 'cert-1',
      });
    });

    it('imageKeys 原值绝不进出参;只暴露 evidenceAvailable 布尔', async () => {
      const prisma = makePrismaMock();
      primeFindOne(prisma);
      const service = makeService(prisma);

      const res = await service.findOne('mem-1', 'cert-1', makeCurrentUser(), META);

      expect(res).not.toHaveProperty('imageKeys');
      expect(res.evidenceAvailable).toBe(true);
      // 整体序列化兜底:任何 key 片段都不得出现(哪怕将来新增字段无意带出)。
      expect(JSON.stringify(res)).not.toContain('certificates/abc.jpg');
    });

    it('无证据图 → evidenceAvailable=false(空数组与 null 同解)', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ sourceClaim: { imageKeys: [] } }),
      );
      const service = makeService(prisma);

      const res = await service.findOne('mem-1', 'cert-1', makeCurrentUser(), META);
      expect(res.evidenceAvailable).toBe(false);
    });

    it('出参永不含 certNumber 原字段名(防前端回写陷阱的结构保证)', async () => {
      const prisma = makePrismaMock();
      primeFindOne(prisma);
      const service = makeService(prisma);

      const res = await service.findOne('mem-1', 'cert-1', makeCurrentUser(), META);
      expect(res).not.toHaveProperty('certNumber');
    });

    it('读审计记 maskLevel 分级但不记编号本身(§15.6)', async () => {
      const prisma = makePrismaMock();
      const auditLogs = makeAuditLogsMock();
      primeFindOne(prisma);
      const service = makeService(prisma, { auditLogs, authz: makeNonSensitiveAuthz() });

      await service.findOne('mem-1', 'cert-1', makeCurrentUser(), META);

      const auditArg = auditLogs.log.mock.calls[0][0] as { extra: Record<string, unknown> };
      expect(auditArg.extra.maskLevel).toBe('masked');
      expect(JSON.stringify(auditArg)).not.toContain('SZ-2026-SECRET-0001');
      expect(JSON.stringify(auditArg)).not.toContain('certificates/abc.jpg');
    });

    it('写回显同样分级:verify 回显在无权时不漏明文', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ certStatusCode: CERT_STATUS_PENDING }),
      );
      prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-admin' });
      prisma.certificate.update.mockResolvedValue(
        makeCertRow({
          certStatusCode: CERT_STATUS_VERIFIED,
          certNumber: 'SZ-2026-SECRET-0001',
          verifyNote: 'ok',
          verifiedBy: 'mem-admin',
        }),
      );
      const service = makeService(prisma, { authz: makeNonSensitiveAuthz() });

      const res = await service.verify(
        'mem-1',
        'cert-1',
        makeVerifyDto('ok'),
        makeCurrentUser(),
        META,
      );

      expect(res.certNumberFull).toBeNull();
      expect(res.certNumberMasked).toBe('SZ****01');
      expect(res.verifyNote).toBeNull();
      expect(res.verifiedBy).toBeNull();
    });
  });

  // ============ 8. 证书标准库 PR-1 · 冻结稿 §10 日期语义 ============
  //
  // §10.1 定死 `expiredAt` = **最后有效日**;§10.5 由此要求有效资质判定为
  //   status=verified AND deletedAt IS NULL AND (expiredAt IS NULL OR expiredAt >= today)
  // 其中 today = 北京日历日。
  //
  // 修正前本 service 用 `expiredAt > now`(**时间戳**)。因为 date-only 归一后
  // `expiredAt` 存的是「北京日历日的 UTC 零点」,拿它和当下瞬间比,会在最后有效日的
  // 北京 08:00 之后误判为无资质 —— 该日 UTC 零点已经先于 now。窗口是每天 16/24 小时。
  describe('isQualified — §10.5 expiredAt 是最后有效日(date-only 比较)', () => {
    const REAL_NOW = Date.now;

    afterEach(() => {
      Date.now = REAL_NOW;
      jest.useRealTimers();
    });

    // 冻结北京 2026-08-01 10:00 = UTC 2026-08-01T02:00Z。
    // 该瞬间已越过 2026-08-01T00:00Z,旧 `gt: now` 会把「最后有效日=今天」判为过期。
    function freezeBeijing0801At10(): void {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-01T02:00:00.000Z'));
    }

    it('where 用 date-only 的 expiredAt >= today,不用时间戳 gt now', async () => {
      freezeBeijing0801At10();
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.certificate.findFirst.mockResolvedValue(makeCertRow({ id: 'cert-1' }));
      const service = makeService(prisma);

      await service.isQualified('mem-1', 'cert_first_aid', makeCurrentUser(), META);

      const where = (
        prisma.certificate.findFirst.mock.calls[0][0] as {
          where: { OR: Array<Record<string, unknown>> };
        }
      ).where;
      // 北京 08-01 的 date-only 基准 = 2026-08-01T00:00:00.000Z(不是 02:00 的 now)。
      expect(where.OR).toEqual([
        { expiredAt: null },
        { expiredAt: { gte: new Date('2026-08-01T00:00:00.000Z') } },
      ]);
    });

    it('北京 08:00 之后仍在最后有效日 → 基准是当天零点,不随 now 前移(旧实现在此误判)', async () => {
      freezeBeijing0801At10();
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.certificate.findFirst.mockResolvedValue(makeCertRow({ id: 'cert-1' }));
      const service = makeService(prisma);

      await service.isQualified('mem-1', 'cert_first_aid', makeCurrentUser(), META);

      const where = (
        prisma.certificate.findFirst.mock.calls[0][0] as {
          where: { OR: Array<{ expiredAt?: { gte?: Date } }> };
        }
      ).where;
      const gte = where.OR[1].expiredAt?.gte as Date;
      // 一张最后有效日 = 今天(08-01)的证书必须落在 gte 边界之内。
      expect(new Date('2026-08-01T00:00:00.000Z').getTime()).toBeGreaterThanOrEqual(gte.getTime());
      // 而最后有效日 = 昨天(07-31)的证书必须落在边界之外。
      expect(new Date('2026-07-31T00:00:00.000Z').getTime()).toBeLessThan(gte.getTime());
    });

    it('北京日界前(UTC 15:59)基准仍是当日,不提前翻到次日', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-31T15:59:59.999Z')); // 北京 07-31 23:59
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.certificate.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await service.isQualified('mem-1', 'cert_first_aid', makeCurrentUser(), META);

      const where = (
        prisma.certificate.findFirst.mock.calls[0][0] as {
          where: { OR: Array<{ expiredAt?: { gte?: Date } }> };
        }
      ).where;
      expect(where.OR[1].expiredAt?.gte).toEqual(new Date('2026-07-31T00:00:00.000Z'));
    });
  });

  // §10.3 基础校验:issuedAt <= today;expiredAt IS NULL OR expiredAt >= issuedAt。
  describe('create / update — §10.3 日期基础校验', () => {
    const REAL_NOW = Date.now;

    afterEach(() => {
      Date.now = REAL_NOW;
      jest.useRealTimers();
    });

    function freezeToday(): void {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-01T02:00:00.000Z')); // 北京 08-01
    }

    function primeCreate(prisma: PrismaMock): void {
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.certificate.create.mockResolvedValue(makeCertRow());
    }

    it('create:issuedAt 晚于今天 → CERTIFICATE_ISSUED_AT_IN_FUTURE;零写入', async () => {
      freezeToday();
      const prisma = makePrismaMock();
      primeCreate(prisma);
      const service = makeService(prisma);

      await expect(
        service.create('mem-1', makeCreateDto({ issuedAt: '2026-08-02' }), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_ISSUED_AT_IN_FUTURE));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
    });

    it('create:issuedAt = 今天 → 放行(边界含当天)', async () => {
      freezeToday();
      const prisma = makePrismaMock();
      primeCreate(prisma);
      const service = makeService(prisma);

      await service.create(
        'mem-1',
        makeCreateDto({ issuedAt: '2026-08-01' }),
        makeCurrentUser(),
        META,
      );
      expect(prisma.certificate.create).toHaveBeenCalled();
    });

    it('create:expiredAt 早于 issuedAt → CERTIFICATE_DATE_RANGE_INVALID;零写入', async () => {
      freezeToday();
      const prisma = makePrismaMock();
      primeCreate(prisma);
      const service = makeService(prisma);

      await expect(
        service.create(
          'mem-1',
          makeCreateDto({ issuedAt: '2026-07-01', expiredAt: '2026-06-30' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_DATE_RANGE_INVALID));
      expect(prisma.certificate.create).not.toHaveBeenCalled();
    });

    it('create:expiredAt = issuedAt → 放行(同日发证当日到期,最后有效日语义合法)', async () => {
      freezeToday();
      const prisma = makePrismaMock();
      primeCreate(prisma);
      const service = makeService(prisma);

      await service.create(
        'mem-1',
        makeCreateDto({ issuedAt: '2026-07-01', expiredAt: '2026-07-01' }),
        makeCurrentUser(),
        META,
      );
      expect(prisma.certificate.create).toHaveBeenCalled();
    });

    it('update:只改 expiredAt 也要与库内 issuedAt 比较(不是只在同时传两个时才校验)', async () => {
      freezeToday();
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({ issuedAt: new Date('2026-07-01T00:00:00.000Z') }),
      );
      const service = makeService(prisma);

      await expect(
        service.update(
          'mem-1',
          'cert-1',
          makeUpdateDto({ expiredAt: '2026-06-30' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CERTIFICATE_DATE_RANGE_INVALID));
      expect(prisma.certificate.update).not.toHaveBeenCalled();
    });

    it('update:expiredAt 最终值变化 → 清空 expireNotifyDueAt(§9.2 重置提醒标记)', async () => {
      freezeToday();
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({
          issuedAt: new Date('2026-07-01T00:00:00.000Z'),
          expiredAt: new Date('2026-09-01T00:00:00.000Z'),
        }),
      );
      prisma.certificate.update.mockResolvedValue(makeCertRow());
      const service = makeService(prisma);

      await service.update(
        'mem-1',
        'cert-1',
        makeUpdateDto({ expiredAt: '2026-10-01' }),
        makeCurrentUser(),
        META,
      );

      const data = (prisma.certificate.update.mock.calls[0][0] as { data: Record<string, unknown> })
        .data;
      expect(data.expireNotifyDueAt).toBeNull();
    });

    it('update:expiredAt 传入但与库内相同 → 不清空 expireNotifyDueAt(未变化不重置)', async () => {
      freezeToday();
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.certificate.findFirst.mockResolvedValue(
        makeCertRow({
          issuedAt: new Date('2026-07-01T00:00:00.000Z'),
          expiredAt: new Date('2026-09-01T00:00:00.000Z'),
        }),
      );
      prisma.certificate.update.mockResolvedValue(makeCertRow());
      const service = makeService(prisma);

      await service.update(
        'mem-1',
        'cert-1',
        makeUpdateDto({ expiredAt: '2026-09-01' }),
        makeCurrentUser(),
        META,
      );

      const data = (prisma.certificate.update.mock.calls[0][0] as { data: Record<string, unknown> })
        .data;
      expect(data).not.toHaveProperty('expireNotifyDueAt');
    });
  });
});
