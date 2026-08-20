import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { conformingAttachmentKey } from '../helpers/attachment-key';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * issue #1055 T2 DoD ③ —— **通用 Attachment 接口对两个视觉身份 owner type 恒 fail-closed**。
 *
 * ## 为什么这条必须有负面用例,而不能只写在文档里
 *
 * 通用接口只知道「这个文件归谁」,证明不了领域不变量:
 * 「头像必须是本人的」「一个 Member 至多一张 ACTIVE 标准照」「替换要版本化」。
 * 一旦通用 `POST /admin/v1/attachments` 能直接造一条 `ownerType='user-avatar'` 的附件,
 * 上面三条就全部可以绕过去 —— 而且**不会有任何东西报错**。
 *
 * ## 用 SUPER_ADMIN 打,是刻意的
 *
 * SUPER_ADMIN 在本仓会**短路 RBAC**。如果这些请求被 403 挡住,证明的只是「权限没配」,
 * 不是「这条路走不通」;换个权限配置就可能重新打开。用最高权限打,红的就只可能是
 * owner-type 这道结构闸本身。
 *
 * ## 期望是 404 而不是 400
 *
 * fail-closed 路径抛 `ATTACHMENT_NOT_FOUND` —— 通用接口**连「这个 owner type 存在」
 * 都不确认**。返 400「owner type 非法」反而会告诉调用方「有这么个类型,只是你不能用」。
 */
