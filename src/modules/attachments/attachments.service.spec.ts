import { Prisma, Role, UserStatus, type AttachmentAccessLevel } from '@prisma/client';
import type { ConfigType } from '@nestjs/config';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { CosProviderUnavailableError } from '../storage/providers/cos.provider';
import type { StorageSettingsService } from '../storage/storage-settings.service';
import type { HeadObjectResult } from '../storage/storage.types';
import { signUploadToken, type UploadTokenClaims } from '../storage/upload-token.util';
import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { RbacService } from '../permissions/rbac.service';
import type { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import type {
  ContentUploadConfirmGuard,
  FinalizeAttachmentStorageUploadInput,
} from './attachment-storage.types';
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
    key: 'attachments/test/2026/01/01/abcdefghijklmnop.png',
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

function makeDeleteReplayResponse(row: AttachmentRow = makeAttachmentRow()) {
  return {
    id: row.id,
    key: row.key,
    originalName: row.originalName,
    mime: row.mime,
    size: row.size,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt.toISOString(),
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    description: null,
    accessLevel: null,
    tags: [] as [],
    originalUploaderName: null,
    expireAt: null,
    accessUrl: null,
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
    ownerTable: 'member',
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
    key: 'attachments/test/2026/01/01/abcdefghijklmnop.png',
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
    key: 'attachments/test/2026/01/01/abcdefghijklmnop.png',
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
    findUnique: jest.fn<Promise<{ expireAt: Date | null } | null>, [unknown]>(),
    findMany: jest.fn<Promise<AttachmentRow[]>, [unknown]>(),
    create: jest.fn<Promise<AttachmentRow>, [unknown]>(),
    update: jest.fn<Promise<AttachmentRow>, [unknown]>(),
    delete: jest.fn<Promise<AttachmentRow>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
  };
  const attachmentTypeConfig = { findFirst: jest.fn<Promise<unknown>, [unknown]>() };
  const attachmentMimeConfig = { findFirst: jest.fn<Promise<unknown>, [unknown]>() };
  const attachmentSizeLimitConfig = { findFirst: jest.fn<Promise<unknown>, [unknown]>() };
  const storageObject = {
    findUnique: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
      id: 'storage-object-1',
      key: makeAttachmentRow().key,
      state: 'available',
      resourceType: 'attachment',
      resourceId: 'att-1',
      deleteRequestedAt: null,
    }),
  };
  const member = { findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>() };
  const certificate = {
    findFirst: jest.fn<Promise<{ id: string; memberId: string } | null>, [unknown]>(),
    findMany: jest.fn<Promise<Array<{ id: string; memberId: string }>>, [unknown]>(),
  };
  const activity = { findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>() };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const $queryRaw = jest
    .fn<Promise<Array<Record<string, unknown>>>, [unknown]>()
    .mockResolvedValue([{ id: 'locked-row' }]);
  const prisma = {
    attachment,
    storageObject,
    attachmentTypeConfig,
    attachmentMimeConfig,
    attachmentSizeLimitConfig,
    member,
    certificate,
    activity,
    $transaction,
    $queryRaw,
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
    headObject: jest
      .fn<Promise<{ exists: boolean; size?: number; etag?: string }>, [string]>()
      .mockResolvedValue({ exists: true, size: 1024 }),
    readObjectPrefix: jest
      .fn<Promise<Buffer>, [string, number]>()
      .mockResolvedValue(Buffer.from('89504e470d0a1a0a00000000', 'hex')),
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

function makeStorageConsistencyMock(provider: ProviderMock, recorder: RecorderMock) {
  return {
    provider,
    recorder,
    resolveDownloadUrl: jest.fn(async (key: string, expiresIn: number) => {
      try {
        return (await provider.generateDownloadUrl({ key, expiresIn })).url;
      } catch {
        return null;
      }
    }),
    filterMetadataVisible: jest.fn((rows: readonly AttachmentRow[]) => Promise.resolve([...rows])),
    isMetadataVisible: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true),
    prepareUpload: jest.fn().mockResolvedValue({
      objectId: 'storage-object-fixture',
      operationId: 'storage-operation-fixture',
      eventKey: 'storage.fixture:upload',
      requestHash: '0'.repeat(64),
      locator: {
        providerType: 'LOCAL',
        bucket: null,
        region: null,
        localNamespace: '/fixture/storage',
      },
    }),
    prepareUploadInTransaction: jest.fn().mockResolvedValue({
      objectId: 'storage-object-fixture',
      operationId: 'storage-operation-fixture',
      eventKey: 'storage.fixture:upload',
      requestHash: '0'.repeat(64),
      locator: {
        providerType: 'LOCAL',
        bucket: null,
        region: null,
        localNamespace: '/fixture/storage',
      },
    }),
    resolveUploadLocatorForTransaction: jest.fn().mockResolvedValue({
      providerType: 'LOCAL',
      bucket: null,
      region: null,
      localNamespace: '/fixture/storage',
    }),
    prepareUploadUrl: jest.fn(
      async (
        identity: { key: string; mime: string; size: number },
        _unboundExpiresAt: Date,
        expiresIn: number,
      ) =>
        provider.generateUploadUrl({
          key: identity.key,
          contentType: identity.mime,
          sizeBytes: identity.size,
          expiresIn,
        }),
    ),
    verifyUploadEvidence: jest.fn(async (identity: { key: string; mime: string; size: number }) => {
      const head = await provider.headObject(identity.key);
      if (!head.exists) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      if (identity.mime === 'image/svg+xml') {
        throw new BizException(BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED);
      }
      if (head.size !== identity.size) {
        throw new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED);
      }
      if (identity.mime === 'image/jpeg') {
        const prefix = await provider.readObjectPrefix(identity.key, 32);
        if (!prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
          throw new BizException(BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH);
        }
      }
      return head;
    }),
    finalizeUpload: jest
      .fn<Promise<AttachmentRow>, [FinalizeAttachmentStorageUploadInput, HeadObjectResult]>()
      .mockResolvedValue(makeAttachmentRow()),
    finalizeUploadInTransaction: jest
      .fn<
        Promise<AttachmentRow>,
        [Prisma.TransactionClient, FinalizeAttachmentStorageUploadInput, HeadObjectResult]
      >()
      .mockResolvedValue(makeAttachmentRow()),
    lockContentPublishBoundary: jest.fn().mockResolvedValue(undefined),
    getDeleteReplay: jest.fn().mockResolvedValue(null),
    prepareDelete: jest.fn().mockResolvedValue('storage.fixture:delete'),
    executeEventKey: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  };
}
type StorageConsistencyMock = ReturnType<typeof makeStorageConsistencyMock>;

