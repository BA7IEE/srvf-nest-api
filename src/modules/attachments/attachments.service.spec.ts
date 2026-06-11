import { Role, UserStatus, type AttachmentAccessLevel } from '@prisma/client';
import type { ConfigType } from '@nestjs/config';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { CosProviderUnavailableError } from '../storage/providers/cos.provider';
import type { StorageProvider } from '../storage/storage.interface';
import type { StorageSettingsService } from '../storage/storage-settings.service';
import { signUploadToken, type UploadTokenClaims } from '../storage/upload-token.util';
import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { RbacService } from '../permissions/rbac.service';
import type { AttachmentAuditRecorder } from './attachment-audit-recorder';
import type {
  ConfirmUploadDto,
  CreateAttachmentDto,
  GenerateUploadUrlDto,
  UpdateAttachmentDto,
} from './attachments.dto';
import { AttachmentsService } from './attachments.service';

// attachments service-level characterization spec(B 档 test-only,沿 srvf-god-service-refactor）。
// 锁定 `attachments.service.ts`(826L god-service)内部「编排契约」现状行为,作为后续
// Presenter / QueryService 抽离前的快速重构护栏。
//
// 风格沿 src/modules/activity-registrations/activity-registrations.service.spec.ts
//      + src/modules/audit-logs/audit-logs.service.spec.ts:
// - 纯构造器注入 mock,不使用 NestJS TestingModule、不连库、不起 Nest、不读真实配置。
// - $transaction mock 同时支持 callback(写路径)与 array(listMyUploaded)两种用法。
//
// 边界(本 spec 只到 service 编排层;不改任何业务代码 / BizCode / audit event 名):
// - 不测真实 COS / Local Provider 实现;只 mock STORAGE_PROVIDER 接口(provider 行为归 providers/*.spec + e2e)。
// - 不测真实 signed URL / headObject 内容(只断言降级与分支)。
// - 不测 AttachmentAuditRecorder 内部 snapshot 组装(只断言被调用入参;snapshot 形状归 audit-characterization e2e)。
// - 不复刻 HTTP / Guard / Prisma 集成、partial-unique / P2002 DB race、contract / OpenAPI(归 e2e / contract)。
// - 涉及 Date.now() / randomBytes()(generateAttachmentKey)用结构化断言(正则),不引 fake timers。
// - uploadToken 用真实 signUploadToken 现签(exp 设远未来,确定性),不 mock upload-token.util。

// ============ 固定 fixture ============

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const META: AuditMeta = { requestId: 'req-att-1', ip: '127.0.0.1', ua: 'jest' };
// 任意非空字符串即可(verify 端用同 key 经 scrypt 派生;HMAC 确定性)。
const TEST_ENCRYPTION_KEY = 'unit-test-storage-encryption-key-0123456789abcdef';
// year 2286;confirmUpload 用真实 Date.now() 校验 exp,设远未来避免过期。
const FAR_FUTURE_EXP = 9_999_999_999;
// 命中 attachment-validation.ts 的 ID_CARD_REGEX(/\d{17}[\dXx]/)。
const PII_ID_CARD = '11010119900307123X';

// ============ 行形(= attachmentSelect 16 字段) ============

interface AttachmentRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  key: string;
  originalName: string;
  mime: string;
  size: number;
  uploadedBy: string;
  uploadedAt: Date;
  ownerType: string;
  ownerId: string;
  description: string | null;
  accessLevel: AttachmentAccessLevel | null;
  tags: string[];
  originalUploaderName: string | null;
  expireAt: Date | null;
}

function makeAttachmentRow(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 'att-1',
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    key: 'attachments/test/2026/01/01/abc.png',
    originalName: 'photo.png',
    mime: 'image/png',
    size: 1024,
    uploadedBy: 'u1',
    uploadedAt: FIXED_DATE,
    ownerType: 'member',
    ownerId: 'mem-1',
    description: null,
    accessLevel: null,
    tags: [],
    originalUploaderName: 'uploader',
    expireAt: null,
    ...overrides,
  };
}

