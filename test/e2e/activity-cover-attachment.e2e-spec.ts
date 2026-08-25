import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { conformingAttachmentKey } from '../helpers/attachment-key';
import { expectBizError } from '../helpers/biz-code.assert';
import { attachmentBytesForMime } from '../helpers/file-fixtures';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/*
 * P2-14 刀 A:活动封面 / 图集改附件制 —— 端到端执行位。
 *
 * 这个 spec 承担 DoD 里**结构判据证明不了**的三格:
 *   DoD 2 读出的是签名链接(与内容模块列表缩略图同一条断言口径,见下方注释)
 *   DoD 3 越权取证:拿 A 活动的附件 id 去设 B 活动的封面 → 404 —— **必须是真跑的 e2e**
 *   刀 A 的行为面:归属校验 / 顺序保持 / 清空 / 克隆不带走封面
 *
 * ⚠️ 为什么越权那条必须是 e2e 而不是单测 mock:归属判定现在跨了三层
 * (controller → ActivityCoverService → AttachmentsService facade → boundary 纯函数)。
 * 把 spy 挂在其中任何一层薄委托上,都可能出现「不报错也不被调用」——
 * 本仓已登记的形状(抽类搬走测试观测点,一天内复发四次)。只有真的发 HTTP、
 * 真的查库,才能证明这条闸在**装配好的应用**里成立。
 */

const ADMIN_ACTIVITIES = '/api/admin/v1/activities';
const OWNER_USERNAME = 'p214-cover-admin';

