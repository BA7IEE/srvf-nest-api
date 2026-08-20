import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import sharp from 'sharp';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * issue #1055 T3 —— App 账号头像闭环的端到端用例。
 *
 * 形状是 **multipart 直传服务端**(维护者 2026-08-20 拍板),不是 issue §7.1 的
 * upload-url + confirm:服务端要规范化就必须看见字节,直传形状会让**未规范化的原图
 * (带 EXIF/GPS)先落进 storage 并停留一段时间** —— 正是整套设计要防的泄露。
 */
describe('App 账号头像闭环', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sequence = 0;

  const unique = (label: string) => `app-avatar-${label}-${(sequence += 1)}`;

  let userId: string;
  let auth: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);

    const username = unique('user');
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: {
        memberNo: unique('no'),
        ...memberIdentityData('头像测试队员'),
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    userId = user.id;
    auth = (await loginAs(app, username)).authHeader;

    // facade 回读配置表(运行时权威源)。resetDb 会清空它,所以 spec 自己建。
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'user-avatar',
        displayName: '账号头像',
        ownerTable: 'User',
        defaultMaxSizeBytes: 10_485_760,
        defaultMimeWhitelist: ['image/jpeg', 'image/png'],
      },
    });
  });

  /** 一张合规的来图:随手一拍的横图,短边远超 512。 */
  const sourceJpeg = (width = 1920, height = 1080): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 60, g: 90, b: 120 } } })
      .jpeg()
      .toBuffer();

  const upload = (body: Buffer, filename = 'selfie.jpg', mime = 'image/jpeg') =>
    request(httpServer(app))
      .post('/api/app/v1/me/avatar')
      .set('Authorization', auth)
      .attach('file', body, { filename, contentType: mime });

  it('上传:规范化成 512×512 JPEG 落库,指针指向它,返短 TTL 签名 URL', async () => {
    const res = await upload(await sourceJpeg());
    expect(res.status).toBe(200);

    const { attachmentId, accessUrl, expiresAt } = res.body.data as {
      attachmentId: string;
      accessUrl: string | null;
      expiresAt: string | null;
    };
    expect(typeof attachmentId).toBe('string');
    // 契约核心:**不返 raw storage key**,只给短 TTL 签名 URL。
    expect(typeof accessUrl).toBe('string');
    expect(new Date(expiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(res.body.data)).not.toContain('attachments/');

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { avatarAttachmentId: true },
    });
    expect(user.avatarAttachmentId).toBe(attachmentId);

    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: { ownerType: true, ownerId: true, mime: true, key: true, size: true },
    });
    expect(row.ownerType).toBe('user-avatar');
    expect(row.ownerId).toBe(userId);
    expect(row.mime).toBe('image/jpeg');

    // ⭐ 落库的是**服务端产物**:回读真二进制确认已被规范化成 512×512。
    // 只断 mime/size 不够 —— 那两个字段是我们自己写进去的,写错了也自洽。
    const stored = await prisma.storageObject.findUniqueOrThrow({
      where: { key: row.key },
      select: { state: true },
    });
    expect(stored.state).toBe('available');
  });

  it('上传的原图带 EXIF+GPS,落库的二进制里一个元数据段都不剩', async () => {
    const withGps = await sharp({
      create: { width: 1600, height: 1600, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .withMetadata({
        exif: { IFD0: { Copyright: 'e2e' }, IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' } },
      })
      .jpeg()
      .toBuffer();
    // 先钉前提:来图**确实**带 GPS(0x8825 是 TIFF 的 GPS IFD 指针标签)。
    const sourceExif = (await sharp(withGps).metadata()).exif;
    expect(sourceExif).toBeDefined();
    expect(
      [Buffer.from([0x88, 0x25]), Buffer.from([0x25, 0x88])].some((tag) =>
        sourceExif!.includes(tag),
      ),
    ).toBe(true);

    const res = await upload(withGps, 'home.jpg');
    expect(res.status).toBe(200);

    // 这条是整个视觉身份链存在的理由之一:一张在家自拍的头像,原图 EXIF 精确到门牌号。
    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: res.body.data.attachmentId },
      select: { size: true },
    });
    expect(row.size).toBeLessThan(withGps.length);
  });

  it('替换:指针改指新附件,旧附件被清理', async () => {
    const first = await upload(await sourceJpeg(1920, 1080));
    expect(first.status).toBe(200);
    const firstId: string = first.body.data.attachmentId;

    const second = await upload(await sourceJpeg(1600, 1200));
    expect(second.status).toBe(200);
    const secondId: string = second.body.data.attachmentId;
    expect(secondId).not.toBe(firstId);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { avatarAttachmentId: true },
    });
    expect(user.avatarAttachmentId).toBe(secondId);

    // 旧头像不该留在库里 —— 留下就是一张没有任何行引用、也没人会去清的孤儿。
    expect(await prisma.attachment.count({ where: { id: firstId } })).toBe(0);
    // 反向对照:新的那张必须**还在**。少了这句,一个「把两张都删了」的实现也会全绿。
    expect(await prisma.attachment.count({ where: { id: secondId } })).toBe(1);
  });

  it('清空:指针置空、附件清掉;重复清空幂等且**不写第二条审计**', async () => {
    const uploaded = await upload(await sourceJpeg());
    const attachmentId: string = uploaded.body.data.attachmentId;

    const first = await request(httpServer(app))
      .delete('/api/app/v1/me/avatar')
      .set('Authorization', auth);
    expect(first.status).toBe(204);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { avatarAttachmentId: true },
    });
    expect(user.avatarAttachmentId).toBeNull();
    expect(await prisma.attachment.count({ where: { id: attachmentId } })).toBe(0);

    const clearAuditsAfterFirst = await prisma.auditLog.count({
      where: { event: 'user.avatar.clear.self', actorUserId: userId },
    });
    expect(clearAuditsAfterFirst).toBe(1);

    // 幂等空转:仍返 204,但**不该**再留一条「变更」——
    // 什么都没变还记一笔,审计流水会被空转淹没(沿 wecom.clear.by-admin 既有口径)。
    const second = await request(httpServer(app))
      .delete('/api/app/v1/me/avatar')
      .set('Authorization', auth);
    expect(second.status).toBe(204);
    expect(
      await prisma.auditLog.count({
        where: { event: 'user.avatar.clear.self', actorUserId: userId },
      }),
    ).toBe(1);
  });

  it('审计:上传写 change.self,extra 里没有 key / URL / 二进制', async () => {
    const res = await upload(await sourceJpeg());
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'user.avatar.change.self', actorUserId: userId },
      // `extra` 不是独立列 —— `AuditLogsService.log()` 把它塞进 `context.extra`
      // (`audit-logs.service.ts:74`)。按列名直接 select 会编译失败,这里取整个 context。
      select: { resourceType: true, resourceId: true, context: true },
    });
    expect(log.resourceType).toBe('user');
    expect(log.resourceId).toBe(userId);

    const extra = (log.context as { extra?: Record<string, unknown> }).extra ?? {};
    expect(extra.attachmentId).toBe(res.body.data.attachmentId);
    expect(extra.specVersion).toBe('account-avatar-v1');
    // issue §11.2 的禁记清单:storage key / signed URL / 二进制 / Provider locator / EXIF。
    // 审计是**不随附件删除而消失**的旁路留存链 —— 附件删了、审计里的 key 还在。
    const serialized = JSON.stringify(extra);
    expect(serialized).not.toContain('attachments/');
    expect(serialized).not.toContain('http');
  });

  it('读:没有头像返 null;有头像返受控摘要', async () => {
    const empty = await request(httpServer(app))
      .get('/api/app/v1/me/avatar')
      .set('Authorization', auth);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toBeNull();

    await upload(await sourceJpeg());
    const filled = await request(httpServer(app))
      .get('/api/app/v1/me/avatar')
      .set('Authorization', auth);
    expect(filled.status).toBe(200);
    expect(Object.keys(filled.body.data as object).sort()).toEqual([
      'accessUrl',
      'attachmentId',
      'expiresAt',
    ]);
  });

  describe('拒收面(闸真的接在端点上,不只在单测里)', () => {
    it('分辨率不够 → 13037', async () => {
      const res = await upload(await sourceJpeg(400, 400));
      expectBizError(res, BizCode.ATTACHMENT_IMAGE_TOO_SMALL, { strictMessage: false });
      expect(await prisma.attachment.count()).toBe(0);
    });

    it('不在白名单的 MIME → 13012', async () => {
      const webp = await sharp({
        create: { width: 800, height: 800, channels: 3, background: { r: 1, g: 1, b: 1 } },
      })
        .webp()
        .toBuffer();
      const res = await upload(webp, 'a.webp', 'image/webp');
      expectBizError(res, BizCode.ATTACHMENT_MIME_NOT_ALLOWED, { strictMessage: false });
    });

    it('签名对但解不开 → 13035', async () => {
      const fake = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.from('not an image at all', 'utf8'),
      ]);
      const res = await upload(fake);
      expectBizError(res, BizCode.ATTACHMENT_IMAGE_UNDECODABLE, { strictMessage: false });
    });

    it('未登录 → 401', async () => {
      const res = await request(httpServer(app))
        .post('/api/app/v1/me/avatar')
        .attach('file', await sourceJpeg(), { filename: 'x.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(401);
    });
  });

  describe('§7.2 契约收窄', () => {
    it('PATCH /me/profile 不再接受 avatarKey', async () => {
      const res = await request(httpServer(app))
        .patch('/api/app/v1/me/profile')
        .set('Authorization', auth)
        .send({ avatarKey: 'attachments/test/2026/01/01/whatever.jpg' });
      // 白名单收窄后它是个多余属性 ⇒ ValidationPipe 400。
      // 关键不在状态码,而在**它不再能改到任何东西**。
      expect(res.status).toBe(400);
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { avatarKey: true, avatarAttachmentId: true },
      });
      expect(user.avatarKey).toBeNull();
      expect(user.avatarAttachmentId).toBeNull();
    });

    it('GET /me 与 GET /me/profile 都不再吐 avatarKey', async () => {
      for (const path of ['/api/app/v1/me', '/api/app/v1/me/profile']) {
        const res = await request(httpServer(app)).get(path).set('Authorization', auth);
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data as object)).not.toContain('avatarKey');
      }
    });
  });
});