// attachment_type_configs 行(assertOwnerTypeAllowed / assertMimeAllowed / assertSizeAllowed 三处 select 的并集)。
function makeTypeConfig(
  overrides: {
    id?: string;
    ownerTable?: string;
    defaultMimeWhitelist?: string[];
    defaultMaxSizeBytes?: number | null;
  } = {},
) {
  return {
    id: 'tc-member',
    ownerTable: 'members',
    defaultMimeWhitelist: ['image/png', 'image/jpeg', 'application/pdf'],
    defaultMaxSizeBytes: null,
    ...overrides,
  };
}

function makeCurrentUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'u1',
    username: 'tester',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
    ...overrides,
  };
}

// ============ DTO 工厂(只填 service 实际读取的字段;结构性 cast,绕过 class-validator 装饰) ============

function makeCreateDto(overrides: Partial<Record<string, unknown>> = {}): CreateAttachmentDto {
  return {
    key: 'attachments/test/2026/01/01/abc.png',
    originalName: 'photo.png',
    mime: 'image/png',
    size: 1024,
    ownerType: 'member',
    ownerId: 'mem-1',
    description: null,
    accessLevel: null,
    tags: [],
    expireAt: null,
    ...overrides,
  } as unknown as CreateAttachmentDto;
}

function makeUpdateDto(overrides: Partial<Record<string, unknown>> = {}): UpdateAttachmentDto {
  return {
    description: 'updated',
    accessLevel: null,
    tags: [],
    expireAt: null,
    ...overrides,
  };
}

function makeUploadUrlDto(overrides: Partial<Record<string, unknown>> = {}): GenerateUploadUrlDto {
  return {
    ownerType: 'member',
    ownerId: 'mem-1',
    originalName: 'photo.png',
    mime: 'image/png',
    sizeBytes: 1024,
    ...overrides,
  };
}

function makeConfirmDto(uploadToken: string, checksum: string | null = null): ConfirmUploadDto {
  return { uploadToken, checksum } as unknown as ConfirmUploadDto;
}

function makeUploadToken(overrides: Partial<UploadTokenClaims> = {}): string {
  const claims: UploadTokenClaims = {
    key: 'attachments/test/2026/01/01/abc.png',
    ownerType: 'member',
    ownerId: 'mem-1',
    originalName: 'photo.png',
    mime: 'image/png',
    sizeBytes: 1024,
    uploadedByUserId: 'u1',
    iat: 1_700_000_000,
    exp: FAR_FUTURE_EXP,
    ...overrides,
  };
  return signUploadToken(claims, TEST_ENCRYPTION_KEY);
}

// ============ mock 工厂 ============

function makePrismaMock() {
  const attachment = {
    findFirst: jest.fn<Promise<AttachmentRow | null>, [unknown]>(),
    findMany: jest.fn<Promise<AttachmentRow[]>, [unknown]>(),
    create: jest.fn<Promise<AttachmentRow>, [unknown]>(),
    update: jest.fn<Promise<AttachmentRow>, [unknown]>(),
    delete: jest.fn<Promise<AttachmentRow>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
  };
  const attachmentTypeConfig = { findFirst: jest.fn<Promise<unknown>, [unknown]>() };
  const attachmentMimeConfig = { findFirst: jest.fn<Promise<unknown>, [unknown]>() };
  const attachmentSizeLimitConfig = { findFirst: jest.fn<Promise<unknown>, [unknown]>() };
  const member = { findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>() };
  const certificate = {
    findFirst: jest.fn<Promise<{ id: string; memberId: string } | null>, [unknown]>(),
  };
  const activity = { findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>() };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const prisma = {
    attachment,
    attachmentTypeConfig,
    attachmentMimeConfig,
    attachmentSizeLimitConfig,
    member,
    certificate,
    activity,
    $transaction,
  };
  // 双模:回调式把 prisma mock 自身当 tx 传入(service 在 tx 与 this.prisma 上调同名方法);
  // 数组式($transaction([findMany, count]))走 Promise.all。
  $transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.all(arg as Array<Promise<unknown>>),
  );
  return prisma;
}
type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeProviderMock() {
  return {
    putObject: jest.fn<Promise<unknown>, [unknown]>(),
    deleteObject: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    generateUploadUrl: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
      url: 'https://signed.example/upload',
      headers: {},
      method: 'PUT',
      expiresAt: FIXED_DATE,
    }),
    generateDownloadUrl: jest
      .fn<Promise<{ url: string }>, [unknown]>()
      .mockResolvedValue({ url: 'https://signed.example/download' }),
    headObject: jest.fn<Promise<{ exists: boolean; size?: number; etag?: string }>, [string]>(),
  };
}
type ProviderMock = ReturnType<typeof makeProviderMock>;

