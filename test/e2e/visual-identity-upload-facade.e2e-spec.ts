import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import sharp from 'sharp';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { AttachmentVisualIdentityUploadService } from '../../src/modules/attachments/attachment-visual-identity-upload.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * issue #1055 T2 —— 视觉身份可信 facade 的 **Storage E2E**(真 DB + 真 Provider)。
 *
 * ## 为什么直接从 Nest 容器取服务,而不是打 HTTP
 *
 * 本 facade 到 T3(App 头像端点)/ T4(Admin 标准照端点)才有 HTTP 入口。
 * 但**地基不能等到有人踩上去才验** —— 那样 T3/T4 一旦红,得先排除「是 facade 坏了
 * 还是端点接错了」。这里把四阶段逐个驱动一遍,让 T3/T4 拿到的是一个已经证明可用的东西。
 *
 * 事务边界与真实调用方一致:阶段 ②④ 在事务里,阶段 ③(Provider put + HEAD)在事务外 ——
 * 网络调用绝不能待在 DB 事务里,这是仓内铁律,也是这个 facade 被拆成四段的唯一原因。
 */
describe('视觉身份可信 facade —— 四阶段 Storage E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let facade: AttachmentVisualIdentityUploadService;
  let memberId: string;
  let actor: { id: string; username: string; role: Role };
  let sequence = 0;

  const unique = (label: string) => `vi-facade-${label}-${(sequence += 1)}`;
  const auditMeta: AuditMeta = { requestId: 'vi-facade-e2e', ip: null, ua: null };

  /** 一张合规的 5:7 原图。 */
  const portraitSource = (width = 1200, height = 1680): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 180, g: 140, b: 120 } } })
      .jpeg()
      .toBuffer();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    facade = app.get(AttachmentVisualIdentityUploadService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);

    const member = await prisma.member.create({
      data: { memberNo: unique('no'), ...memberIdentityData('facade 测试队员') },
      select: { id: true },
    });
    memberId = member.id;

    const user = await createTestUser(app, { username: unique('actor'), role: Role.ADMIN });
    actor = { id: user.id, username: user.username, role: user.role };

    // facade 会回读配置表(运行时权威源),所以两条配置行必须在。
    await prisma.attachmentTypeConfig.createMany({
      data: [
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

  /** 把四阶段完整跑一遍,返回受控摘要。 */
  const runUpload = async (input: {
    kind: 'user-avatar' | 'member-official-portrait';
    ownerId: string;
    body: Buffer;
    mime?: string;
    originalName?: string;
  }) => {
    const validated = await facade.validateVisualIdentityUploadOutsideTransactionTrusted({
      kind: input.kind,
      ownerId: input.ownerId,
      originalName: input.originalName ?? 'source.png',
      mime: input.mime ?? 'image/jpeg',
      size: input.body.length,
      body: input.body,
      uploadedByUserId: actor.id,
      user: { id: actor.id, username: actor.username, role: actor.role } as never,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    // 阶段 ②:调用方事务内(真实调用方此刻持有 User / Member 聚合根锁)。
    const prepared = await prisma.$transaction((tx) =>
      facade.prepareVisualIdentityUploadInTransactionTrusted(tx, validated),
    );
    // 阶段 ③:**事务外** —— Provider put + HEAD 是网络调用。
    const verified =
      await facade.putVisualIdentityUploadAndVerifyOutsideTransactionTrusted(prepared);
    // 阶段 ④:调用方第二次事务内,原子落库。
    const finalized = await prisma.$transaction((tx) =>
      facade.finalizeVisualIdentityUploadInTransactionTrusted(tx, verified, auditMeta),
    );
    return facade.visualIdentityUploadResponseTrusted(finalized);
  };

  it('队员标准照:四阶段跑通,落库的是**规范化产物**而不是原始上传', async () => {
    // 刻意传一张 PNG,而且比目标尺寸大得多。
    const png = await sharp({
      create: {
        width: 1500,
        height: 2100,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const view = await runUpload({
      kind: 'member-official-portrait',
      ownerId: memberId,
      body: png,
      mime: 'image/png',
      originalName: 'my-photo.png',
    });

    expect(view.specCode).toBe('uniform-portrait-v1');
    expect(view.width).toBe(826);
    expect(view.height).toBe(1158);
    // ⭐ 落库的 mime 是 **JPEG**,不是上传的 PNG:存下去的是我们自己产出的那份二进制。
    expect(view.mime).toBe('image/jpeg');

    const row = await prisma.attachment.findUnique({
      where: { id: view.attachmentId },
      select: { ownerType: true, ownerId: true, mime: true, size: true, originalName: true },
    });
    expect(row).toEqual({
      ownerType: 'member-official-portrait',
      ownerId: memberId,
      mime: 'image/jpeg',
      // size 是**重编码后**的体积,不是上传体积 —— 两者差着数量级。
      size: view.size,
      // 扩展名跟着实际产物走:存的是 JPEG,名字就不该还叫 .png。
      originalName: 'my-photo.jpg',
    });
    expect(view.size).toBeLessThan(png.length);

    // StorageObject ledger 必须与 Attachment 同事务落成 `available`(仓内 storage 一致性不变量)。
    // ⚠️ 对准**这次上传的那把 key**,不是 `findFirst` 随便捞一条 ——
    // 捞一条再断言「它存在」的判据,在任何有 storage 记录的库上都恒真。
    const attachmentRow = await prisma.attachment.findUniqueOrThrow({
      where: { id: view.attachmentId },
      select: { key: true },
    });
    const object = await prisma.storageObject.findUnique({
      where: { key: attachmentRow.key },
      select: { state: true },
    });
    expect(object?.state).toBe('available');
  });

  it('账号头像:同一条链,换一个 kind 就换一套规格', async () => {
    const wide = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: { r: 20, g: 60, b: 90 } },
    })
      .jpeg()
      .toBuffer();
    const user = await createTestUser(app, { username: unique('avatar-owner') });

    const view = await runUpload({ kind: 'user-avatar', ownerId: user.id, body: wide });

    expect(view.specCode).toBe('account-avatar-v1');
    expect([view.width, view.height]).toEqual([512, 512]);
    const row = await prisma.attachment.findUnique({
      where: { id: view.attachmentId },
      select: { ownerType: true, ownerId: true },
    });
    expect(row).toEqual({ ownerType: 'user-avatar', ownerId: user.id });
  });

  it('不合规原图在**第一阶段**就被拒,不留任何 storage 痕迹', async () => {
    const tooSmall = await portraitSource(500, 700);
    const before = await prisma.storageObject.count();

    await expect(
      facade.validateVisualIdentityUploadOutsideTransactionTrusted({
        kind: 'member-official-portrait',
        ownerId: memberId,
        originalName: 'small.jpg',
        mime: 'image/jpeg',
        size: tooSmall.length,
        body: tooSmall,
        uploadedByUserId: actor.id,
        user: { id: actor.id, username: actor.username, role: actor.role } as never,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_IMAGE_TOO_SMALL));

    // 关键在这一句:阶段 ① 在**任何 storage 副作用之前**。
    // 若校验被放到 intent 之后,每一次上传失败都会留下一条孤儿 intent,
    // 而孤儿 intent 是要靠对账 worker 去收的 —— 那是可以避免的运维负担。
    expect(await prisma.storageObject.count()).toBe(before);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it('句柄一次性:同一个阶段句柄用第二次即失效', async () => {
    const body = await portraitSource();
    const validated = await facade.validateVisualIdentityUploadOutsideTransactionTrusted({
      kind: 'member-official-portrait',
      ownerId: memberId,
      originalName: 'once.jpg',
      mime: 'image/jpeg',
      size: body.length,
      body,
      uploadedByUserId: actor.id,
      user: { id: actor.id, username: actor.username, role: actor.role } as never,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await prisma.$transaction((tx) =>
      facade.prepareVisualIdentityUploadInTransactionTrusted(tx, validated),
    );

    // 重放同一个 validated 句柄 —— 必须拿不到 state。
    // 这条挡的是「同一次校验结果被用来备两份 intent」,那会造出一条对不上账的孤儿。
    await expect(
      prisma.$transaction((tx) =>
        facade.prepareVisualIdentityUploadInTransactionTrusted(tx, validated),
      ),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
  });

  it('阶段不能跳:拿 validated 句柄直接去 finalize 会被拒', async () => {
    const body = await portraitSource();
    const validated = await facade.validateVisualIdentityUploadOutsideTransactionTrusted({
      kind: 'member-official-portrait',
      ownerId: memberId,
      originalName: 'skip.jpg',
      mime: 'image/jpeg',
      size: body.length,
      body,
      uploadedByUserId: actor.id,
      user: { id: actor.id, username: actor.username, role: actor.role } as never,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      prisma.$transaction((tx) =>
        facade.finalizeVisualIdentityUploadInTransactionTrusted(
          tx,
          // 类型系统本来就挡得住(branded 句柄互不兼容);这里强转是为了证明
          // **运行时也挡得住** —— 类型只在编译期存在,而绕过它只需要一个 `as`。
          validated as never,
          auditMeta,
        ),
      ),
    ).rejects.toEqual(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    expect(await prisma.attachment.count()).toBe(0);
  });
});