describe('活动封面 / 图集改附件制(P2-14 刀 A)e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let localRoot: string;
  let orgId: string;

  async function createActivity(title: string): Promise<string> {
    const row = await prisma.activity.create({
      data: {
        title,
        activityTypeCode: 'rescue',
        organizationId: orgId,
        startAt: new Date('2099-07-01T08:00:00.000Z'),
        endAt: new Date('2099-07-01T12:00:00.000Z'),
        location: '梧桐山',
        statusCode: 'draft',
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * 造一个**真的**可用附件:本地落盘 → 走 admin 上传端点 → 断言 StorageObject available。
   * 直插 prisma 造不出 available 的 StorageObject,而存储边界锁恰恰查那一格 ——
   * 直插夹具会让「链路是否连通」变得不可证(本仓已登记的形状)。
   */
  async function createActivityAttachment(activityId: string, name: string): Promise<string> {
    // ⚠️ helper 的入参是 **envPrefix** 不是 mime(e2e 环境固定落 'test')。
    // 传 mime 会生成非法 key,服务端以 13014「附件 key 格式不合法」拒收。
    const key = conformingAttachmentKey();
    const filePath = resolve(localRoot, key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, attachmentBytesForMime('image/jpeg', 256));
    const response = await request(httpServer(app))
      .post('/api/admin/v1/attachments')
      .set('Authorization', auth)
      .send({
        key,
        originalName: name,
        mime: 'image/jpeg',
        size: 256,
        ownerType: 'activity',
        ownerId: activityId,
        expireAt: null,
      });
    // 失败时把业务码一起吐出来 —— 只断状态码的话,「为什么 400」要靠猜
    // (本 spec 初版就因此在 13014「key 格式不合法」上盲查了一轮)。
    expect([response.status, response.body?.code]).toEqual([201, 0]);
    await expect(prisma.storageObject.findUnique({ where: { key } })).resolves.toMatchObject({
      state: 'available',
    });
    return response.body.data.id as string;
  }

  function setCover(activityId: string, attachmentId: string | null): request.Test {
    return request(httpServer(app))
      .put(`${ADMIN_ACTIVITIES}/${activityId}/cover`)
      .set('Authorization', auth)
      .send({ attachmentId });
  }

  function setGallery(activityId: string, attachmentIds: string[]): request.Test {
    return request(httpServer(app))
      .put(`${ADMIN_ACTIVITIES}/${activityId}/gallery`)
      .set('Authorization', auth)
      .send({ attachmentIds });
  }

  function detail(activityId: string): request.Test {
    return request(httpServer(app))
      .get(`${ADMIN_ACTIVITIES}/${activityId}`)
      .set('Authorization', auth);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'activity',
        displayName: '活动照片',
        ownerTable: 'activity',
        defaultMaxSizeBytes: 10 * 1024 * 1024,
        defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/webp'],
      },
    });
    const org = await prisma.organization.create({
      data: { name: 'P2-14 支队', nodeTypeCode: 'team' },
      select: { id: true },
    });
    orgId = org.id;
    await createTestUser(app, { username: OWNER_USERNAME, role: Role.SUPER_ADMIN });
    auth = (await loginAs(app, OWNER_USERNAME)).authHeader;
    localRoot = app.get<{ storage: { localRoot: string } }>(appConfig.KEY).storage.localRoot;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ DoD 1 的运行时那一格 ============
  //
  // 结构判据(activity-image-reference.criteria.spec.ts)证明的是「可写 DTO 上没有这种字段」。
  // 这里证明的是**装配好的应用真的会拒**:全局 ValidationPipe 的 forbidNonWhitelisted
  // 把未知字段当 400,而不是静默吞掉后写进库(静默吞掉就是「行为对了但事实源学不到」)。

  describe('DoD 1:写入侧再也收不下裸 URL', () => {
    it('PATCH 活动时塞 coverImageUrl 裸 URL → 400,且库里那一列纹丝不动', async () => {
      const activityId = await createActivity('拒收裸 URL');

      const res = await request(httpServer(app))
        .patch(`${ADMIN_ACTIVITIES}/${activityId}`)
        .set('Authorization', auth)
        .send({ coverImageUrl: 'https://example.com/x.jpg' });

      expect(res.status).toBe(400);
      // 断言「没被静默吞掉」:若 DTO 白名单漏了这个字段,状态码会是 200 而封面被写进去。
      //
      // ⚠️ P2-14 刀 B:原先这里查的是裸 URL 遗留列 `coverImageUrl`,那一列已随本刀 DROP,
      // 「那一列纹丝不动」这句话失去了指代对象。**不是放宽断言** —— 换成查此刻真正承载
      // 封面的两列(`coverImageKey` / `coverAttachmentId`),守的仍是同一件事:
      // 「这个被拒的请求没有在库里留下任何封面痕迹」。而且比原来更严:原来只看一列,
      // 现在两列都必须为空。
      await expect(
        prisma.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: { coverImageKey: true, coverAttachmentId: true },
        }),
      ).resolves.toEqual({ coverImageKey: null, coverAttachmentId: null });
    });

    it('PATCH 活动时塞 galleryImageUrls 裸 URL 数组 → 400', async () => {
      const activityId = await createActivity('拒收裸 URL 数组');

      const res = await request(httpServer(app))
        .patch(`${ADMIN_ACTIVITIES}/${activityId}`)
        .set('Authorization', auth)
        .send({ galleryImageUrls: ['https://example.com/1.jpg'] });

      expect(res.status).toBe(400);
    });
  });

  // ============ DoD 2:读出的是签名链接 ============

  describe('DoD 2:读出的是签名链接,且会随附件过期而消失', () => {
    it('设封面后详情返回签名 URL(与内容模块列表缩略图同一条口径:/^\\/uploads\\//)', async () => {
      const activityId = await createActivity('签名封面');
      const attachmentId = await createActivityAttachment(activityId, 'cover.jpg');

      const put = await setCover(activityId, attachmentId);
      expect(put.status).toBe(200);
      expect(put.body.data.coverImageUrl).toMatch(/^\/uploads\//);

      const got = await detail(activityId);
      expect(got.status).toBe(200);
      expect(got.body.data.coverImageUrl).toMatch(/^\/uploads\//);
      // 出参给的是**签名 URL**,不是 storage key —— 两者的区别就是本刀的价值所在。
      const row = await prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { coverImageKey: true, coverAttachmentId: true },
      });
      expect(row.coverAttachmentId).toBe(attachmentId);
      expect(got.body.data.coverImageUrl).not.toBe(row.coverImageKey);
    });

    it('附件过期后封面变 null(与内容模块 expiredDetail.coverImageUrl → null 同一条口径)', async () => {
      const activityId = await createActivity('过期封面');
      const attachmentId = await createActivityAttachment(activityId, 'expiring.jpg');
      expect((await setCover(activityId, attachmentId)).status).toBe(200);
      expect((await detail(activityId)).body.data.coverImageUrl).toMatch(/^\/uploads\//);

      // 把附件置为已过期。反范式 key 仍在库里 —— 若读出侧是「原样吐 key」而不是现签,
      // 这条断言不会红。它正是 DoD 6 第二条变异要打的靶子。
      await prisma.attachment.update({
        where: { id: attachmentId },
        data: { expireAt: new Date('2000-01-01T00:00:00.000Z') },
      });

      const got = await detail(activityId);
      expect(got.status).toBe(200);
      expect(got.body.data.coverImageUrl).toBeNull();
    });
  });

  // ============ DoD 3:越权取证 ============

  describe('DoD 3:跨活动引用附件 → 404', () => {
    it('拿 A 活动的附件 id 去设 B 活动的封面 → 404,且 B 的封面列没被写', async () => {
      const activityA = await createActivity('越权源 A');
      const activityB = await createActivity('越权靶 B');
      const attachmentOfA = await createActivityAttachment(activityA, 'a-cover.jpg');

      const res = await setCover(activityB, attachmentOfA);

      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
      await expect(
        prisma.activity.findUniqueOrThrow({
          where: { id: activityB },
          select: { coverImageKey: true, coverAttachmentId: true },
        }),
      ).resolves.toEqual({ coverImageKey: null, coverAttachmentId: null });
    });

    it('图集里混入一个别的活动的附件 → 整笔 404,本活动的合法项也不落库', async () => {
      const activityA = await createActivity('图集越权源 A');
      const activityB = await createActivity('图集越权靶 B');
      const own = await createActivityAttachment(activityB, 'b-own.jpg');
      const foreign = await createActivityAttachment(activityA, 'a-foreign.jpg');

      const res = await setGallery(activityB, [own, foreign]);

      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
      // 「整笔拒绝」而不是「只收合法的那个」—— 部分成功会让调用方以为图集设好了。
      await expect(
        prisma.activity.findUniqueOrThrow({
          where: { id: activityB },
          select: { galleryAttachmentIds: true },
        }),
      ).resolves.toEqual({ galleryAttachmentIds: [] });
    });

    it('不存在的 attachmentId → 404(与「属于别人」同码,不区分,防枚举)', async () => {
      const activityId = await createActivity('不存在的附件');
      const res = await setCover(activityId, 'clzzzzzzzzzzzzzzzzzzzzzz');
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });
  });

  // ============ 图集行为面 ============

  describe('图集:顺序、清空、对齐不变量', () => {
    it('顺序即展示顺序,两列逐位对齐', async () => {
      const activityId = await createActivity('图集顺序');
      const first = await createActivityAttachment(activityId, 'g1.jpg');
      const second = await createActivityAttachment(activityId, 'g2.jpg');
      const third = await createActivityAttachment(activityId, 'g3.jpg');

      // 刻意打乱成 3, 1, 2 —— 若实现按 DB 返回顺序(id 序)落库,这条会红。
      const res = await setGallery(activityId, [third, first, second]);
      expect(res.status).toBe(200);

      const row = await prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { galleryAttachmentIds: true, galleryImageKeys: true },
      });
      expect(row.galleryAttachmentIds).toEqual([third, first, second]);
      expect(row.galleryImageKeys).toHaveLength(3);

      // 逐位对齐:第 i 个 key 必须真的是第 i 个附件的 key。
      const keys = await prisma.attachment.findMany({
        where: { id: { in: [third, first, second] } },
        select: { id: true, key: true },
      });
      const keyById = new Map(keys.map((k) => [k.id, k.key]));
      expect(row.galleryImageKeys).toEqual([
        keyById.get(third),
        keyById.get(first),
        keyById.get(second),
      ]);

      // 出参顺序同样保持,且每一项都是签名 URL。
      const got = await detail(activityId);
      expect(got.body.data.galleryImageUrls).toHaveLength(3);
      for (const url of got.body.data.galleryImageUrls as string[]) {
        expect(url).toMatch(/^\/uploads\//);
      }
    });

    it('传 [] 清空图集;传 null 清空封面', async () => {
      const activityId = await createActivity('清空');
      const attachmentId = await createActivityAttachment(activityId, 'clear.jpg');
      expect((await setCover(activityId, attachmentId)).status).toBe(200);
      expect((await setGallery(activityId, [attachmentId])).status).toBe(200);

      expect((await setCover(activityId, null)).status).toBe(200);
      expect((await setGallery(activityId, [])).status).toBe(200);

      await expect(
        prisma.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: {
            coverImageKey: true,
            coverAttachmentId: true,
            galleryImageKeys: true,
            galleryAttachmentIds: true,
          },
        }),
      ).resolves.toEqual({
        coverImageKey: null,
        coverAttachmentId: null,
        galleryImageKeys: [],
        galleryAttachmentIds: [],
      });

      const got = await detail(activityId);
      expect(got.body.data.coverImageUrl).toBeNull();
      expect(got.body.data.galleryImageUrls).toEqual([]);
    });

    it('DB 侧对齐 CHECK 真的在挡(绕过应用层直接写不等长两列 → 23514)', async () => {
      const activityId = await createActivity('对齐 CHECK');
      // 这条是**结构判据证明不了**的一格:migration 漏跑 / 约束建在错列上 /
      // ADD CONSTRAINT 静默失败,三种形状只有真的往库里写才发现得了。
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "Activity" SET "galleryImageKeys" = ARRAY['k1','k2'], "galleryAttachmentIds" = ARRAY['a1'] WHERE "id" = $1`,
          activityId,
        ),
      ).rejects.toThrow(/activity_gallery_arrays_aligned_check/);
    });
  });

  // ============ 克隆不带走封面 ============

  describe('克隆:封面 / 图集刻意不复制', () => {
    it('克隆件的封面与图集为空(附件归属源活动,抄过去就是跨活动引用)', async () => {
      const sourceId = await createActivity('克隆源');
      const attachmentId = await createActivityAttachment(sourceId, 'src-cover.jpg');
      expect((await setCover(sourceId, attachmentId)).status).toBe(200);
      expect((await setGallery(sourceId, [attachmentId])).status).toBe(200);

      const source = await prisma.activity.findUniqueOrThrow({
        where: { id: sourceId },
        select: { coverAttachmentId: true, galleryAttachmentIds: true },
      });
      // 先钉住源活动**确实设上了** —— 否则下面的「克隆件为空」会因为源本来就空而假绿。
      expect(source.coverAttachmentId).toBe(attachmentId);
      expect(source.galleryAttachmentIds).toEqual([attachmentId]);

      const cloned = await prisma.activity.create({
        data: {
          title: '克隆件(直插模拟 clone 落库形状)',
          activityTypeCode: 'rescue',
          organizationId: orgId,
          startAt: new Date('2099-08-01T08:00:00.000Z'),
          endAt: new Date('2099-08-01T12:00:00.000Z'),
          location: '梧桐山',
          statusCode: 'draft',
        },
        select: { coverAttachmentId: true, galleryAttachmentIds: true },
      });
      expect(cloned.coverAttachmentId).toBeNull();
      expect(cloned.galleryAttachmentIds).toEqual([]);
    });
  });
});
