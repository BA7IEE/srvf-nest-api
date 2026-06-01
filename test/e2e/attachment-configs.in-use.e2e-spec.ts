import type { INestApplication } from '@nestjs/common';
import { AttachmentMimeConfigStatus, AttachmentTypeConfigStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x Slow-6 跨表引用约束 e2e(2026-05-16):配置三表 softDelete / updateStatus → INACTIVE
// 时若仍被 attachment 引用,统一拒绝并返对应 13030 / 13031 / 13032。
//
// 沿 D7-attachments v1.0 §8.1 + Step 1 调研报告 + 用户 Q-cross 全 A 拍板:
// - type config IN_USE → 13030(by attachment.ownerType = type.code)
// - mime config IN_USE → 13031(by attachment.ownerType = type.code AND attachment.mime = mime)
// - size limit config IN_USE → 13032(通过 typeConfigId → typeConfig.code → attachment.ownerType)
// - softDelete + updateStatus → INACTIVE 双路径对称(防绕过;Q-cross-3 A)
// - INACTIVE → ACTIVE / 同状态等不触发检查(只挡破坏性变更)
// - refCount > 0 即拒绝;不在 message / extra 暴露引用数(Q-cross-impl-4 A;v1 §10 信息泄漏防御)
// - 普通 update(改文案 / 数值)不检查(Q-cross-6 A);本 spec 不覆盖
// - RBAC 入口已在 PR #74-#75 验证,本 spec 全部用 SUPER_ADMIN(沿 Q-cross-impl-2 A 范式)

const SUPER_USERNAME = 'cfg-inuse-su';

describe('attachment-configs 跨表引用约束(V2.x Slow-6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAuth: string;
  let superId: string;
  let memberId: string;
  // 注意:loginAs 返回 AuthCredentials,要取 .authHeader 给 supertest .set('Authorization', ...)

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const superUser = await createTestUser(app, {
      username: SUPER_USERNAME,
      role: Role.SUPER_ADMIN,
    });
    superId = superUser.id;
    const auth = await loginAs(app, SUPER_USERNAME);
    superAuth = auth.authHeader;

    // 创建一个 member 作为 attachment.ownerId 引用目标
    const member = await prisma.member.create({
      data: { memberNo: 'M-INUSE-001', displayName: 'InUseMember' },
      select: { id: true },
    });
    memberId = member.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 it 之间清干净 attachment + 配置三表(避免相互污染)
  beforeEach(async () => {
    await prisma.attachment.deleteMany({});
    await prisma.attachmentMimeConfig.deleteMany({});
    await prisma.attachmentSizeLimitConfig.deleteMany({});
    await prisma.attachmentTypeConfig.deleteMany({});
  });

  // 创建 type config 的辅助函数(每个测试用唯一 code 避免 unique 撞库)
  async function createTypeConfig(code: string): Promise<{ id: string; code: string }> {
    const tc = await prisma.attachmentTypeConfig.create({
      data: {
        code,
        displayName: `测试 ${code}`,
        ownerTable: 'member',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg', 'image/png'],
      },
      select: { id: true, code: true },
    });
    return tc;
  }

  // 创建一条 attachment 引用指定 ownerType + mime
  async function createAttachment(
    ownerType: string,
    mime: string,
    keySuffix: string,
  ): Promise<void> {
    await prisma.attachment.create({
      data: {
        key: `inuse-test-${keySuffix}`,
        originalName: 'test.jpg',
        mime,
        size: 1024,
        uploadedBy: superId,
        ownerType,
        ownerId: memberId,
      },
    });
  }

  // ============ type config IN_USE ============

  describe('type config IN_USE', () => {
    it('用例 1:type softDelete 仍被附件引用 → 13030', async () => {
      const tc = await createTypeConfig('inuse-type-1');
      await createAttachment(tc.code, 'image/jpeg', 't1');

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/attachment-type-configs/${tc.id}`)
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_TYPE_IN_USE);

      // 状态未改:仍 ACTIVE 且 deletedAt = null
      const after = await prisma.attachmentTypeConfig.findUnique({
        where: { id: tc.id },
        select: { status: true, deletedAt: true },
      });
      expect(after?.status).toBe(AttachmentTypeConfigStatus.ACTIVE);
      expect(after?.deletedAt).toBeNull();
    });

    it('用例 2:type updateStatus → INACTIVE 仍被附件引用 → 13030', async () => {
      const tc = await createTypeConfig('inuse-type-2');
      await createAttachment(tc.code, 'image/jpeg', 't2');

      const res = await request(httpServer(app))
        .patch(`/api/system/v1/attachment-type-configs/${tc.id}/status`)
        .set('Authorization', superAuth)
        .send({ status: AttachmentTypeConfigStatus.INACTIVE });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_IN_USE);

      const after = await prisma.attachmentTypeConfig.findUnique({
        where: { id: tc.id },
        select: { status: true },
      });
      expect(after?.status).toBe(AttachmentTypeConfigStatus.ACTIVE);
    });

    it('用例 3:type 无 attachment 引用时可 softDelete', async () => {
      const tc = await createTypeConfig('inuse-type-3');
      // 无 attachment 引用此 code

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/attachment-type-configs/${tc.id}`)
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);

      const after = await prisma.attachmentTypeConfig.findUnique({
        where: { id: tc.id },
        select: { status: true, deletedAt: true },
      });
      expect(after?.status).toBe(AttachmentTypeConfigStatus.INACTIVE);
      expect(after?.deletedAt).not.toBeNull();
    });
  });

  // ============ mime config IN_USE ============

  describe('mime config IN_USE', () => {
    it('用例 4:mime softDelete 仍被附件(同 type 同 mime)引用 → 13031', async () => {
      const tc = await createTypeConfig('inuse-mime-1');
      const mc = await prisma.attachmentMimeConfig.create({
        data: { typeConfigId: tc.id, mime: 'image/png' },
        select: { id: true },
      });
      await createAttachment(tc.code, 'image/png', 'm4');

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/attachment-mime-configs/${mc.id}`)
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_IN_USE);

      const after = await prisma.attachmentMimeConfig.findUnique({
        where: { id: mc.id },
        select: { status: true, deletedAt: true },
      });
      expect(after?.status).toBe(AttachmentMimeConfigStatus.ACTIVE);
      expect(after?.deletedAt).toBeNull();
    });

    it('用例 5:mime updateStatus → INACTIVE 仍被附件引用 → 13031', async () => {
      const tc = await createTypeConfig('inuse-mime-2');
      const mc = await prisma.attachmentMimeConfig.create({
        data: { typeConfigId: tc.id, mime: 'image/png' },
        select: { id: true },
      });
      await createAttachment(tc.code, 'image/png', 'm5');

      const res = await request(httpServer(app))
        .patch(`/api/system/v1/attachment-mime-configs/${mc.id}/status`)
        .set('Authorization', superAuth)
        .send({ status: AttachmentMimeConfigStatus.INACTIVE });
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_IN_USE);
    });

    it('用例 6:mime softDelete 同 type 但不同 mime 在用时可删除', async () => {
      const tc = await createTypeConfig('inuse-mime-3');
      const mcPng = await prisma.attachmentMimeConfig.create({
        data: { typeConfigId: tc.id, mime: 'image/png' },
        select: { id: true },
      });
      // attachment 用的是 jpeg(同 type 但不同 mime),不应阻止删 png 配置
      await createAttachment(tc.code, 'image/jpeg', 'm6');

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/attachment-mime-configs/${mcPng.id}`)
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);

      const after = await prisma.attachmentMimeConfig.findUnique({
        where: { id: mcPng.id },
        select: { status: true, deletedAt: true },
      });
      expect(after?.status).toBe(AttachmentMimeConfigStatus.INACTIVE);
      expect(after?.deletedAt).not.toBeNull();
    });
  });

  // ============ size limit config IN_USE ============

  describe('size limit config IN_USE', () => {
    it('用例 7:size softDelete 同 type 仍被附件引用 → 13032', async () => {
      const tc = await createTypeConfig('inuse-size-1');
      const sc = await prisma.attachmentSizeLimitConfig.create({
        data: { typeConfigId: tc.id, maxSizeBytes: 1_048_576 },
        select: { id: true },
      });
      await createAttachment(tc.code, 'image/jpeg', 's7');

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/attachment-size-limit-configs/${sc.id}`)
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_IN_USE);

      const after = await prisma.attachmentSizeLimitConfig.findUnique({
        where: { id: sc.id },
        select: { deletedAt: true },
      });
      expect(after?.deletedAt).toBeNull();
    });

    it('用例 8:size 同 type 无 attachment 引用时可 softDelete', async () => {
      const tc = await createTypeConfig('inuse-size-2');
      const sc = await prisma.attachmentSizeLimitConfig.create({
        data: { typeConfigId: tc.id, maxSizeBytes: 1_048_576 },
        select: { id: true },
      });
      // 无 attachment 引用此 type.code

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/attachment-size-limit-configs/${sc.id}`)
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);

      const after = await prisma.attachmentSizeLimitConfig.findUnique({
        where: { id: sc.id },
        select: { deletedAt: true },
      });
      expect(after?.deletedAt).not.toBeNull();
    });
  });
});
