import { mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import type {
  ConfirmUploadDto,
  CreateAttachmentDto,
  GenerateUploadUrlDto,
} from '../../src/modules/attachments/attachments.dto';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { conformingAttachmentKey } from '../helpers/attachment-key';
import { attachmentBytesForMime } from '../helpers/file-fixtures';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// AttachmentsService audit characterization tests
// (ActivityAuditRecorder 抽离前置;沿 PR #199 activities + PR #196 registrations
// audit-characterization spec 范式)。
//
// 目标:在抽 `ActivityAuditRecorder`(下一单)之前,显式锁定
// Attachment 三条写路径的 audit payload 形状:
//   - event name(`'attachment.upload'` ×2 create / confirmUpload 共用 +
//     `'attachment.delete'` ×1)
//   - resourceType(`'attachment'`)/ resourceId / actorUserId / actorRoleSnap / success
//   - context.requestId / ip / ua / before / after(固定最小 7 字段)/ extra 完整字段集
//   - 5 处 wrong-path 失败 → 0 audit(沿 D6 F6 fail-fast)
//   - 3 处 audit fail → tx rollback(沿 D-S7 红线)
//
// 沿 docs/api-surface-policy.md §8 P1 禁止事项 + docs/architecture-boundary.md §8 deferred:
//   ❌ 不改 src/**
//   ❌ 不抽 AttachmentAuditRecorder(留下一 PR)
//   ❌ 不拆 controller / DTO / schema / migration / OpenAPI / package / CI
//   ✅ 只新增本测试文件
//
// 测试策略选择(沿 PR #199 activities-audit-characterization spec 范式):
//   - 选 service-level e2e:`createTestApp()` + `app.get(AttachmentsService)` 直接调用,
//     **绕过 HTTP / JwtAuthGuard**,纯锁 service 层 audit assembly 行为
//   - 已存在的 `attachments.audit.e2e-spec.ts`(PR #6c 19 case)走 HTTP supertest;
//     本 spec 与之**互补**:HTTP 表面行为已锁,service 内部 payload `toEqual` 完整字段集 + rollback
//     是 audit recorder 抽离的安全门禁
//   - audit failure rollback case 用 `jest.spyOn(auditLogs, 'log').mockRejectedValueOnce`
//     触发 service throw + DB 无落库 + audit 不存在(沿 PR #199 F1 范式)
//   - confirmUpload 使用 `fakeUploadToLocal` 把 key 写入 LocalProvider 磁盘路径,
//     让 `provider.headObject` 返 `exists=true`(沿 attachments.upload.e2e-spec.ts §confirm 范式)
//
// 覆盖矩阵(13 cases):
//   A. create(legacy)audit shape:基础形状 + scope=other 变体
//   B. confirmUpload audit shape:8+2=10 字段 toEqual 锁(含 uploadConfirmedAt / uploadVia)
//   C. delete audit shape:deletedByPath=admin / deletedByPath=owner 双 case
//   D. audit failure rollback:create / confirmUpload / delete 三路径
//   E. wrong-path no-audit:ownerType invalid / mime blocked / size exceeded / PII /
//      RBAC forbidden / not found 6 类

const SUPER_USERNAME = 'attach-char-su';
const SELF_USERNAME = 'attach-char-self';

const AUDIT_META: AuditMeta = {
  requestId: 'attach-audit-charac-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 attachments-audit-characterization',
};

const ATTACHMENT_RESOURCE_TYPE = 'attachment';
const UPLOAD_EVENT = 'attachment.upload';
const DELETE_EVENT = 'attachment.delete';

// RBAC seed 沿 attachments.audit.e2e-spec.ts §PR #6c 范式:
// selfUser(member 角色)拥有 .self 权限;.other 故意不授予,用于 E5 RBAC 拒绝路径。
const MEMBER_ROLE_PERMISSION_CODES = [
  'attachment.upload.member.self',
  'attachment.view.member.self',
  'attachment.update.member.self',
  'attachment.delete.member.self',
] as const;

const ATTACHMENT_PERMISSION_CODES = [
  ...MEMBER_ROLE_PERMISSION_CODES,
  'attachment.upload.member.other',
  'attachment.view.member.other',
  'attachment.update.member.other',
  'attachment.delete.member.other',
] as const;

interface AuditContextShape {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

describe('AttachmentsService audit characterization', () => {
  let app: INestApplication;
  let service: AttachmentsService;
  let prisma: PrismaService;
  let auditLogs: AuditLogsService;

  let superId: string;
  let selfId: string;
  let memberA: { id: string };
  let memberB: { id: string };
  let localRoot: string;

  let superPayload: CurrentUserPayload;
  let selfPayload: CurrentUserPayload;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    prisma = app.get(PrismaService);
    service = app.get(AttachmentsService);
    auditLogs = app.get(AuditLogsService);

    const cfg = app.get<{ storage: { localRoot: string } }>(appConfig.KEY);
    localRoot = cfg.storage.localRoot;

    // 1. Users
    const superUser = await createTestUser(app, {
      username: SUPER_USERNAME,
      role: Role.SUPER_ADMIN,
    });
    const selfUser = await createTestUser(app, { username: SELF_USERNAME });
    superId = superUser.id;
    selfId = selfUser.id;

    // 2. Members(selfUser 绑 memberA → scope=self;memberB 用于 scope=other / E5 RBAC)
    memberA = await prisma.member.create({
      data: { memberNo: 'MA-CHAR', displayName: 'CharMemberA' },
      select: { id: true },
    });
    memberB = await prisma.member.create({
      data: { memberNo: 'MB-CHAR', displayName: 'CharMemberB' },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: selfUser.id }, data: { memberId: memberA.id } });

    // 3. TypeConfig(member;ownerTable='member' 进 audit extra)
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'member',
        displayName: '队员证件照',
        ownerTable: 'member',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg', 'image/png'],
      },
    });

    // 4. RBAC seed:8 条 permission + member 角色 + 4 条 RolePermission(仅 .self)+ selfUser 绑
    for (const code of ATTACHMENT_PERMISSION_CODES) {
      const [m, a, r, scope] = code.split('.');
      await prisma.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: m,
          action: a,
          resourceType: r,
          description: scope ? `${a} ${r}.${scope}` : `${a} ${r}`,
        },
      });
    }
    const memberRole = await prisma.rbacRole.upsert({
      where: { code: 'member' },
      update: {},
      create: { code: 'member', displayName: '队员', description: 'USER 内置角色 placeholder' },
      select: { id: true },
    });
    const perms = await prisma.permission.findMany({
      where: { code: { in: [...MEMBER_ROLE_PERMISSION_CODES] } },
      select: { id: true },
    });
    for (const perm of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: memberRole.id, permissionId: perm.id } },
        update: {},
        create: { roleId: memberRole.id, permissionId: perm.id },
      });
    }
    // 终态 scoped-authz PR6:判权读源 = global RoleBinding,故授予角色写 RoleBinding(USER, GLOBAL, ACTIVE)。
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: selfUser.id,
        roleId: memberRole.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });

    // 5. CurrentUserPayloads(service-level direct call 不经 JwtAuthGuard,手动构造)
    superPayload = {
      id: superId,
      username: SUPER_USERNAME,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    selfPayload = {
      id: selfId,
      username: SELF_USERNAME,
      role: Role.USER,
      status: UserStatus.ACTIVE,
      memberId: memberA.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 每个 case 隔离 durable storage ledger + attachments + audit_logs；保留业务 seed。
  async function isolateFixtures(): Promise<void> {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "storage_object_operations", "storage_objects", "attachments" RESTART IDENTITY CASCADE',
    );
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');
  }

  // 沿 attachments.audit.e2e-spec.ts buildBody 范式(legacy create DTO)
  function buildCreateDto(override: Partial<CreateAttachmentDto> = {}): CreateAttachmentDto {
    const base = {
      key: conformingAttachmentKey(), // F2:服务端派生格式合规 key(原任意 key 已被 13014 校验拒)
      originalName: 'photo.jpg',
      mime: 'image/jpeg',
      size: 1024,
      ownerType: 'member',
      ownerId: memberA.id,
    };
    const dto = { ...base, ...override };
    if (dto.size <= 20_000_000 && (dto.mime === 'image/jpeg' || dto.mime === 'image/png')) {
      const filePath = path.resolve(localRoot, dto.key);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, attachmentBytesForMime(dto.mime, dto.size));
    }
    return dto;
  }

  function buildUploadUrlDto(override: Partial<GenerateUploadUrlDto> = {}): GenerateUploadUrlDto {
    const base = {
      ownerType: 'member',
      ownerId: memberA.id,
      originalName: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 1024,
    };
    return { ...base, ...override };
  }

  // 把 key 实写到 LocalProvider 磁盘根,模拟 client 已 PUT 完成
  // (沿 attachments.upload.e2e-spec.ts fakeUploadToLocal 范式)
  async function fakeUploadToLocal(key: string, sizeBytes = 1024): Promise<void> {
    const filePath = path.resolve(localRoot, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const body = Buffer.alloc(sizeBytes);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(body);
    await fs.writeFile(filePath, body);
  }

  // ============ A. create audit shape(legacy 直传 create) ============
  describe('A. create audit shape (legacy direct)', () => {
    beforeEach(isolateFixtures);

    it('A1. event=attachment.upload + 公共字段 + extra 8 字段 toEqual 锁 + after present / before absent', async () => {
      const dto = buildCreateDto({ size: 12345 });
      const result = await service.create(dto, selfPayload, AUDIT_META);

      const audits = await prisma.auditLog.findMany({
        where: { event: UPLOAD_EVENT, resourceId: result.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      // 公共字段
      expect(a.event).toBe(UPLOAD_EVENT);
      expect(a.resourceType).toBe(ATTACHMENT_RESOURCE_TYPE);
      expect(a.resourceId).toBe(result.id);
      expect(a.actorUserId).toBe(selfId);
      expect(a.actorRoleSnap).toBe(Role.USER);
      expect(a.success).toBe(true);

      // context meta
      const ctx = a.context as unknown as AuditContextShape;
      expect(ctx.requestId).toBe(AUDIT_META.requestId);
      expect(ctx.ip).toBe(AUDIT_META.ip);
      expect(ctx.ua).toBe(AUDIT_META.ua);

      // before absent / after present(create 路径)
      expect(ctx.before).toBeUndefined();
      expect(ctx.after).toBeDefined();
      expect(ctx.after).toEqual({
        key: result.key,
        mime: 'image/jpeg',
        size: 12345,
        uploadedBy: selfId,
        uploadedAt: result.uploadedAt.toISOString(),
        ownerType: 'member',
        ownerId: memberA.id,
      });

      // extra 字段集逐字锁(8 字段;沿 service.create line 422-441)
      expect(ctx.extra).toEqual({
        operation: 'upload',
        attachmentType: 'member',
        ownerType: 'member',
        ownerId: memberA.id,
        mime: 'image/jpeg',
        size: 12345,
        scope: 'self', // selfPayload.memberId === memberA.id
        ownerTable: 'member',
      });
    });

    it('A2. scope=other(SUPER_ADMIN 上传 memberB 附件;user.memberId=null → other)', async () => {
      const dto = buildCreateDto({ ownerId: memberB.id });
      const result = await service.create(dto, superPayload, AUDIT_META);

      const a = await prisma.auditLog.findFirstOrThrow({
        where: { event: UPLOAD_EVENT, resourceId: result.id },
      });
      // 公共字段(SUPER_ADMIN 路径)
      expect(a.actorUserId).toBe(superId);
      expect(a.actorRoleSnap).toBe(Role.SUPER_ADMIN);

      const ctx = a.context as unknown as AuditContextShape;
      expect(ctx.before).toBeUndefined();
      expect(ctx.after).toBeDefined();
      expect(ctx.extra).toEqual({
        operation: 'upload',
        attachmentType: 'member',
        ownerType: 'member',
        ownerId: memberB.id,
        mime: 'image/jpeg',
        size: 1024,
        scope: 'other', // superPayload.memberId=null → other
        ownerTable: 'member',
      });
    });
  });

  // ============ B. confirmUpload audit shape ============
  describe('B. confirmUpload audit shape', () => {
    beforeEach(isolateFixtures);

    it('B1. event=attachment.upload + extra 10 字段(8+uploadConfirmedAt+uploadVia:direct)toEqual 锁 + after present / before absent', async () => {
      // 1. 通过 service.createUploadUrl 拿 durable intent + key + uploadToken；此腿不写 audit。
      const tokenRes = await service.createUploadUrl(buildUploadUrlDto(), selfPayload);

      // 2. 写假文件到 LocalProvider 磁盘,让 provider.headObject 返 exists=true
      await fakeUploadToLocal(tokenRes.key, 1024);

      // 3. 调 service.confirmUpload
      const confirmDto: ConfirmUploadDto = { uploadToken: tokenRes.uploadToken };
      const result = await service.confirmUpload(confirmDto, selfPayload, AUDIT_META);

      // 4. audit 锁定
      const audits = await prisma.auditLog.findMany({
        where: { event: UPLOAD_EVENT, resourceId: result.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      // 公共字段
      expect(a.event).toBe(UPLOAD_EVENT);
      expect(a.resourceType).toBe(ATTACHMENT_RESOURCE_TYPE);
      expect(a.resourceId).toBe(result.id);
      expect(a.actorUserId).toBe(selfId);
      expect(a.actorRoleSnap).toBe(Role.USER);
      expect(a.success).toBe(true);

      const ctx = a.context as unknown as AuditContextShape;
      expect(ctx.requestId).toBe(AUDIT_META.requestId);
      expect(ctx.ip).toBe(AUDIT_META.ip);
      expect(ctx.ua).toBe(AUDIT_META.ua);

      // before absent / after present(confirmUpload 路径与 create 同;沿 service line 831-853)
      expect(ctx.before).toBeUndefined();
      expect(ctx.after).toBeDefined();
      expect(ctx.after).toEqual({
        key: tokenRes.key,
        mime: 'image/jpeg',
        size: 1024,
        uploadedBy: selfId,
        uploadedAt: result.uploadedAt.toISOString(),
        ownerType: 'member',
        ownerId: memberA.id,
      });

      // extra 字段集逐字锁(10 字段 = create 8 + 2 增量;沿 service line 839-851)
      // uploadConfirmedAt 是动态时间字符串,用 expect.any(String) 锁形状不锁值
      expect(ctx.extra).toEqual({
        operation: 'upload',
        attachmentType: 'member',
        ownerType: 'member',
        ownerId: memberA.id,
        mime: 'image/jpeg',
        size: 1024,
        scope: 'self',
        ownerTable: 'member',
        uploadConfirmedAt: expect.any(String) as unknown,
        uploadVia: 'direct',
      });

      // 额外断言:uploadConfirmedAt 是有效 ISO 8601 字符串
      const extra = ctx.extra as { uploadConfirmedAt: string };
      expect(extra.uploadConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  // ============ C. delete audit shape ============
  describe('C. delete audit shape', () => {
    beforeEach(isolateFixtures);

    it('C1. event=attachment.delete + extra 8 字段(含 deletedByPath=admin) toEqual 锁 + before present / after absent', async () => {
      // selfPayload 上传(uploadedBy = selfId)
      const created = await service.create(buildCreateDto({ size: 2048 }), selfPayload, AUDIT_META);
      // 清 audit,留 delete audit 单独断言
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');

      // superPayload 删 → currentUser.id !== uploadedBy(selfId)→ deletedByPath='admin'
      await service.delete(created.id, superPayload, AUDIT_META);

      const audits = await prisma.auditLog.findMany({
        where: { event: DELETE_EVENT, resourceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      // 公共字段
      expect(a.event).toBe(DELETE_EVENT);
      expect(a.resourceType).toBe(ATTACHMENT_RESOURCE_TYPE);
      expect(a.resourceId).toBe(created.id);
      expect(a.actorUserId).toBe(superId);
      expect(a.actorRoleSnap).toBe(Role.SUPER_ADMIN);
      expect(a.success).toBe(true);

      const ctx = a.context as unknown as AuditContextShape;
      expect(ctx.requestId).toBe(AUDIT_META.requestId);
      expect(ctx.ip).toBe(AUDIT_META.ip);
      expect(ctx.ua).toBe(AUDIT_META.ua);

      // before present / after absent(delete 路径;沿 service line 573-592)
      expect(ctx.before).toBeDefined();
      expect(ctx.after).toBeUndefined();
      expect(ctx.before).toEqual({
        key: created.key,
        mime: 'image/jpeg',
        size: 2048,
        uploadedBy: selfId,
        uploadedAt: created.uploadedAt.toISOString(),
        ownerType: 'member',
        ownerId: memberA.id,
      });

      // extra 字段集逐字锁(8 字段)
      expect(ctx.extra).toEqual({
        operation: 'delete',
        attachmentType: 'member',
        ownerType: 'member',
        ownerId: memberA.id,
        mime: 'image/jpeg',
        size: 2048,
        scope: 'other', // superPayload.memberId=null
        deletedByPath: 'admin', // superId !== selfId(uploadedBy)
      });
    });

    it('C2. deletedByPath=owner(selfPayload 删自己上传的)', async () => {
      const created = await service.create(buildCreateDto(), selfPayload, AUDIT_META);
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');

      // selfPayload 删 → currentUser.id === uploadedBy(selfId)→ deletedByPath='owner'
      await service.delete(created.id, selfPayload, AUDIT_META);

      const a = await prisma.auditLog.findFirstOrThrow({
        where: { event: DELETE_EVENT, resourceId: created.id },
      });
      const ctx = a.context as unknown as AuditContextShape;
      expect(ctx.extra).toEqual({
        operation: 'delete',
        attachmentType: 'member',
        ownerType: 'member',
        ownerId: memberA.id,
        mime: 'image/jpeg',
        size: 1024,
        scope: 'self',
        deletedByPath: 'owner', // selfId === uploadedBy
      });
    });
  });

  // ============ D. Audit failure rollback(D-S7 红线) ============
  describe('D. audit failure rollback', () => {
    beforeEach(isolateFixtures);

    it('D1. create 路径 auditLogs.log 抛错 → $transaction 回滚:无新 attachment + 无 audit', async () => {
      const beforeAttCount = await prisma.attachment.count();
      const logSpy = jest
        .spyOn(auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(service.create(buildCreateDto(), selfPayload, AUDIT_META)).rejects.toThrow(
        'simulated audit failure',
      );
      expect(logSpy).toHaveBeenCalledTimes(1);

      // 回滚证据 1:无新 attachment(tx.attachment.create 已发起但 $transaction 回滚)
      expect(await prisma.attachment.count()).toBe(beforeAttCount);

      // 回滚证据 2:无 audit 落库(本次唯一一次 log 调用被 mock reject,Prisma 不会真的写入)
      expect(await prisma.auditLog.count({ where: { event: UPLOAD_EVENT } })).toBe(0);
    });

    it('D2. confirmUpload 路径 auditLogs.log 抛错 → $transaction 回滚:无新 attachment + 无 audit', async () => {
      const tokenRes = await service.createUploadUrl(buildUploadUrlDto(), selfPayload);
      await fakeUploadToLocal(tokenRes.key, 1024);

      const beforeAttCount = await prisma.attachment.count();
      const logSpy = jest
        .spyOn(auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        service.confirmUpload({ uploadToken: tokenRes.uploadToken }, selfPayload, AUDIT_META),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      // 回滚证据 1:无新 attachment(tx.attachment.create 已发起但 $transaction 回滚)
      expect(await prisma.attachment.count()).toBe(beforeAttCount);

      // 回滚证据 2:无 audit 落库
      expect(await prisma.auditLog.count({ where: { event: UPLOAD_EVENT } })).toBe(0);
    });

    it('D3. delete 路径 auditLogs.log 抛错 → $transaction 回滚:attachment 未物理删 + 无 delete audit', async () => {
      const created = await service.create(buildCreateDto(), selfPayload, AUDIT_META);
      // 清掉 create 路径的 upload audit,保证 D3 起始时 audit 表是干净的
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');

      const logSpy = jest
        .spyOn(auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(service.delete(created.id, selfPayload, AUDIT_META)).rejects.toThrow(
        'simulated audit failure',
      );
      expect(logSpy).toHaveBeenCalledTimes(1);

      // 回滚证据 1:attachment 仍存在(tx 内 tx.attachment.delete 已发起但 $transaction 回滚)
      const stillThere = await prisma.attachment.findUnique({ where: { id: created.id } });
      expect(stillThere).not.toBeNull();

      // 回滚证据 2:无 delete audit 落库
      expect(await prisma.auditLog.count({ where: { event: DELETE_EVENT } })).toBe(0);
    });
  });

  // ============ E. Wrong-path no-audit(沿 D6 F6 fail-fast) ============
  describe('E. wrong-path no-audit', () => {
    beforeEach(isolateFixtures);

    it('E1. ownerType invalid → ATTACHMENT_OWNER_TYPE_INVALID,无 audit', async () => {
      await expect(
        service.create(buildCreateDto({ ownerType: 'no-such-type' }), superPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ATTACHMENT_OWNER_TYPE_INVALID });

      expect(await prisma.auditLog.count()).toBe(0);
      expect(await prisma.attachment.count()).toBe(0);
    });

    it('E2. mime blocked(系统级黑名单)→ ATTACHMENT_SYSTEM_MIME_BLOCKED,无 audit', async () => {
      await expect(
        service.create(buildCreateDto({ mime: 'application/zip' }), superPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED });

      expect(await prisma.auditLog.count()).toBe(0);
      expect(await prisma.attachment.count()).toBe(0);
    });

    it('E3. size exceeded → ATTACHMENT_SIZE_EXCEEDED,无 audit', async () => {
      await expect(
        service.create(buildCreateDto({ size: 100_000_000 }), superPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ATTACHMENT_SIZE_EXCEEDED });

      expect(await prisma.auditLog.count()).toBe(0);
      expect(await prisma.attachment.count()).toBe(0);
    });

    it('E4. PII detected(身份证号)→ ATTACHMENT_PII_DETECTED,无 audit', async () => {
      await expect(
        service.create(
          buildCreateDto({ description: '身份证 11010119900101123X' }),
          superPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ATTACHMENT_PII_DETECTED });

      expect(await prisma.auditLog.count()).toBe(0);
      expect(await prisma.attachment.count()).toBe(0);
    });

    it('E5. RBAC forbidden(selfPayload 上传 memberB → 无 .other 权限)→ RBAC_FORBIDDEN,无 audit', async () => {
      await expect(
        service.create(buildCreateDto({ ownerId: memberB.id }), selfPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });

      expect(await prisma.auditLog.count()).toBe(0);
      expect(await prisma.attachment.count()).toBe(0);
    });

    it('E6. delete 不存在(13001)→ ATTACHMENT_NOT_FOUND,无 audit', async () => {
      await expect(
        service.delete('cl0000000000000000000000', superPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ATTACHMENT_NOT_FOUND });

      expect(await prisma.auditLog.count()).toBe(0);
    });
  });
});