describe('视觉身份 owner type 在通用 Attachment 接口上 fail-closed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAuth: string;
  let memberId: string;
  let userId: string;
  let sequence = 0;

  const unique = (label: string) => `vi-failclosed-${label}-${(sequence += 1)}`;

  const VISUAL_IDENTITY_OWNER_TYPES = ['user-avatar', 'member-official-portrait'] as const;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);

    const superUsername = unique('super');
    await createTestUser(app, { username: superUsername, role: Role.SUPER_ADMIN });
    superAuth = (await loginAs(app, superUsername)).authHeader;

    const member = await prisma.member.create({
      data: { memberNo: unique('no'), ...memberIdentityData('视觉身份测试队员') },
      select: { id: true },
    });
    memberId = member.id;
    const owner = await createTestUser(app, { username: unique('owner') });
    userId = owner.id;

    // resetDb 会清空 attachment_type_configs,所以三条配置行都要在 spec 里自己建。
    // 两个视觉身份 owner 的配置行**刻意建出来** —— 否则「被挡」可能只是因为配置不存在,
    // 而不是因为 internal-only 闸在起作用。要挡的是「配置齐全但仍然不许走通用接口」。
    await prisma.attachmentTypeConfig.createMany({
      data: [
        {
          code: 'member',
          displayName: '队员附件',
          ownerTable: 'member',
          defaultMaxSizeBytes: 5_242_880,
          defaultMimeWhitelist: ['image/jpeg', 'image/png'],
        },
        {
          code: 'user-avatar',
          displayName: '账号头像',
          ownerTable: 'User',
          defaultMaxSizeBytes: 10_485_760,
          defaultMimeWhitelist: ['image/jpeg', 'image/png'],
        },
        {
          code: 'member-official-portrait',
          displayName: '队员标准照',
          ownerTable: 'Member',
          defaultMaxSizeBytes: 10_485_760,
          defaultMimeWhitelist: ['image/jpeg', 'image/png'],
        },
      ],
    });
  });

  /** 直插一条视觉身份附件(模拟 facade 落库的结果),用来测读 / 改 / 删三个面。 */
  const insertVisualIdentityAttachment = async (ownerType: string): Promise<string> => {
    const row = await prisma.attachment.create({
      data: {
        key: conformingAttachmentKey(),
        originalName: 'portrait.jpg',
        mime: 'image/jpeg',
        size: 2048,
        uploadedBy: userId,
        ownerType,
        ownerId: ownerType === 'user-avatar' ? userId : memberId,
      },
      select: { id: true },
    });
    return row.id;
  };

  describe.each(VISUAL_IDENTITY_OWNER_TYPES)('%s', (ownerType) => {
    const ownerIdFor = () => (ownerType === 'user-avatar' ? userId : memberId);

    it('通用 create 被拒', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send({
          key: conformingAttachmentKey(),
          originalName: 'x.jpg',
          mime: 'image/jpeg',
          size: 1024,
          ownerType,
          ownerId: ownerIdFor(),
        });
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND, { strictMessage: false });
    });

    it('通用 upload-url 被拒', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        // ⚠️ 不传 `size` —— `GenerateUploadUrlDto` 里没有这个字段,多传会被
        // ValidationPipe 以 400 挡在 owner-type 闸**之前**,那测的就不是 fail-closed 了。
        .send({
          originalName: 'x.jpg',
          mime: 'image/jpeg',
          sizeBytes: 1024,
          ownerType,
          ownerId: ownerIdFor(),
        });
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND, { strictMessage: false });
    });

    it('通用 detail 读不到(即便附件真实存在)', async () => {
      const id = await insertVisualIdentityAttachment(ownerType);
      // 先钉前提:这条附件确实在库里。否则 404 可能只是「本来就没有」。
      expect(await prisma.attachment.count({ where: { id } })).toBe(1);

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/${id}`)
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND, { strictMessage: false });
    });

    it('通用 update 被拒', async () => {
      const id = await insertVisualIdentityAttachment(ownerType);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attachments/${id}`)
        .set('Authorization', superAuth)
        .send({ description: '试图改内部资产' });
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND, { strictMessage: false });

      // 不只是「返回 404」——**行必须原样还在**,不能被改了又报错。
      const row = await prisma.attachment.findUnique({
        where: { id },
        select: { description: true },
      });
      expect(row?.description).toBeNull();
    });

    it('通用 delete 被拒,且附件仍在', async () => {
      const id = await insertVisualIdentityAttachment(ownerType);
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attachments/${id}`)
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND, { strictMessage: false });
      expect(await prisma.attachment.count({ where: { id } })).toBe(1);
    });

    it('通用 list 按它筛 → 空页,且 total 也不泄露', async () => {
      await insertVisualIdentityAttachment(ownerType);
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments')
        .query({ ownerType, page: 1, pageSize: 20 })
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      // total 泄露 = 告诉调用方「有 N 条你看不到的」,本身就是信息泄露。
      expect(res.body.data.total).toBe(0);
    });

    it('通用 by-owner 按它查 → 空', async () => {
      await insertVisualIdentityAttachment(ownerType);
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments/by-owner')
        .query({ ownerType, ownerId: ownerIdFor() })
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      // 返的是**分页信封**不是裸数组;顺便把 total 也钉住 ——
      // 「有 N 条你看不到的」本身就是信息泄露。
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });
  });

  it('不带 ownerType 的通用 list 也不会把视觉身份附件混进来', async () => {
    const avatarId = await insertVisualIdentityAttachment('user-avatar');
    const portraitId = await insertVisualIdentityAttachment('member-official-portrait');
    const memberAttachment = await prisma.attachment.create({
      data: {
        key: conformingAttachmentKey(),
        originalName: 'ordinary.jpg',
        mime: 'image/jpeg',
        size: 1024,
        uploadedBy: userId,
        ownerType: 'member',
        ownerId: memberId,
      },
      select: { id: true },
    });

    const res = await request(httpServer(app))
      .get('/api/admin/v1/attachments')
      .query({ page: 1, pageSize: 50 })
      .set('Authorization', superAuth);
    expect(res.status).toBe(200);

    const ids: string[] = res.body.data.items.map((item: { id: string }) => item.id);
    // ⚠️ **反向对照**:普通 owner 的附件必须**在**结果里。
    // 少了这一句,一个「列表永远返回空」的实现也会让上面两条 not-contain 全绿 ——
    // 那时候挡住的不是内部资产,是整个列表功能。
    expect(ids).toContain(memberAttachment.id);
    expect(ids).not.toContain(avatarId);
    expect(ids).not.toContain(portraitId);
  });

  it('普通 owner type 走同样的通用接口**必须成功**(证明闸是定向的,不是把接口关了)', async () => {
    // ⚠️ 用 `upload-url` 而不是 `create` 做正向对照:通用 `POST /attachments` 是
    // 「登记一个**已经上传好**的对象」,它会去 storage 验 HEAD 证据 ——
    // 没真往 provider 放字节就必然 404,那个 404 与 owner-type 闸毫无关系,
    // 拿它当对照会得出「闸把整个接口关了」的错误结论(第一版就踩了这个)。
    const res = await request(httpServer(app))
      .post('/api/admin/v1/attachments/upload-url')
      .set('Authorization', superAuth)
      .send({
        originalName: 'ordinary.jpg',
        mime: 'image/jpeg',
        sizeBytes: 1024,
        ownerType: 'member',
        ownerId: memberId,
      });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.uploadUrl).toBe('string');
  });
});