function makeSettingsMock() {
  // null → service 走兜底 ttl(download 300 / upload 600)与 envPrefix = cfg.env。
  return { getActiveSettings: jest.fn<Promise<unknown>, []>().mockResolvedValue(null) };
}
type SettingsMock = ReturnType<typeof makeSettingsMock>;

function makeRbacMock(canReturn = true) {
  return {
    can: jest
      .fn<Promise<boolean>, [CurrentUserPayload, string, unknown?]>()
      .mockResolvedValue(canReturn),
  };
}
type RbacMock = ReturnType<typeof makeRbacMock>;

function makeRecorderMock() {
  return {
    logUpload: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logUploadConfirmed: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logDelete: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
  };
}
type RecorderMock = ReturnType<typeof makeRecorderMock>;

function makeService(
  prisma: PrismaMock,
  opts: {
    rbac?: RbacMock;
    recorder?: RecorderMock;
    provider?: ProviderMock;
    settings?: SettingsMock;
    env?: string;
  } = {},
): AttachmentsService {
  const rbac = opts.rbac ?? makeRbacMock(true);
  const recorder = opts.recorder ?? makeRecorderMock();
  const provider = opts.provider ?? makeProviderMock();
  const settings = opts.settings ?? makeSettingsMock();
  const cfg = {
    env: opts.env ?? 'test',
    storage: { encryptionKey: TEST_ENCRYPTION_KEY },
  } as unknown as ConfigType<typeof appConfig>;
  return new AttachmentsService(
    prisma as unknown as PrismaService,
    rbac as unknown as RbacService,
    recorder as unknown as AttachmentAuditRecorder,
    provider as unknown as StorageProvider,
    settings as unknown as StorageSettingsService,
    cfg,
  );
}