function makeService(
  prisma: PrismaMock,
  opts: {
    rbac?: RbacMock;
    recorder?: RecorderMock;
    provider?: ProviderMock;
    storageConsistency?: StorageConsistencyMock;
    settings?: SettingsMock;
    env?: string;
  } = {},
): AttachmentsService {
  const rbac = opts.rbac ?? makeRbacMock(true);
  const recorder = opts.recorder ?? makeRecorderMock();
  const provider = opts.provider ?? makeProviderMock();
  const storageConsistency =
    opts.storageConsistency ?? makeStorageConsistencyMock(provider, recorder);
  const settings = opts.settings ?? makeSettingsMock();
  const cfg = {
    env: opts.env ?? 'test',
    storage: { encryptionKey: TEST_ENCRYPTION_KEY },
  } as unknown as ConfigType<typeof appConfig>;
  return new AttachmentsService(
    prisma as unknown as PrismaService,
    rbac as unknown as RbacService,
    storageConsistency as unknown as AttachmentStorageOrchestrator,
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

    it('expireAt 已到期 → accessUrl=null，且不取 settings / 不签 URL', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const settings = makeSettingsMock();
      prisma.attachment.findFirst.mockResolvedValue(
        makeAttachmentRow({ expireAt: new Date('2000-01-01T00:00:00.000Z') }),
      );
      const service = makeService(prisma, { provider, settings });

      const res = await service.getById('att-1', makeCurrentUser({ memberId: 'mem-1' }));

      expect(res.accessUrl).toBeNull();
      expect(settings.getActiveSettings).not.toHaveBeenCalled();
      expect(provider.generateDownloadUrl).not.toHaveBeenCalled();
    });

    it('expireAt 未来或未设置 → 正常签 URL', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      prisma.attachment.findFirst
        .mockResolvedValueOnce(makeAttachmentRow({ expireAt: new Date('2286-01-01T00:00:00Z') }))
        .mockResolvedValueOnce(makeAttachmentRow({ expireAt: null }));
      const service = makeService(prisma, { provider });

      await expect(
        service.getById('future', makeCurrentUser({ memberId: 'mem-1' })),
      ).resolves.toMatchObject({ accessUrl: 'https://signed.example/download' });
      await expect(
        service.getById('unset', makeCurrentUser({ memberId: 'mem-1' })),
      ).resolves.toMatchObject({ accessUrl: 'https://signed.example/download' });
      expect(provider.generateDownloadUrl).toHaveBeenCalledTimes(2);
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

    it('happy path → durable intent + verify + finalize({scope,ownerTable,audit});返 dto 带 accessUrl', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const provider = makeProviderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(
        makeTypeConfig({ defaultMimeWhitelist: ['image/png'], defaultMaxSizeBytes: null }),
      );
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentMimeConfig.findFirst.mockResolvedValue(null);
      prisma.attachmentSizeLimitConfig.findFirst.mockResolvedValue(null);
      prisma.attachment.create.mockResolvedValue(
        makeAttachmentRow({ ownerType: 'member', ownerId: 'mem-1' }),
      );
      storageConsistency.finalizeUpload.mockResolvedValue(
        makeAttachmentRow({ ownerType: 'member', ownerId: 'mem-1' }),
      );
      const service = makeService(prisma, { recorder, provider, storageConsistency });

      const res = await service.create(
        makeCreateDto({ ownerType: 'member', ownerId: 'mem-1' }),
        makeCurrentUser({ memberId: 'mem-1' }),
        META,
      );

      const identity = {
        key: makeCreateDto().key,
        ownerType: 'member',
        ownerId: 'mem-1',
        uploadedByUserId: 'u1',
      };
      expect(storageConsistency.prepareUpload).toHaveBeenCalledWith(
        expect.objectContaining(identity),
        'attachment_legacy',
        expect.any(Date),
      );
      expect(storageConsistency.verifyUploadEvidence).toHaveBeenCalledWith(
        expect.objectContaining(identity),
        'attachment_legacy',
      );
      expect(storageConsistency.finalizeUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: expect.objectContaining(identity) as unknown,
          requestHash: '0'.repeat(64),
          auditKind: 'legacy',
          actorRoleSnap: Role.ADMIN,
          scope: 'self',
          ownerTable: 'member',
          auditMeta: META,
        }),
        expect.objectContaining({ exists: true, size: 1024 }),
      );
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(recorder.logUpload).not.toHaveBeenCalled();
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
      prisma.attachment.findUnique.mockResolvedValue(makeAttachmentRow({ ownerId: 'mem-1' }));
      prisma.attachment.update.mockResolvedValue(makeAttachmentRow({ description: 'updated' }));
      const service = makeService(prisma, { recorder });

      const res = await service.update(
        'att-1',
        makeUpdateDto({ description: 'updated' }),
        makeCurrentUser({ memberId: 'mem-1' }),
      );

      expect(prisma.attachment.update).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
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

    it('锁内 StorageObject 已进入 delete_pending → 13034 且字段不变', async () => {
      const prisma = makePrismaMock();
      const row = makeAttachmentRow({ ownerId: 'mem-1' });
      prisma.attachment.findFirst.mockResolvedValue(row);
      prisma.attachment.findUnique.mockResolvedValue(row);
      prisma.storageObject.findUnique.mockResolvedValue({
        id: 'storage-object-1',
        key: row.key,
        state: 'delete_pending',
        resourceType: 'attachment',
        resourceId: row.id,
        deleteRequestedAt: new Date(),
      });
      const service = makeService(prisma);

      await expect(
        service.update('att-1', makeUpdateDto(), makeCurrentUser({ memberId: 'mem-1' })),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING));
      expect(prisma.attachment.update).not.toHaveBeenCalled();
    });

    it('防御性 P2025 映射为 13001，不泄露 Prisma 500', async () => {
      const prisma = makePrismaMock();
      const row = makeAttachmentRow({ ownerId: 'mem-1' });
      prisma.attachment.findFirst.mockResolvedValue(row);
      prisma.attachment.findUnique.mockResolvedValue(row);
      prisma.attachment.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('record disappeared', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );
      const service = makeService(prisma);

      await expect(
        service.update('att-1', makeUpdateDto(), makeCurrentUser({ memberId: 'mem-1' })),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    });
  });

  // ============ F. delete:durable intent + fail-closed replay ============
  describe('delete — durable intent and authorized replay', () => {
    it('删自己上传的 → 显式授权 join，执行 intent 后返回 terminal replay', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const provider = makeProviderMock();
      const row = makeAttachmentRow({ uploadedBy: 'u1', key: 'k-owner', ownerId: 'mem-1' });
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.attachment.findFirst.mockResolvedValue(row);
      storageConsistency.getDeleteReplay.mockResolvedValue({
        state: 'succeeded',
        eventKey: 'storage.fixture:delete',
        response: makeDeleteReplayResponse(row),
      });
      const service = makeService(prisma, { recorder, provider, storageConsistency });

      const result = await service.delete(
        'att-1',
        makeCurrentUser({ id: 'u1', memberId: 'mem-1' }),
        META,
      );

      expect(storageConsistency.prepareDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentId: 'att-1',
          actorUserId: 'u1',
          allowAuthorizedJoin: true,
          deletedByPath: 'owner',
          auditMeta: META,
        }),
      );
      expect(storageConsistency.executeEventKey).toHaveBeenCalledWith('storage.fixture:delete');
      expect(storageConsistency.getDeleteReplay).toHaveBeenCalledWith('att-1', 'u1', {
        allowAuthorizedJoin: true,
      });
      expect(result).toMatchObject({ id: 'att-1', accessUrl: null });
    });

    it('删他人上传的 → durable payload 标记 deletedByPath=admin', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const provider = makeProviderMock();
      const row = makeAttachmentRow({ uploadedBy: 'u1' });
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.attachment.findFirst.mockResolvedValue(row);
      storageConsistency.getDeleteReplay.mockResolvedValue({
        state: 'succeeded',
        eventKey: 'storage.fixture:delete',
        response: makeDeleteReplayResponse(row),
      });
      const service = makeService(prisma, { recorder, provider, storageConsistency });

      await service.delete('att-1', makeCurrentUser({ id: 'admin-9' }), META);

      expect(storageConsistency.prepareDelete).toHaveBeenCalledWith(
        expect.objectContaining({ deletedByPath: 'admin', allowAuthorizedJoin: true }),
      );
    });

    it('effect 未形成 terminal replay → 13034，不把 provider 不确定态伪装成成功', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.attachment.findFirst.mockResolvedValue(makeAttachmentRow({ uploadedBy: 'u1' }));
      storageConsistency.getDeleteReplay.mockResolvedValue({
        state: 'pending',
        eventKey: 'storage.fixture:delete',
        response: null,
      });
      const service = makeService(prisma, { provider, recorder, storageConsistency });

      await expect(service.delete('att-1', makeCurrentUser({ id: 'u1' }), META)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING),
      );
    });

    it('不存在且非原 actor 无 replay → 13001；不会设置 authorized join', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const provider = makeProviderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.attachment.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, { recorder, provider, storageConsistency });

      await expect(service.delete('missing', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ATTACHMENT_NOT_FOUND),
      );
      expect(storageConsistency.getDeleteReplay).toHaveBeenCalledWith('missing', 'u1');
      expect(storageConsistency.prepareDelete).not.toHaveBeenCalled();
    });
  });

  describe('trusted Content publish storage facade', () => {
    it('forwards the caller transaction without opening another tx or invoking Provider/audit', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      const service = makeService(prisma, { provider, recorder, storageConsistency });
      const input = {
        contentId: 'content-publish-1',
        referencedAttachmentIds: ['attachment-body-1'],
        coverAttachmentId: 'attachment-cover-1',
        coverImageKey: 'attachments/test/cover.png',
      } as const;

      await service.lockContentPublishStorageBoundaryTrusted(
        prisma as unknown as Prisma.TransactionClient,
        input,
      );

      expect(storageConsistency.lockContentPublishBoundary).toHaveBeenCalledWith(prisma, input);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provider.headObject).not.toHaveBeenCalled();
      expect(provider.deleteObject).not.toHaveBeenCalled();
      expect(recorder.logUpload).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
      expect(recorder.logDelete).not.toHaveBeenCalled();
    });
  });

  describe('opaque Content upload-confirm facade', () => {
    it.each(['invalid', 'expired', 'foreign', 'owner-id-mismatch', 'owner-type-mismatch'] as const)(
      '%s → exact 13001 before Content/ledger/Provider/audit',
      async (scenario) => {
        const prisma = makePrismaMock();
        const provider = makeProviderMock();
        const recorder = makeRecorderMock();
        const rbac = makeRbacMock(true);
        const storageConsistency = makeStorageConsistencyMock(provider, recorder);
        const service = makeService(prisma, { provider, recorder, rbac, storageConsistency });
        const uploadToken =
          scenario === 'invalid'
            ? 'invalid-content-upload-token'
            : makeUploadToken({
                ownerType: scenario === 'owner-type-mismatch' ? 'content-file' : 'content-image',
                ownerId: scenario === 'owner-id-mismatch' ? 'content-token-owner' : 'content-route',
                uploadedByUserId: scenario === 'foreign' ? 'foreign-uploader' : 'u1',
                ...(scenario === 'expired' ? { iat: 1_700_000_000, exp: 1_700_000_001 } : {}),
              });

        await expect(
          service.guardContentUploadConfirm({ uploadToken }, makeCurrentUser({ id: 'u1' }), {
            ownerType: 'content-image',
            ownerId: 'content-route',
          }),
        ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

        expect(rbac.can).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(storageConsistency.resolveUploadLocatorForTransaction).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUpload).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUploadInTransaction).not.toHaveBeenCalled();
        expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
        expect(storageConsistency.finalizeUpload).not.toHaveBeenCalled();
        expect(storageConsistency.finalizeUploadInTransaction).not.toHaveBeenCalled();
        expect(provider.headObject).not.toHaveBeenCalled();
        expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
      },
    );

    it.each(['content-image', 'content-file'] as const)(
      'public guard %s coarse RBAC denial → exact 404/13001/附件不存在 with zero downstream work',
      async (ownerType) => {
        const prisma = makePrismaMock();
        const provider = makeProviderMock();
        const recorder = makeRecorderMock();
        const rbac = makeRbacMock(false);
        const storageConsistency = makeStorageConsistencyMock(provider, recorder);
        const service = makeService(prisma, { provider, recorder, rbac, storageConsistency });
        const uploadToken = makeUploadToken({
          ownerType,
          ownerId: 'content-route',
          uploadedByUserId: 'u1',
        });

        const rejection = service.guardContentUploadConfirm(
          { uploadToken },
          makeCurrentUser({ id: 'u1' }),
          { ownerType, ownerId: 'content-route' },
        );
        await expect(rejection).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
        await rejection.catch((error: unknown) => {
          expect(error).toBeInstanceOf(BizException);
          expect((error as BizException).biz).toEqual({
            code: 13001,
            message: '附件不存在',
            httpStatus: 404,
          });
        });

        expect(rbac.can).toHaveBeenCalledTimes(1);
        expect(rbac.can).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'u1' }),
          `attachment.upload.${ownerType}`,
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.attachment.create).not.toHaveBeenCalled();
        expect(storageConsistency.resolveUploadLocatorForTransaction).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUpload).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUploadInTransaction).not.toHaveBeenCalled();
        expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
        expect(storageConsistency.finalizeUpload).not.toHaveBeenCalled();
        expect(storageConsistency.finalizeUploadInTransaction).not.toHaveBeenCalled();
        expect(provider.headObject).not.toHaveBeenCalled();
        expect(provider.readObjectPrefix).not.toHaveBeenCalled();
        expect(recorder.logUpload).not.toHaveBeenCalled();
        expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
        expect(recorder.logDelete).not.toHaveBeenCalled();
      },
    );

    it('advances only opaque same-service handles and never opens a nested transaction', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const rbac = makeRbacMock(true);
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      storageConsistency.finalizeUploadInTransaction.mockResolvedValue(
        makeAttachmentRow({ ownerType: 'content-image', ownerId: 'content-route' }),
      );
      const service = makeService(prisma, { provider, recorder, rbac, storageConsistency });
      const token = makeUploadToken({
        ownerType: 'content-image',
        ownerId: 'content-route',
      });

      const guarded = await service.guardContentUploadConfirm(
        { uploadToken: token, checksum: 'sha256:content' },
        makeCurrentUser({ id: 'u1' }),
        { ownerType: ['content-image', 'content-file'], ownerId: 'content-route' },
      );
      expect(Object.keys(guarded)).toEqual([]);
      expect(JSON.stringify(guarded)).not.toContain('content-route');

      const prepared = await service.prepareContentUploadConfirmInTransactionTrusted(
        prisma as unknown as Prisma.TransactionClient,
        guarded,
      );
      await expect(
        service.prepareContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          guarded,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      expect(storageConsistency.prepareUploadInTransaction).toHaveBeenCalledTimes(1);
      expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
      expect(provider.headObject).not.toHaveBeenCalled();

      const verified = await service.verifyContentUploadConfirmEvidenceOutsideTransaction(prepared);
      const finalized = await service.finalizeContentUploadConfirmInTransactionTrusted(
        prisma as unknown as Prisma.TransactionClient,
        verified,
        META,
      );
      await expect(
        service.finalizeContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          verified,
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      const response = await service.resolveContentUploadConfirmResponseTrusted(finalized);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(storageConsistency.prepareUpload).not.toHaveBeenCalled();
      expect(storageConsistency.prepareUploadInTransaction).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          ownerType: 'content-image',
          ownerId: 'content-route',
          uploadedByUserId: 'u1',
        }),
        'attachment_signed_upload',
        expect.any(Date),
      );
      expect(storageConsistency.verifyUploadEvidence).toHaveBeenCalledTimes(1);
      expect(storageConsistency.finalizeUpload).not.toHaveBeenCalled();
      expect(storageConsistency.finalizeUploadInTransaction).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          auditKind: 'confirmed',
          ownerTable: 'contents',
          scope: null,
          auditMeta: META,
          data: expect.objectContaining({
            ownerType: 'content-image',
            ownerId: 'content-route',
            checksum: 'sha256:content',
          }) as unknown,
        }),
        expect.objectContaining({ exists: true, size: 1024 }),
      );
      expect(storageConsistency.finalizeUploadInTransaction).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({
        ownerType: 'content-image',
        ownerId: 'content-route',
        accessUrl: 'https://signed.example/download',
      });

      const anotherService = makeService(makePrismaMock());
      await expect(
        anotherService.prepareContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          guarded,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    });

    it('rejects an unconsumed guard on another service without consuming the issuer capability', async () => {
      const issuerPrisma = makePrismaMock();
      const issuerProvider = makeProviderMock();
      const issuerRecorder = makeRecorderMock();
      const issuerStorage = makeStorageConsistencyMock(issuerProvider, issuerRecorder);
      const issuerService = makeService(issuerPrisma, {
        provider: issuerProvider,
        recorder: issuerRecorder,
        storageConsistency: issuerStorage,
      });
      const foreignPrisma = makePrismaMock();
      const foreignProvider = makeProviderMock();
      const foreignRecorder = makeRecorderMock();
      const foreignStorage = makeStorageConsistencyMock(foreignProvider, foreignRecorder);
      const foreignService = makeService(foreignPrisma, {
        provider: foreignProvider,
        recorder: foreignRecorder,
        storageConsistency: foreignStorage,
      });
      const guarded = await issuerService.guardContentUploadConfirm(
        {
          uploadToken: makeUploadToken({
            ownerType: 'content-image',
            ownerId: 'content-route',
          }),
        },
        makeCurrentUser(),
        { ownerType: 'content-image', ownerId: 'content-route' },
      );

      const foreignAttempt = foreignService.prepareContentUploadConfirmInTransactionTrusted(
        foreignPrisma as unknown as Prisma.TransactionClient,
        guarded,
      );
      await expect(foreignAttempt).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      await foreignAttempt.catch((error: unknown) => {
        expect(error).toBeInstanceOf(BizException);
        expect((error as BizException).biz).toEqual({
          code: 13001,
          message: '附件不存在',
          httpStatus: 404,
        });
      });

      expect(foreignPrisma.$transaction).not.toHaveBeenCalled();
      expect(foreignPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(foreignPrisma.attachment.create).not.toHaveBeenCalled();
      expect(foreignStorage.resolveUploadLocatorForTransaction).not.toHaveBeenCalled();
      expect(foreignStorage.prepareUpload).not.toHaveBeenCalled();
      expect(foreignStorage.prepareUploadInTransaction).not.toHaveBeenCalled();
      expect(foreignStorage.verifyUploadEvidence).not.toHaveBeenCalled();
      expect(foreignStorage.finalizeUpload).not.toHaveBeenCalled();
      expect(foreignStorage.finalizeUploadInTransaction).not.toHaveBeenCalled();
      expect(foreignProvider.headObject).not.toHaveBeenCalled();
      expect(foreignProvider.readObjectPrefix).not.toHaveBeenCalled();
      expect(foreignRecorder.logUpload).not.toHaveBeenCalled();
      expect(foreignRecorder.logUploadConfirmed).not.toHaveBeenCalled();
      expect(foreignRecorder.logDelete).not.toHaveBeenCalled();

      await expect(
        issuerService.prepareContentUploadConfirmInTransactionTrusted(
          issuerPrisma as unknown as Prisma.TransactionClient,
          guarded,
        ),
      ).resolves.toEqual(expect.any(Object));
      expect(issuerStorage.prepareUploadInTransaction).toHaveBeenCalledTimes(1);
      expect(issuerPrisma.$transaction).not.toHaveBeenCalled();
      expect(issuerProvider.headObject).not.toHaveBeenCalled();
      expect(issuerRecorder.logUploadConfirmed).not.toHaveBeenCalled();
    });

    it('rejects forged capability shapes without consuming a real guard', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      const service = makeService(prisma, { provider, recorder, storageConsistency });
      const guarded = await service.guardContentUploadConfirm(
        {
          uploadToken: makeUploadToken({
            ownerType: 'content-file',
            ownerId: 'content-route',
          }),
        },
        makeCurrentUser(),
        { ownerType: 'content-file', ownerId: 'content-route' },
      );
      const forgedCapabilities = [
        {} as ContentUploadConfirmGuard,
        Object.freeze(Object.create(null)) as ContentUploadConfirmGuard,
      ];

      for (const forged of forgedCapabilities) {
        const forgedAttempt = service.prepareContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          forged,
        );
        await expect(forgedAttempt).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
        await forgedAttempt.catch((error: unknown) => {
          expect(error).toBeInstanceOf(BizException);
          expect((error as BizException).biz).toEqual({
            code: 13001,
            message: '附件不存在',
            httpStatus: 404,
          });
        });
      }

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(storageConsistency.resolveUploadLocatorForTransaction).not.toHaveBeenCalled();
      expect(storageConsistency.prepareUpload).not.toHaveBeenCalled();
      expect(storageConsistency.prepareUploadInTransaction).not.toHaveBeenCalled();
      expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
      expect(storageConsistency.finalizeUpload).not.toHaveBeenCalled();
      expect(storageConsistency.finalizeUploadInTransaction).not.toHaveBeenCalled();
      expect(provider.headObject).not.toHaveBeenCalled();
      expect(provider.readObjectPrefix).not.toHaveBeenCalled();
      expect(recorder.logUpload).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
      expect(recorder.logDelete).not.toHaveBeenCalled();

      await expect(
        service.prepareContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          guarded,
        ),
      ).resolves.toEqual(expect.any(Object));
      expect(storageConsistency.prepareUploadInTransaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provider.headObject).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
    });

    it('consumes a guarded handle before a failing prepare effect', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      storageConsistency.prepareUploadInTransaction.mockRejectedValueOnce(
        new Error('PREPARE_EFFECT_FAILED'),
      );
      const service = makeService(prisma, { provider, recorder, storageConsistency });
      const guarded = await service.guardContentUploadConfirm(
        {
          uploadToken: makeUploadToken({
            ownerType: 'content-file',
            ownerId: 'content-route',
          }),
        },
        makeCurrentUser(),
        { ownerType: 'content-file', ownerId: 'content-route' },
      );

      await expect(
        service.prepareContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          guarded,
        ),
      ).rejects.toThrow('PREPARE_EFFECT_FAILED');
      await expect(
        service.prepareContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          guarded,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

      expect(storageConsistency.prepareUploadInTransaction).toHaveBeenCalledTimes(1);
      expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
      expect(storageConsistency.finalizeUploadInTransaction).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(provider.headObject).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
    });

    it('consumes a prepared handle before a failing Provider evidence effect', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      storageConsistency.verifyUploadEvidence.mockRejectedValueOnce(
        new Error('PROVIDER_EVIDENCE_FAILED'),
      );
      const service = makeService(prisma, { provider, recorder, storageConsistency });
      const guarded = await service.guardContentUploadConfirm(
        {
          uploadToken: makeUploadToken({
            ownerType: 'content-image',
            ownerId: 'content-route',
          }),
        },
        makeCurrentUser(),
        { ownerType: 'content-image', ownerId: 'content-route' },
      );
      const prepared = await service.prepareContentUploadConfirmInTransactionTrusted(
        prisma as unknown as Prisma.TransactionClient,
        guarded,
      );

      await expect(
        service.verifyContentUploadConfirmEvidenceOutsideTransaction(prepared),
      ).rejects.toThrow('PROVIDER_EVIDENCE_FAILED');
      await expect(
        service.verifyContentUploadConfirmEvidenceOutsideTransaction(prepared),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

      expect(storageConsistency.verifyUploadEvidence).toHaveBeenCalledTimes(1);
      expect(storageConsistency.finalizeUploadInTransaction).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
    });

    it('consumes a verified handle before a failing finalization effect', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      storageConsistency.finalizeUploadInTransaction.mockRejectedValueOnce(
        new Error('FINALIZATION_EFFECT_FAILED'),
      );
      const service = makeService(prisma, { provider, recorder, storageConsistency });
      const guarded = await service.guardContentUploadConfirm(
        {
          uploadToken: makeUploadToken({
            ownerType: 'content-image',
            ownerId: 'content-route',
          }),
        },
        makeCurrentUser(),
        { ownerType: 'content-image', ownerId: 'content-route' },
      );
      const prepared = await service.prepareContentUploadConfirmInTransactionTrusted(
        prisma as unknown as Prisma.TransactionClient,
        guarded,
      );
      const verified = await service.verifyContentUploadConfirmEvidenceOutsideTransaction(prepared);

      await expect(
        service.finalizeContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          verified,
          META,
        ),
      ).rejects.toThrow('FINALIZATION_EFFECT_FAILED');
      await expect(
        service.finalizeContentUploadConfirmInTransactionTrusted(
          prisma as unknown as Prisma.TransactionClient,
          verified,
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

      expect(storageConsistency.finalizeUploadInTransaction).toHaveBeenCalledTimes(1);
      expect(storageConsistency.verifyUploadEvidence).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(provider.headObject).toHaveBeenCalledTimes(1);
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
    });
  });

  // ============ G. confirmUpload:token / owner / headObject / size / dedup 分支 ============
  describe('confirmUpload — token / owner / headObject / size / dedup branches', () => {
    it.each([
      ['invalid', 'not-a-valid-token'],
      [
        'expired',
        makeUploadToken({
          iat: 1_700_000_000,
          exp: 1_700_000_001,
        }),
      ],
    ])('%s token → exact 404/13001/附件不存在且零副作用', async (_label, token) => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const rbac = makeRbacMock(true);
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      const service = makeService(prisma, {
        provider,
        recorder,
        rbac,
        storageConsistency,
      });

      const rejection = service.confirmUpload(makeConfirmDto(token), makeCurrentUser(), META);
      await expect(rejection).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      await rejection.catch((error: unknown) => {
        expect(error).toBeInstanceOf(BizException);
        expect((error as BizException).biz).toEqual({
          code: 13001,
          message: '附件不存在',
          httpStatus: 404,
        });
      });
      expect(rbac.can).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(storageConsistency.prepareUpload).not.toHaveBeenCalled();
      expect(storageConsistency.prepareUploadInTransaction).not.toHaveBeenCalled();
      expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
      expect(storageConsistency.finalizeUpload).not.toHaveBeenCalled();
      expect(storageConsistency.finalizeUploadInTransaction).not.toHaveBeenCalled();
      expect(provider.headObject).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
    });

    it.each(['member', 'certificate', 'activity'] as const)(
      '%s foreign uploader → 保持 30100且不进入 storage/Provider',
      async (ownerType) => {
        const prisma = makePrismaMock();
        const provider = makeProviderMock();
        const recorder = makeRecorderMock();
        const storageConsistency = makeStorageConsistencyMock(provider, recorder);
        const token = makeUploadToken({ ownerType, uploadedByUserId: 'someone-else' });
        const service = makeService(prisma, { provider, recorder, storageConsistency });

        await expect(
          service.confirmUpload(makeConfirmDto(token), makeCurrentUser({ id: 'u1' }), META),
        ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUpload).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUploadInTransaction).not.toHaveBeenCalled();
        expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
        expect(provider.headObject).not.toHaveBeenCalled();
        expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
      },
    );

    it.each(['content-image', 'content-file'] as const)(
      '%s foreign uploader → 与 invalid token 同为 13001，且零 Content/storage/Provider/audit',
      async (ownerType) => {
        const prisma = makePrismaMock();
        const provider = makeProviderMock();
        const recorder = makeRecorderMock();
        const rbac = makeRbacMock(true);
        const storageConsistency = makeStorageConsistencyMock(provider, recorder);
        const token = makeUploadToken({
          ownerType,
          ownerId: 'content-private-1',
          uploadedByUserId: 'foreign-uploader',
        });
        const service = makeService(prisma, {
          provider,
          recorder,
          rbac,
          storageConsistency,
        });

        await expect(
          service.confirmUpload(makeConfirmDto(token), makeCurrentUser({ id: 'u1' }), META),
        ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

        // Mutation killed: changing the content-* branch back to 30100 fails the exact exception.
        expect(rbac.can).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUpload).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUploadInTransaction).not.toHaveBeenCalled();
        expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
        expect(storageConsistency.finalizeUpload).not.toHaveBeenCalled();
        expect(storageConsistency.finalizeUploadInTransaction).not.toHaveBeenCalled();
        expect(provider.headObject).not.toHaveBeenCalled();
        expect(provider.readObjectPrefix).not.toHaveBeenCalled();
        expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
      },
    );

    it.each(['content-image', 'content-file'] as const)(
      '%s coarse RBAC denial → 13001 before Content/storage/Provider/audit',
      async (ownerType) => {
        const prisma = makePrismaMock();
        const provider = makeProviderMock();
        const recorder = makeRecorderMock();
        const rbac = makeRbacMock(false);
        const storageConsistency = makeStorageConsistencyMock(provider, recorder);
        const service = makeService(prisma, {
          provider,
          recorder,
          rbac,
          storageConsistency,
        });

        await expect(
          service.confirmUpload(
            makeConfirmDto(makeUploadToken({ ownerType, ownerId: 'content-private-1' })),
            makeCurrentUser({ id: 'u1' }),
            META,
          ),
        ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));

        expect(rbac.can).toHaveBeenCalledWith(expect.anything(), `attachment.upload.${ownerType}`);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(storageConsistency.prepareUploadInTransaction).not.toHaveBeenCalled();
        expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
        expect(provider.headObject).not.toHaveBeenCalled();
        expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
      },
    );

    it('content confirm locks virgin Content and prepares owner intent in that same transaction', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const rbac = makeRbacMock(true);
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'content-private-1',
          deletedAt: null,
          statusCode: 'draft',
          publishedAt: null,
        },
      ]);
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(
        makeTypeConfig({ ownerTable: 'contents' }),
      );
      storageConsistency.finalizeUploadInTransaction.mockResolvedValue(
        makeAttachmentRow({ ownerType: 'content-image', ownerId: 'content-private-1' }),
      );
      const service = makeService(prisma, {
        provider,
        recorder,
        rbac,
        storageConsistency,
      });

      await service.confirmUpload(
        makeConfirmDto(
          makeUploadToken({ ownerType: 'content-image', ownerId: 'content-private-1' }),
        ),
        makeCurrentUser({ id: 'u1' }),
        META,
      );

      expect(storageConsistency.prepareUploadInTransaction).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          ownerType: 'content-image',
          ownerId: 'content-private-1',
        }),
        'attachment_signed_upload',
        expect.any(Date),
      );
      expect(storageConsistency.prepareUpload).not.toHaveBeenCalled();
      expect(storageConsistency.verifyUploadEvidence).toHaveBeenCalledTimes(1);
      expect(storageConsistency.finalizeUpload).not.toHaveBeenCalled();
      expect(storageConsistency.finalizeUploadInTransaction).toHaveBeenCalledTimes(1);
    });

    it('published Content wins before prepare → 29030 and zero storage/Provider/audit', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'content-private-1',
          deletedAt: null,
          statusCode: 'published',
          publishedAt: new Date('2026-07-19T08:00:00.000Z'),
        },
      ]);
      const service = makeService(prisma, { provider, recorder, storageConsistency });

      await expect(
        service.confirmUpload(
          makeConfirmDto(
            makeUploadToken({ ownerType: 'content-file', ownerId: 'content-private-1' }),
          ),
          makeCurrentUser({ id: 'u1' }),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION));
      expect(storageConsistency.prepareUploadInTransaction).not.toHaveBeenCalled();
      expect(storageConsistency.verifyUploadEvidence).not.toHaveBeenCalled();
      expect(provider.headObject).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
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

    it('声明 image/jpeg 但回读为文本 → 13016;不写库', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      provider.headObject.mockResolvedValue({ exists: true, size: 1024 });
      provider.readObjectPrefix.mockResolvedValue(Buffer.from('plain text', 'utf8'));
      const service = makeService(prisma, { provider });

      await expect(
        service.confirmUpload(
          makeConfirmDto(makeUploadToken({ mime: 'image/jpeg' })),
          makeCurrentUser({ id: 'u1' }),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('旧 token 声明 image/svg+xml → confirm 永久黑名单 13033;不回读 / 不写库', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      provider.headObject.mockResolvedValue({ exists: true, size: 1024 });
      const service = makeService(prisma, { provider });

      await expect(
        service.confirmUpload(
          makeConfirmDto(makeUploadToken({ mime: 'image/svg+xml' })),
          makeCurrentUser({ id: 'u1' }),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED));
      expect(provider.readObjectPrefix).not.toHaveBeenCalled();
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('owner 软删窗口(F10 #399)→ 13011;不写库 / 不审计(token 签发后 owner 被软删)', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      provider.headObject.mockResolvedValue({ exists: true, size: 1024 });
      prisma.member.findFirst.mockResolvedValue(null); // owner 已软删 → Step 7.5 assertOwnerExists 抛
      const service = makeService(prisma, { provider, recorder });

      await expect(
        service.confirmUpload(
          makeConfirmDto(makeUploadToken()),
          makeCurrentUser({ id: 'u1', memberId: 'mem-1' }),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND));
      expect(prisma.attachment.create).not.toHaveBeenCalled();
      expect(recorder.logUploadConfirmed).not.toHaveBeenCalled();
    });

    it('同 key 二次提交由 durable finalizer 拒绝 → 13001', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      provider.headObject.mockResolvedValue({ exists: true, size: 1024 });
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' }); // F10:owner 存活(过 Step 7.5)→ 进 tx 撞 dedup
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      storageConsistency.finalizeUploadInTransaction.mockRejectedValue(
        new BizException(BizCode.ATTACHMENT_NOT_FOUND),
      );
      const service = makeService(prisma, { provider, recorder, storageConsistency });

      await expect(
        service.confirmUpload(
          makeConfirmDto(makeUploadToken()),
          makeCurrentUser({ id: 'u1', memberId: 'mem-1' }),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
      expect(storageConsistency.finalizeUpload).not.toHaveBeenCalled();
      expect(storageConsistency.finalizeUploadInTransaction).toHaveBeenCalledTimes(1);
      expect(storageConsistency.resolveDownloadUrl).not.toHaveBeenCalled();
    });

    it('happy → durable finalizer 收到 audit envelope；成功后才签 download URL', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      provider.headObject.mockResolvedValue({ exists: true, size: 1024, etag: 'etag-1' });
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' }); // F10:owner 存活复校(Step 7.5)
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      storageConsistency.finalizeUploadInTransaction.mockResolvedValue(
        makeAttachmentRow({ ownerId: 'mem-1' }),
      );
      const service = makeService(prisma, { provider, recorder, storageConsistency });

      const res = await service.confirmUpload(
        makeConfirmDto(makeUploadToken(), 'sha256:abc'),
        makeCurrentUser({ id: 'u1', memberId: 'mem-1' }),
        META,
      );

      expect(storageConsistency.finalizeUploadInTransaction).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          auditKind: 'confirmed',
          scope: 'self',
          ownerTable: 'member',
          auditMeta: META,
        }),
        expect.objectContaining({ exists: true, size: 1024, etag: 'etag-1' }),
      );
      const finalizeInput = storageConsistency.finalizeUploadInTransaction.mock.calls[0]?.[1];
      expect(finalizeInput?.data).toMatchObject({ etag: 'etag-1', checksum: 'sha256:abc' });
      expect(storageConsistency.resolveDownloadUrl).toHaveBeenCalledTimes(1);
      expect(res.id).toBe('att-1');
      expect(res.accessUrl).toBe('https://signed.example/download');
    });

    it('durable finalizer/audit 失败 → 不签 URL、不返回成功', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      storageConsistency.finalizeUploadInTransaction.mockRejectedValue(
        new Error('audit transaction failed'),
      );
      const service = makeService(prisma, { provider, recorder, storageConsistency });

      await expect(
        service.confirmUpload(
          makeConfirmDto(makeUploadToken()),
          makeCurrentUser({ id: 'u1', memberId: 'mem-1' }),
          META,
        ),
      ).rejects.toThrow('audit transaction failed');
      expect(storageConsistency.resolveDownloadUrl).not.toHaveBeenCalled();
    });
  });

  // ============ H. createUploadUrl:durable intent / 不创建 Attachment / 不写业务 audit ============
  describe('createUploadUrl — durable intent before signing', () => {
    it('happy → 先预写 intent 再返 signed URL；不创建 Attachment / 不写业务 audit', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      const recorder = makeRecorderMock();
      const storageConsistency = makeStorageConsistencyMock(provider, recorder);
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(
        makeTypeConfig({ defaultMimeWhitelist: ['image/png'], defaultMaxSizeBytes: null }),
      );
      prisma.member.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.attachmentMimeConfig.findFirst.mockResolvedValue(null);
      prisma.attachmentSizeLimitConfig.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, {
        provider,
        recorder,
        storageConsistency,
        env: 'test',
      });

      const res = await service.createUploadUrl(
        makeUploadUrlDto({ ownerType: 'member', ownerId: 'mem-1', mime: 'image/png' }),
        makeCurrentUser({ memberId: 'mem-1' }),
      );

      // 结构化断言(key 含 Date / randomBytes;不锁具体值)
      expect(res.key).toMatch(/^attachments\/test\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);
      expect(res.uploadToken.split('.')).toHaveLength(2);
      expect(res.uploadUrl).toBe('https://signed.example/upload');
      expect(storageConsistency.prepareUploadUrl).toHaveBeenCalledTimes(1);
      expect(storageConsistency.prepareUploadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          key: res.key,
          ownerType: 'member',
          ownerId: 'mem-1',
          mime: 'image/png',
          size: 1024,
        }),
        expect.any(Date),
        600,
      );
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

    it('finding #11:list 含 K 张证书附件时 Certificate 查询由 K 降为 1', async () => {
      const prisma = makePrismaMock();
      prisma.attachment.findMany.mockResolvedValue([
        makeAttachmentRow({ id: 'cert-att-1', ownerType: 'certificate', ownerId: 'cert-1' }),
        makeAttachmentRow({ id: 'cert-att-2', ownerType: 'certificate', ownerId: 'cert-1' }),
        makeAttachmentRow({ id: 'cert-att-3', ownerType: 'certificate', ownerId: 'cert-2' }),
      ]);
      prisma.certificate.findMany.mockResolvedValue([
        { id: 'cert-1', memberId: 'mem-1' },
        { id: 'cert-2', memberId: 'mem-2' },
      ]);
      const service = makeService(prisma, { rbac: makeRbacMock(true) });

      const page = await service.list(
        { page: 1, pageSize: 20 },
        makeCurrentUser({ memberId: 'mem-1' }),
      );

      expect(page.total).toBe(3);
      expect(prisma.certificate.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.certificate.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['cert-1', 'cert-2'] }, deletedAt: null },
        select: { id: true, memberId: true },
      });
      expect(prisma.certificate.findFirst).not.toHaveBeenCalled();
    });

    it('finding #11:listByOwner certificate 真实性与 K 行 scope 共用 1 次批量查询', async () => {
      const prisma = makePrismaMock();
      prisma.attachmentTypeConfig.findFirst.mockResolvedValue(makeTypeConfig());
      prisma.certificate.findMany.mockResolvedValue([{ id: 'cert-1', memberId: 'mem-1' }]);
      prisma.attachment.findMany.mockResolvedValue([
        makeAttachmentRow({ id: 'cert-att-1', ownerType: 'certificate', ownerId: 'cert-1' }),
        makeAttachmentRow({ id: 'cert-att-2', ownerType: 'certificate', ownerId: 'cert-1' }),
      ]);
      const service = makeService(prisma, { rbac: makeRbacMock(true) });

      const page = await service.listByOwner(
        { page: 1, pageSize: 20, ownerType: 'certificate', ownerId: 'cert-1' },
        makeCurrentUser({ memberId: 'mem-1' }),
      );

      expect(page.total).toBe(2);
      expect(prisma.certificate.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.certificate.findFirst).not.toHaveBeenCalled();
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

  // ============ J. listOwnerAttachmentsTrusted — content-* owner 护栏(元核验加固 2026-06-21) ============
  // 本方法 public + 无 RBAC;运行时护栏限定 content-image / content-file owner,
  // 防将来误用对 member / certificate / activity 等 owner 无鉴权签出(含 PII)附件下载 URL。
  describe('listOwnerAttachmentsTrusted — content-* owner guard (no-RBAC trusted view)', () => {
    it('非 content-* owner(member)→ 抛护栏 Error;不查库(防无鉴权签出 PII 附件 URL)', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);

      await expect(service.listOwnerAttachmentsTrusted('member', 'mem-1')).rejects.toThrow(
        /content-\* owner types only/,
      );
      expect(prisma.attachment.findMany).not.toHaveBeenCalled();
    });

    it('certificate / activity owner 同样被护栏拒(穷举既有非 content owner)', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);

      await expect(service.listOwnerAttachmentsTrusted('certificate', 'cert-1')).rejects.toThrow(
        /content-\* owner types only/,
      );
      await expect(service.listOwnerAttachmentsTrusted('activity', 'act-1')).rejects.toThrow(
        /content-\* owner types only/,
      );
      expect(prisma.attachment.findMany).not.toHaveBeenCalled();
    });

    it('content-image / content-file owner → 放行,返已签 URL 视图(护栏不误伤本用途)', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      prisma.attachment.findMany.mockResolvedValue([
        makeAttachmentRow({
          id: 'ci-1',
          ownerType: 'content-image',
          ownerId: 'content-1',
          key: 'k1',
        }),
      ]);
      const service = makeService(prisma, { provider });

      const views = await service.listOwnerAttachmentsTrusted('content-image', 'content-1');

      expect(views).toHaveLength(1);
      expect(views[0]).toEqual(
        expect.objectContaining({
          id: 'ci-1',
          ownerType: 'content-image',
          accessUrl: 'https://signed.example/download',
        }),
      );

      // content-file 同样放行(空集不抛)
      prisma.attachment.findMany.mockResolvedValue([]);
      await expect(
        service.listOwnerAttachmentsTrusted('content-file', 'content-1'),
      ).resolves.toEqual([]);
    });

    it('已过期 content 附件从 public 可信列表移除；未来 / 未设置正常返回 URL', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      prisma.attachment.findMany.mockResolvedValue([
        makeAttachmentRow({
          id: 'expired',
          ownerType: 'content-file',
          expireAt: new Date('2000-01-01T00:00:00.000Z'),
        }),
        makeAttachmentRow({
          id: 'future',
          ownerType: 'content-file',
          expireAt: new Date('2286-01-01T00:00:00.000Z'),
        }),
        makeAttachmentRow({ id: 'unset', ownerType: 'content-file', expireAt: null }),
      ]);
      const service = makeService(prisma, { provider });

      const views = await service.listOwnerAttachmentsTrusted('content-file', 'content-1');

      expect(views.map((view) => view.id)).toEqual(['future', 'unset']);
      expect(views.every((view) => view.accessUrl === 'https://signed.example/download')).toBe(
        true,
      );
      expect(provider.generateDownloadUrl).toHaveBeenCalledTimes(2);
    });

    it('resolveSignedUrlTrusted 按 key 补查 expireAt，已过期不签 URL', async () => {
      const prisma = makePrismaMock();
      const provider = makeProviderMock();
      prisma.attachment.findUnique.mockResolvedValue({
        expireAt: new Date('2000-01-01T00:00:00.000Z'),
      });
      const service = makeService(prisma, { provider });

      await expect(service.resolveSignedUrlTrusted('expired-key')).resolves.toBeNull();
      expect(prisma.attachment.findUnique).toHaveBeenCalledWith({
        where: { key: 'expired-key' },
        select: { expireAt: true },
      });
      expect(provider.generateDownloadUrl).not.toHaveBeenCalled();
    });
  });
});
