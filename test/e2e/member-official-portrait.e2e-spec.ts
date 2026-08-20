import { execSync } from 'node:child_process';

import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  MemberOfficialPortraitStatus,
  MembershipStatus,
  MembershipType,
  PrincipalType,
  Role,
} from '@prisma/client';
import sharp from 'sharp';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * issue #1055 T4 —— 队员标准照闭环的端到端用例。
 *
 * 跑**真 seed**(与 `department-data-scope-members.e2e-spec.ts` 同一形状):scoped 判权要的
 * 权限行、org-admin 角色与组织树都来自 seed,自己造一套等于造第二份真相。
 */
const SEED_ENV: NodeJS.ProcessEnv = {
  SUPER_ADMIN_USERNAME: 'admin',
  SUPER_ADMIN_PASSWORD: 'ChangeMe123456',
  SUPER_ADMIN_EMAIL: '',
};

function runSeed(): void {
  const envForChild: NodeJS.ProcessEnv = { ...process.env, ...SEED_ENV };
  assertTestDatabaseUrl(envForChild.DATABASE_URL);
  execSync('pnpm tsx prisma/seed.ts', {
    env: envForChild,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('队员标准照闭环', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sequence = 0;

  const unique = (label: string) => `portrait-${label}-${(sequence += 1)}`;

  /** 全局管理者(持 biz-admin,GLOBAL 绑定)。 */
  let globalAuth: string;
  /** 只管 SECT 部门的管理者(org 范围绑定)。 */
  let sectScopedAuth: string;
  /** SECT 部门内的队员 —— sectScoped 管得着。 */
  let sectMemberId: string;
  /** 另一个部门的队员 —— sectScoped **管不着**,是本 spec 的反面样本。 */
  let otherMemberId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    runSeed();

    const sectId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SECT' }, select: { id: true } })
    ).id;
    const otherId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SWRT' }, select: { id: true } })
    ).id;

    sectMemberId = await createMemberIn(sectId, 'SECT 队员');
    otherMemberId = await createMemberIn(otherId, '他部门队员');

    // ① 全局管理者:显式绑 biz-admin(GLOBAL)。
    // ⚠️ seed 的「每个 ADMIN 用户自动补挂 biz-admin」只在 **seed 运行那一刻**已存在的用户上生效;
    // 本 spec 是先 seed 再建用户,所以补挂轮不到它 —— 第一版就是这么拿到满屏 403 的。
    const globalUsername = unique('global');
    const globalUser = await createTestUser(app, { username: globalUsername, role: Role.ADMIN });
    const bizAdminRole = await prisma.rbacRole.findFirstOrThrow({
      where: { code: 'biz-admin' },
      select: { id: true },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: globalUser.id,
        roleId: bizAdminRole.id,
        scopeType: BindingScopeType.GLOBAL,
      },
    });
    globalAuth = (await loginAs(app, globalUsername)).authHeader;

    // ② org 范围管理者:持 org-admin 角色,但绑定只覆盖 SECT 子树。
    const scopedUsername = unique('sect-admin');
    const scopedUser = await createTestUser(app, { username: scopedUsername, role: Role.USER });
    const orgAdminRole = await prisma.rbacRole.findFirstOrThrow({
      where: { code: 'org-admin' },
      select: { id: true },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: scopedUser.id,
        roleId: orgAdminRole.id,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: sectId,
      },
    });
    sectScopedAuth = (await loginAs(app, scopedUsername)).authHeader;
  });

  async function createMemberIn(organizationId: string, realName: string): Promise<string> {
    const member = await prisma.member.create({
      data: { memberNo: unique('no'), ...memberIdentityData(realName), gradeCode: 'level-1' },
      select: { id: true },
    });
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: member.id,
        organizationId,
        membershipType: MembershipType.PRIMARY,
        status: MembershipStatus.ACTIVE,
      },
    });
    return member.id;
  }

  /** 一张合规的 5:7 原图(≥826×1158)。 */
  const portraitJpeg = (width = 1200, height = 1680): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 200, g: 190, b: 180 } } })
      .jpeg()
      .toBuffer();

  const upload = (memberId: string, body: Buffer, auth: string) =>
    request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/official-portrait`)
      .set('Authorization', auth)
      .attach('file', body, { filename: 'portrait.jpg', contentType: 'image/jpeg' });

  it('上传:建第 1 版 ACTIVE,规范化成 826×1158 JPEG', async () => {
    const res = await upload(sectMemberId, await portraitJpeg(), globalAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      memberId: sectMemberId,
      version: 1,
      status: 'ACTIVE',
      specVersion: 'uniform-portrait-v1',
      source: 'ADMIN_UPLOAD',
      endedAt: null,
      endReason: null,
    });
    // 短 TTL 签名 URL,**不返 raw storage key**。
    expect(typeof res.body.data.accessUrl).toBe('string');
    expect(JSON.stringify(res.body.data)).not.toContain('attachments/');

    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: res.body.data.attachmentId },
      select: { ownerType: true, ownerId: true, mime: true },
    });
    expect(row).toEqual({
      ownerType: 'member-official-portrait',
      ownerId: sectMemberId,
      mime: 'image/jpeg',
    });
  });

  it('替换:旧版转 SUPERSEDED 并留下终结人;**新版 activatedAt 与旧版 endedAt 是同一瞬间**', async () => {
    const first = await upload(sectMemberId, await portraitJpeg(), globalAuth);
    const second = await upload(sectMemberId, await portraitJpeg(1400, 1960), globalAuth);
    expect(second.status).toBe(200);
    expect(second.body.data.version).toBe(2);

    const rows = await prisma.memberOfficialPortrait.findMany({
      where: { memberId: sectMemberId },
      orderBy: { version: 'asc' },
      select: {
        id: true,
        version: true,
        status: true,
        activatedAt: true,
        endedAt: true,
        endedByUserId: true,
        endReason: true,
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: first.body.data.id,
      version: 1,
      status: MemberOfficialPortraitStatus.SUPERSEDED,
    });
    // 终结三件套齐备 —— DB 的 ended_shape_check 也要求,但这里断的是**业务真的填了**,
    // 而不只是「约束没红」。缺了它历史版本会退化成「不知道被谁换掉的一行」。
    expect(rows[0].endedByUserId).not.toBeNull();
    expect(rows[0].endReason).not.toBeNull();

    // ⭐ 同一瞬间:版本历史不留缝也不重叠。
    // T1 把 `activatedAt` 的 `@default(now())` 拿掉就是为了让这件事可能 ——
    // 有默认值时新版时间来自库时钟、旧版 endedAt 来自应用时钟,两个源对不齐。
    expect(rows[0].endedAt).toEqual(rows[1].activatedAt);
    expect(rows[1].status).toBe(MemberOfficialPortraitStatus.ACTIVE);
  });

  it('任何时刻至多一张 ACTIVE —— 连续替换三次后仍然只有一张', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await upload(
        sectMemberId,
        await portraitJpeg(1200 + i * 20, 1680 + i * 28),
        globalAuth,
      );
      expect(res.status).toBe(200);
    }
    const active = await prisma.memberOfficialPortrait.count({
      where: { memberId: sectMemberId, status: MemberOfficialPortraitStatus.ACTIVE },
    });
    expect(active).toBe(1);
    // 反向对照:历史版本必须**留着**,不是被覆盖掉。
    expect(await prisma.memberOfficialPortrait.count({ where: { memberId: sectMemberId } })).toBe(
      3,
    );
  });

  it('并发替换:两个请求同时打,结束时仍只有一张 ACTIVE 且版本号不重', async () => {
    // ⚠️ 诚实说明本用例证明了什么:`Member` 行 `FOR UPDATE` 会把两个请求**串行**,
    // 所以两个通常都会成功(后来者看到前者的 ACTIVE 并顶替它)——
    // 它**不**期望出现 15040。15040 是锁被绕过时 DB partial unique 的兜底,
    // 那条路径由 T1 的 `member-official-portrait-schema.e2e-spec.ts` 直插库来覆盖。
    // 这里要钉的是**串行后的结果不变量**:至多一张 ACTIVE、版本号不重。
    const [a, b] = await Promise.all([
      upload(sectMemberId, await portraitJpeg(1200, 1680), globalAuth),
      upload(sectMemberId, await portraitJpeg(1300, 1820), globalAuth),
    ]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);

    const rows = await prisma.memberOfficialPortrait.findMany({
      where: { memberId: sectMemberId },
      select: { version: true, status: true },
    });
    expect(rows.filter((r) => r.status === MemberOfficialPortraitStatus.ACTIVE)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.version)).size).toBe(rows.length);
  });

  it('作废:必填 reason;作废后当前为空,且**不自动回退到上一版**', async () => {
    await upload(sectMemberId, await portraitJpeg(), globalAuth);
    const second = await upload(sectMemberId, await portraitJpeg(1400, 1960), globalAuth);

    const noReason = await request(httpServer(app))
      .delete(`/api/admin/v1/members/${sectMemberId}/official-portrait`)
      .set('Authorization', globalAuth)
      .send({});
    expect(noReason.status).toBe(400);

    const voided = await request(httpServer(app))
      .delete(`/api/admin/v1/members/${sectMemberId}/official-portrait`)
      .set('Authorization', globalAuth)
      .send({ reason: '照片没穿队服' });
    expect(voided.status).toBe(204);

    const row = await prisma.memberOfficialPortrait.findUniqueOrThrow({
      where: { id: second.body.data.id },
      select: { status: true, endReason: true, endedByUserId: true },
    });
    expect(row.status).toBe(MemberOfficialPortraitStatus.VOIDED);
    expect(row.endReason).toBe('照片没穿队服');
    expect(row.endedByUserId).not.toBeNull();

    // 当前为空 —— **上一版不会自动复活**。历史版本表达的是过去事实;
    // 想重新启用旧照片必须「新建一个正式版本」,而不是把历史行的状态改回去。
    const current = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}/official-portrait`)
      .set('Authorization', globalAuth);
    expect(current.status).toBe(200);
    expect(current.body.data).toBeNull();
    expect(
      await prisma.memberOfficialPortrait.count({
        where: { memberId: sectMemberId, status: MemberOfficialPortraitStatus.ACTIVE },
      }),
    ).toBe(0);
  });

  it('作废后再传:版本号是 max+1 而不是 count+1(作废过的号也占位)', async () => {
    await upload(sectMemberId, await portraitJpeg(), globalAuth);
    await request(httpServer(app))
      .delete(`/api/admin/v1/members/${sectMemberId}/official-portrait`)
      .set('Authorization', globalAuth)
      .send({ reason: '作废第 1 版' });

    const next = await upload(sectMemberId, await portraitJpeg(1400, 1960), globalAuth);
    expect(next.status).toBe(200);
    // count 此刻是 1 ⇒ count+1 = 2,恰好也对;所以再作废一次拉开差距才测得出。
    expect(next.body.data.version).toBe(2);

    await request(httpServer(app))
      .delete(`/api/admin/v1/members/${sectMemberId}/official-portrait`)
      .set('Authorization', globalAuth)
      .send({ reason: '作废第 2 版' });
    const third = await upload(sectMemberId, await portraitJpeg(1500, 2100), globalAuth);
    expect(third.body.data.version).toBe(3);
  });

  it('没有当前标准照时作废 → 15039,不是幂等成功', async () => {
    const res = await request(httpServer(app))
      .delete(`/api/admin/v1/members/${sectMemberId}/official-portrait`)
      .set('Authorization', globalAuth)
      .send({ reason: '并没有可作废的' });
    // 作废是针对具体某一版的判断;静默成功会让调用方以为自己作废了某张照片。
    expectBizError(res, BizCode.MEMBER_OFFICIAL_PORTRAIT_NOT_FOUND, { strictMessage: false });
  });

  it('历史:含已顶替 / 已作废,按 version 倒序', async () => {
    await upload(sectMemberId, await portraitJpeg(), globalAuth);
    await upload(sectMemberId, await portraitJpeg(1400, 1960), globalAuth);
    await request(httpServer(app))
      .delete(`/api/admin/v1/members/${sectMemberId}/official-portrait`)
      .set('Authorization', globalAuth)
      .send({ reason: '作废当前版' });

    const res = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}/official-portraits`)
      .set('Authorization', globalAuth);
    expect(res.status).toBe(200);
    const items = res.body.data as Array<{ version: number; status: string }>;
    expect(items.map((i) => i.version)).toEqual([2, 1]);
    expect(items.map((i) => i.status)).toEqual(['VOIDED', 'SUPERSEDED']);
  });

  describe('scoped 判权(issue §8.1:必须支持组织数据范围)', () => {
    it('组织范围内的队员:可管 —— 正向对照', async () => {
      const res = await upload(sectMemberId, await portraitJpeg(), sectScopedAuth);
      expect(res.status).toBe(200);
    });

    it('⭐ 范围外的队员:同一个人、同一个码,但**管不着**', async () => {
      const res = await upload(otherMemberId, await portraitJpeg(), sectScopedAuth);
      // 范围外与不存在返回**同一个错误** —— 区分开来等于给出一个成员枚举口
      //(「这个 id 存在但你看不见」本身就是信息)。
      expectBizError(res, BizCode.MEMBER_NOT_FOUND, { strictMessage: false });
      expect(
        await prisma.memberOfficialPortrait.count({ where: { memberId: otherMemberId } }),
      ).toBe(0);
    });

    it('范围外的队员也读不到 / 作废不了', async () => {
      await upload(otherMemberId, await portraitJpeg(), globalAuth);

      const read = await request(httpServer(app))
        .get(`/api/admin/v1/members/${otherMemberId}/official-portrait`)
        .set('Authorization', sectScopedAuth);
      expectBizError(read, BizCode.MEMBER_NOT_FOUND, { strictMessage: false });

      const voided = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${otherMemberId}/official-portrait`)
        .set('Authorization', sectScopedAuth)
        .send({ reason: '越权作废' });
      expectBizError(voided, BizCode.MEMBER_NOT_FOUND, { strictMessage: false });

      // 不只是返错 —— 那张照片必须**原样还在**。
      expect(
        await prisma.memberOfficialPortrait.count({
          where: { memberId: otherMemberId, status: MemberOfficialPortraitStatus.ACTIVE },
        }),
      ).toBe(1);
    });
  });

  describe('拒收面', () => {
    it('比例不是 5:7 → 13038', async () => {
      // 3:4 生活照。硬裁成 5:7 极可能切掉下巴或头顶,而系统对此一无所知。
      const res = await upload(sectMemberId, await portraitJpeg(1200, 1600), globalAuth);
      expectBizError(res, BizCode.ATTACHMENT_IMAGE_ASPECT_RATIO_INVALID, { strictMessage: false });
    });

    it('分辨率不够 → 13037(不做插值放大)', async () => {
      const res = await upload(sectMemberId, await portraitJpeg(500, 700), globalAuth);
      expectBizError(res, BizCode.ATTACHMENT_IMAGE_TOO_SMALL, { strictMessage: false });
    });
  });

  it('队员详情带出当前标准照的版本 id(**不带签名 URL**)', async () => {
    const before = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}`)
      .set('Authorization', globalAuth);
    expect(before.body.data.hasOfficialPortrait).toBe(false);
    expect(before.body.data.officialPortraitId).toBeNull();

    const uploaded = await upload(sectMemberId, await portraitJpeg(), globalAuth);

    const after = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}`)
      .set('Authorization', globalAuth);
    expect(after.body.data.hasOfficialPortrait).toBe(true);
    expect(after.body.data.officialPortraitId).toBe(uploaded.body.data.id);
    // 详情面刻意不带 URL:TTL 只有几分钟,塞进可缓存响应会让整个响应跟着过期。
    expect(JSON.stringify(after.body.data)).not.toContain('accessUrl');
  });

  it('审计:activate 与 replace 是两个事件,extra 里没有 key / URL', async () => {
    await upload(sectMemberId, await portraitJpeg(), globalAuth);
    await upload(sectMemberId, await portraitJpeg(1400, 1960), globalAuth);

    const events = await prisma.auditLog.findMany({
      where: { resourceId: sectMemberId, event: { startsWith: 'member.official-portrait.' } },
      select: { event: true, context: true },
      orderBy: { createdAt: 'asc' },
    });
    // 首次是 activate、替换是 replace —— 两者是不同的业务事实,合成一个事件就分不出
    //「这个队员第一次有了标准照」和「换了一张」。
    expect(events.map((e) => e.event)).toEqual([
      'member.official-portrait.activate',
      'member.official-portrait.replace',
    ]);

    const replaceExtra = (events[1].context as { extra?: Record<string, unknown> }).extra ?? {};
    expect(replaceExtra.oldVersionId).toBeDefined();
    expect(replaceExtra.newVersionId).toBeDefined();
    expect(replaceExtra.specVersion).toBe('uniform-portrait-v1');
    const serialized = JSON.stringify(replaceExtra);
    expect(serialized).not.toContain('attachments/');
    expect(serialized).not.toContain('http');
  });
});