describe('AttachmentsService (characterization)', () => {
  // ============ A. accessUrl 解析 / L3 降级(toResponseDto via getById) ============
  describe('accessUrl resolution (toResponseDto)', () => {
    it('provider.generateDownloadUrl 成功 → accessUrl = signed url', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow());
      const service = makeService(prisma, { provider });

      const res = await service.getById('att-1', makeCurrentUser({ memberId: 'mem-1' }));

      expect(res.accessUrl).toBe('https://signed.example/download');
    });

    it('CosProviderUnavailableError → accessUrl 降级 null(不抛凭证状态)', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      provider.generateDownloadUrl.mockRejectedValue(
        new CosProviderUnavailableError('credentials missing'),
      );
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow());
      const service = makeService(prisma, { provider });

      const res = await service.getById('att-1', makeCurrentUser({ memberId: 'mem-1' }));

      expect(res.accessUrl).toBeNull();
    });

    it('Provider 通用异常 → accessUrl 降级 null', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      provider.generateDownloadUrl.mockRejectedValue(new Error('network blip'));
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow());
      const service = makeService(prisma, { provider });

      const res = await service.getById('att-1', makeCurrentUser({ memberId: 'mem-1' }));

      expect(res.accessUrl).toBeNull();
    });
  });

  // ============ B. getById:读路径信息泄漏防御 + RBAC action/scope 拼装 ============
  describe('getById — read-path RBAC & scope assembly', () => {
    it('不存在 → 13001 ATTACHMENT_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.attachment.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.getById('missing', makeCurrentUser())).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_NOT_FOUND),
      );
    });

    it('存在但 rbac.can=false → 13001(信息泄漏防御,非 30100)', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(false);
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow());
      const service = makeService(prisma, { rbac });

      await expect(service.getById('att-1', makeCurrentUser())).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_NOT_FOUND),
      );
    });

    it('member owner + 本人 → action=attachment.view.member.self,resource={member,ownerId}', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(true);
      prisma.attachment.findFirst.mockResolvedValue(
        makeAttachmentRow({ ownerType: 'member', ownerId: 'mem-1' }),
      );
      const service = makeService(prisma, { rbac });

      await service.getById('att-1', makeCurrentUser({ memberId: 'mem-1' }));

      expect(rbac.can).toHaveBeenCalledWith(expect.anything(), 'attachment.view.member.self', {
        ownerType: 'member',
        ownerId: 'mem-1',
      });
    });

    it('activity owner → action=attachment.view.activity(无 scope 后缀),resource=undefined', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(true);
      prisma.attachment.findFirst.mockResolvedValue(
        makeAttachmentRow({ ownerType: 'activity', ownerId: 'act-1' }),
      );
      const service = makeService(prisma, { rbac });

      await service.getById('att-1', makeCurrentUser());

      expect(rbac.can).toHaveBeenCalledWith(
        expect.anything(),
        'attachment.view.activity',
        undefined,
      );
    });
  });

  // ============ C. create:校验链 fail-fast 顺序 + fail-close ============
  describe('create — validation chain (fail-fast order)', () => {
    it('未知 ownerType → 13010;不查配置表 / 不写库 / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const service = makeService(prisma, { recorder });

      await expect(
        service.create(makeCreateDto({ ownerType: 'bogus' }), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_OWNER_TYPE_INVALID));
      expect(prisma.attachmentTypeConfig.findFirst).not.toHaveBeenCalled();
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(recorder.logUpload).not.toHaveBeenCalled();
    });

    it('ownerId 不存在 → 13011;不写库', async () => {
      const prisma = makePrismaMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      prisma.member.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.create(makeCreateDto(), makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND),
      );
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('rbac.can=false → 30100 RBAC_FORBIDDEN(写路径;非 13001);不写库', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(false);
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      const service = makeService(prisma, { rbac });

      await expect(service.create(makeCreateDto(), makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.RBAC_FORBIDDEN),
      );
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('系统级黑名单 mime(application/zip)→ 13033 fail-close;不写库', async () => {
      const prisma = makePrismaMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      const service = makeService(prisma);

      await expect(
        service.create(makeCreateDto({ mime: 'application/zip' }), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('mime 不在 override 也不在 default 白名单 → 13012', async () => {
      const prisma = makePrismaMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(
        makeTypeConfig({ defaultMimeWhitelist: ['image/png'] }),
      );
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentMimeConfig.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.create(makeCreateDto({ mime: 'image/tiff' }), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_MIME_NOT_ALLOWED));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('originalName 含身份证号 → 13015 PII_DETECTED;不写库', async () => {
      const prisma = makePrismaMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentMimeConfig.findFirst.mockResolvedValue(null);
      prisma.attachmentSizeLimitConfig.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.create(
          makeCreateDto({ originalName: `scan-${PII_ID_CARD}.png` }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_PII_DETECTED));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('happy path → 事务内 create + logUpload({scope,ownerTable,tx});返 dto 带 accessUrl', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(
        makeTypeConfig({ defaultMimeWhitelist: ['image/png'], defaultMaxSizeBytes: null }),
      );
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentMimeConfig.findFirst.mockResolvedValue(null);
      prisma.attachmentSizeLimitConfig.findFirst.mockResolvedValue(null);
      prisma.attachment.create.mockResolvedValue(
        makeAttachmentRow({ ownerType: 'member', ownerId: 'mem-1' }),
      );
      const service = makeService(prisma, { recorder });

      const res = await service.create(
        makeCreateDto({ ownerType: 'member', ownerId: 'mem-1' }),
        makeCurrentUser({ memberId: 'mem-1' }),
        META,
      );

      expect(prisma.attachment.create).toHaveBeenCalledTimes(1);
      expect(recorder.logUpload).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'self', ownerTable: 'members', tx: prisma }),
      );
      expect(res.id).toBe('att-1');
      expect(res.accessUrl).toBe('https://signed.example/download');
    });
  });

  // ============ D. size 上限:override 优先于 default ============
  describe('assertSizeAllowed — override vs default', () => {
    it('size limit override 命中且超限 → 13013(override 优先)', async () => {
      const prisma = makePrismaMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(
        makeTypeConfig({ defaultMaxSizeBytes: 5000 }),
      );
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentMimeConfig.findFirst.mockResolvedValue(null);
      prisma.attachmentSizeLimitConfig.findFirst.mockResolvedValue({ maxSizeBytes: 1000 });
      const service = makeService(prisma);

      await expect(
        service.create(makeCreateDto({ size: 2000 }), makeCurrentUser({ memberId: 'mem-1' }), META),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('无 override 时走 defaultMaxSizeBytes 兜底且超限 → 13013', async () => {
      const prisma = makePrismaMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(
        makeTypeConfig({ defaultMaxSizeBytes: 1000 }),
      );
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentMimeConfig.findFirst.mockResolvedValue(null);
      prisma.attachmentSizeLimitConfig.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.create(makeCreateDto({ size: 2000 }), makeCurrentUser({ memberId: 'mem-1' }), META),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });
  });

  // ============ E. update:当前事实 = 不写 audit recorder ============
  describe('update — no audit recorder (current fact)', () => {
    it('happy → prisma.attachment.update 调用;recorder 任一 log 方法均不调用', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow({ ownerId: 'mem-1' }));
      prisma.attachment.update.mockResolvedValue(makeAttachmentRow({ description: 'updated' }));
      const service = makeService(prisma, { recorder });

      const res = await service.update(
        'att-1',
        makeUpdateDto({ description: 'updated' }),
        makeCurrentUser({ memberId: 'mem-1' }),
      );

      expect(prisma.attachment.update).toHaveBeenCalledTimes(1);
      expect(recorder.logUpload).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
      expect(recorder.logDelete).not.toHaveBeenCalled();
      expect(res.accessUrl).toBe('https://signed.example/download');
    });

    it('不存在 → 13001', async () => {
      const prisma = makePrismaMock();
      prisma.attachment.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.update('missing', makeUpdateDto(), makeCurrentUser())).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_NOT_FOUND),
      );
      expect(prisma.attachment.update).not.toHaveBeenCalled();
    });

    it('rbac.can=false → 30100(写路径);不更新', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(false);
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow());
      const service = makeService(prisma, { rbac });

      await expect(service.update('att-1', makeUpdateDto(), makeCurrentUser())).rejects.toEqual(
        new BizException(BizCode.RBAC_FORBIDDEN),
      );
      expect(prisma.attachment.update).not.toHaveBeenCalled();
    });

    it('description 含身份证号 → 13015;不更新', async () => {
      const prisma = makePrismaMock();
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow({ ownerId: 'mem-1' }));
      const service = makeService(prisma);

      await expect(
        service.update(
          'att-1',
          makeUpdateDto({ description: `备注 ${PII_ID_CARD}` }),
          makeCurrentUser({ memberId: 'mem-1' }),
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_PII_DETECTED));
      expect(prisma.attachment.update).not.toHaveBeenCalled();
    });
  });

  // ============ F. delete:owner/admin path + 事务外 best-effort provider 删除 ============
  describe('delete — owner/admin path & best-effort provider', () => {
    it('删自己上传的 → logDelete deletedByPath=owner;事务外 provider.deleteObject(key) 被调用', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const provider = makeProviderMock();
      prisma.attachment.findFirst.mockResolvedValue(
        makeAttachmentRow({ uploadedBy: 'u1', key: 'k-owner', ownerId: 'mem-1' }),
      );
      prisma.attachment.delete.mockResolvedValue(makeAttachmentRow({ key: 'k-owner' }));
      const service = makeService(prisma, { recorder, provider });

      await service.delete('att-1', makeCurrentUser({ id: 'u1', memberId: 'mem-1' }), META);

      expect(recorder.logDelete).toHaveBeenCalledWith(
        expect.objectContaining({ deletedByPath: 'owner', tx: prisma }),
      );
      expect(provider.deleteObject).toHaveBeenCalledWith('k-owner');
    });

    it('删他人上传的 → logDelete deletedByPath=admin', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow({ uploadedBy: 'u1' }));
      prisma.attachment.delete.mockResolvedValue(makeAttachmentRow());
      const service = makeService(prisma, { recorder });

      await service.delete('att-1', makeCurrentUser({ id: 'admin-9' }), META);

      expect(recorder.logDelete).toHaveBeenCalledWith(
        expect.objectContaining({ deletedByPath: 'admin' }),
      );
    });

    it('provider.deleteObject 抛错 → 仍成功返回 dto(best-effort,不回滚 / 不抛)', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      provider.deleteObject.mockRejectedValue(new Error('provider down'));
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow({ uploadedBy: 'u1' }));
      prisma.attachment.delete.mockResolvedValue(makeAttachmentRow());
      const service = makeService(prisma, { provider });

      const res = await service.delete('att-1', makeCurrentUser({ id: 'u1' }), META);

      expect(res.id).toBe('att-1');
    });

    it('不存在 → 13001;不删 / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      prisma.attachment.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, { recorder });

      await expect(service.delete('missing', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_NOT_FOUND),
      );
      expect(prisma.attachment.delete).not.toHaveBeenCalled();
      expect(recorder.logDelete).not.toHaveBeenCalled();
    });
  });

  // ============ G. confirmUpload:token / owner / headObject / size / dedup 分支 ============
  describe('confirmUpload — token / owner / headObject / size / dedup branches', () => {
    it('token 非法 → 13001(信息泄漏防御);不调 headObject', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const service = makeService(prisma, { provider });

      await expect(
        service.confirmUpload(makeConfirmDto('not-a-valid-token'), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      expect(provider.headObject).not.toHaveBeenCalled();
    });

    it('token.uploadedByUserId !== user.id → 30100;不调 headObject', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const token = makeUploadToken({ uploadedByUserId: 'someone-else' });
      const service = makeService(prisma, { provider });

      await expect(
        service.confirmUpload(makeConfirmDto(token), makeCurrentUser({ id: 'u1' }), META),
      ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
      expect(provider.headObject).not.toHaveBeenCalled();
    });

    it('headObject.exists=false → 13001;不写库', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      provider.headObject.mockResolvedValue({ exists: false });
      const service = makeService(prisma, { provider });

      await expect(
        service.confirmUpload(
          makeConfirmDto(makeUploadToken()),
          makeCurrentUser({ id: 'u1' }),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('headObject.size 与 claims.sizeBytes 不一致 → 13013;不写库', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      provider.headObject.mockResolvedValue({ exists: true, size: 2048 });
      const token = makeUploadToken({ sizeBytes: 1024 });
      const service = makeService(prisma, { provider });

      await expect(
        service.confirmUpload(makeConfirmDto(token), makeCurrentUser({ id: 'u1' }), META),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('同 key 二次提交(tx 内 findFirst 命中)→ 13001;不写库 / 不审计', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      provider.headObject.mockResolvedValue({ exists: true, size: 1024 });
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow({ id: 'dup' }));
      const service = makeService(prisma, { provider, recorder });

      await expect(
        service.confirmUpload(
          makeConfirmDto(makeUploadToken()),
          makeCurrentUser({ id: 'u1', memberId: 'mem-1' }),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
    });

    it('happy → 事务内 create + logUploadConfirmed;返 dto', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      provider.headObject.mockResolvedValue({ exists: true, size: 1024, etag: 'etag-1' });
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      prisma.attachment.findFirst.mockResolvedValue(null);
      prisma.attachment.create.mockResolvedValue(makeAttachmentRow({ ownerId: 'mem-1' }));
      const service = makeService(prisma, { provider, recorder });

      const res = await service.confirmUpload(
        makeConfirmDto(makeUploadToken(), 'sha256:abc'),
        makeCurrentUser({ id: 'u1', memberId: 'mem-1' }),
        META,
      );

      expect(prisma.attachment.create).toHaveBeenCalledTimes(1);
      expect(recorder.logUploadConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'self', ownerTable: 'members', tx: prisma }),
      );
      expect(res.id).toBe('att-1');
      expect(res.accessUrl).toBe('https://signed.example/download');
    });
  });

  // ============ H. createUploadUrl:不落库 / 不审计 ============
  describe('createUploadUrl — no persist / no audit', () => {
    it('happy → 返 key(结构化)+ uploadToken;不写库 / 不审计;provider.generateUploadUrl 调用一次', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(
        makeTypeConfig({ defaultMimeWhitelist: ['image/png'], defaultMaxSizeBytes: null }),
      );
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentMimeConfig.findFirst.mockResolvedValue(null);
      prisma.attachmentSizeLimitConfig.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, { provider, recorder, env: 'test' });

      const res = await service.createUploadUrl(
        makeUploadUrlDto({ ownerType: 'member', ownerId: 'mem-1', mime: 'image/png' }),
        makeCurrentUser({ memberId: 'mem-1' }),
      );

      // 结构化断言(key 含 Date / randomBytes;不锁具体值)
      expect(res.key).toMatch(/^attachments\/test\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);
      expect(res.uploadToken.split('.')).toHaveLength(2);
      expect(res.uploadUrl).toBe('https://signed.example/upload');
      expect(provider.generateUploadUrl).toHaveBeenCalledTimes(1);
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(recorder.logUpload).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
    });

    it('rbac.can=false → 30100;不调 provider.generateUploadUrl', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const rbac = makeRbacMock(false);
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      const service = makeService(prisma, { provider, rbac });

      await expect(service.createUploadUrl(makeUploadUrlDto(), makeCurrentUser())).rejects.toEqual(
        new BizException(BizCode.RBAC_FORBIDDEN),
      );
      expect(provider.generateUploadUrl).not.toHaveBeenCalled();
    });
  });

  // ============ I. list / listMyUploaded:逐条可见性 + me 路径不判 RBAC ============
  describe('list / listMyUploaded — visibility & no-RBAC', () => {
    it('list:逐条 ownership 过滤,total = 可见数量(不可见行不计入)', async () => {
      const prisma = makePrismaMock();
      // 仅 .self 可见(scope=self),.other 不可见。
      const rbac = makeRbacMock(true);
      rbac.can.mockImplementation((_u, action) => Promise.resolve(action.endsWith('.self')));
      prisma.attachment.findMany.mockResolvedValue([
        makeAttachmentRow({ id: 'a-self', ownerType: 'member', ownerId: 'mem-self' }),
        makeAttachmentRow({ id: 'a-other', ownerType: 'member', ownerId: 'mem-other' }),
      ]);
      const service = makeService(prisma, { rbac });

      const page = await service.list(
        { page: 1, pageSize: 20 },
        makeCurrentUser({ memberId: 'mem-self' }),
      );

      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe('a-self');
    });

    it('listMyUploaded:按 uploadedBy 过滤,且不调用 rbac.can(本人查自己豁免)', async () => {
      const prisma = makePrismaMock();
      const rbac = makeRbacMock(true);
      prisma.attachment.findMany.mockResolvedValue([makeAttachmentRow({ uploadedBy: 'u1' })]);
      prisma.attachment.count.mockResolvedValue(1);
      const service = makeService(prisma, { rbac });

      const page = await service.listMyUploaded(
        { page: 1, pageSize: 20 },
        makeCurrentUser({ id: 'u1' }),
      );

      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(rbac.can).not.toHaveBeenCalled();
      const findManyArg = prisma.attachment.findMany.mock.calls[0][0] as {
        where: { uploadedBy: string };
      };
      expect(findManyArg.where.uploadedBy).toBe('u1');
    });
  });
});
