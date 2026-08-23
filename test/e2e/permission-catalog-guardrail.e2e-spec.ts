import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { SEED_PERMISSION_CODES } from '../../src/modules/permissions/seed-permission-codes';
import { loginAs } from '../fixtures/auth.fixture';
import { seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 权限目录护栏 e2e(P1-32 PR1;2026-08-22)。
//
// ──────────────────────────────────────────────────────────────────────────
// 护栏要挡的那件事(实测,clean 探针库 237 码 / 337 条 role_permissions):
//
//     DELETE FROM permissions WHERE code='member.read.record';   → DELETE 1
//     ⇒ role_permissions 337 → 333
//     ⇒ biz-admin / org-admin / org-readonly / org-supervisor 四个角色同时
//       失去「查看队员」。无确认、无影响预览、无撤销。
//
// 机理:`RolePermission.permission` 是 `onDelete: Cascade`。删码即撤销。
// 重跑 seed 只能补回**内置**角色的映射;实测自定义角色那条授权永久丢失。
//
// ──────────────────────────────────────────────────────────────────────────
// ⭐ 本 spec 的核心是「同一个码、同一个起点、闸开 vs 闸关」的对照:
//
//   闸开(走 HTTP):DELETE → 30105,权限行与两条角色授权**一条没少**
//   闸关(绕 HTTP 直发 SQL):同一条 DELETE → 权限行没了,两条角色授权**跟着没了**
//
// 只证明「HTTP 返回了 30105」是不够的 —— 那只说明有个分支返回了一个码,
// 说不出这个码替管理员挡住了什么。第二半才是「挡住的是什么」的证据。
describe('权限目录护栏(seed 事实闭包内的权限码)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;

  // 级联对照的被试码:在 seed 闭包内,但**不**在 rbac fixture 的 seed 子集里 ——
  // 故本 spec 自建它,删掉也不会连累判权本身(rbac.* 那 14 条必须保持完整)。
  const CASCADE_SUBJECT_CODE = 'member.read.record';
  // 闭包**外**的历史遗留码:护栏不该管它,删除行为必须一字不变。
  const GHOST_CODE = 'pb.legacy.ghost';

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'catalog-su', role: Role.SUPER_ADMIN });
    superAdminAuth = (await loginAs(app, 'catalog-su')).authHeader;

    // 14 条 rbac.* + ops-admin —— 判权自身的前提。
    await seedRbacPermissionsAndOpsAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ===========================================================================
  // 自证:先证明夹具选得对,再报数
  //
  // 两个被试码若分型错了(比如 GHOST_CODE 哪天真进了闭包),下面所有断言的
  // 含义都会反过来而不报错。先把分型钉死。
  // ===========================================================================
  it('self-proves the two subject codes sit on opposite sides of the closure', () => {
    expect(SEED_PERMISSION_CODES.length).toBeGreaterThanOrEqual(200);
    expect(SEED_PERMISSION_CODES).toContain(CASCADE_SUBJECT_CODE);
    expect(SEED_PERMISSION_CODES).not.toContain(GHOST_CODE);
  });

  // ===========================================================================
  // 正对照 + 级联对照(DoD 5)
  // ===========================================================================
  describe('DELETE:闭包内的码被拒,且拒的是一次性抹掉 N 条角色授权', () => {
    let subjectId: string;
    let roleAId: string;
    let roleBId: string;

    beforeAll(async () => {
      const subject = await prisma.permission.create({
        data: {
          code: CASCADE_SUBJECT_CODE,
          module: 'member',
          action: 'read',
          resourceType: 'record',
          description: '查看队员',
        },
        select: { id: true },
      });
      subjectId = subject.id;

      // 两个角色持有这个码 —— 模拟真实 seed 里 biz-admin / org-admin / org-readonly /
      // org-supervisor 四个角色同时持有 member.read.record 的形态。
      const roleA = await prisma.rbacRole.create({
        data: { code: 'catalog-guard-role-a', displayName: '目录护栏对照角色 A' },
        select: { id: true },
      });
      const roleB = await prisma.rbacRole.create({
        data: { code: 'catalog-guard-role-b', displayName: '目录护栏对照角色 B' },
        select: { id: true },
      });
      roleAId = roleA.id;
      roleBId = roleB.id;

      await prisma.rolePermission.createMany({
        data: [
          { roleId: roleAId, permissionId: subjectId },
          { roleId: roleBId, permissionId: subjectId },
        ],
      });
    });

    it('闸开:HTTP DELETE 闭包内的码 → 30105,且权限行与角色授权一条没少', async () => {
      // 先钉「非空」——「0 条授权删掉后还是 0 条」会静默变绿。
      const grantsBefore = await prisma.rolePermission.count({
        where: { permissionId: subjectId },
      });
      expect(grantsBefore).toBe(2);

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/permissions/${subjectId}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.SEED_PERMISSION_DELETE_FORBIDDEN);

      // 拒绝必须是**真没写** —— 只看返回码不看库,等于没验。
      const stillThere = await prisma.permission.findUnique({ where: { id: subjectId } });
      expect(stillThere).not.toBeNull();
      const grantsAfter = await prisma.rolePermission.count({ where: { permissionId: subjectId } });
      expect(grantsAfter).toBe(grantsBefore);
    });

    it('SUPER_ADMIN 也拒 —— 护栏不是权限不足,是「系统拥有的东西不给删」', async () => {
      // superAdminAuth 已是 SUPER_ADMIN;这条与上一条的区别只在语义声明:
      // 返回的是 30105 而不是 30100,说明走的是护栏分支不是判权分支。
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/permissions/${subjectId}`)
        .set('Authorization', superAdminAuth);
      expect(res.body.code).toBe(BizCode.SEED_PERMISSION_DELETE_FORBIDDEN.code);
      expect(res.body.code).not.toBe(BizCode.RBAC_FORBIDDEN.code);
    });

    it('⭐ 闸关:同一条 DELETE 绕过 HTTP 直发 SQL → 两条角色授权跟着消失(护栏挡的就是这个)', async () => {
      const totalGrantsBefore = await prisma.rolePermission.count();
      const subjectGrantsBefore = await prisma.rolePermission.count({
        where: { permissionId: subjectId },
      });
      expect(subjectGrantsBefore).toBe(2);
      expect(totalGrantsBefore).toBeGreaterThan(subjectGrantsBefore);

      // 刻意绕开 service —— 这里要量的是**数据库层的级联**,不是护栏分支。
      const deleted = await prisma.$executeRawUnsafe(
        'DELETE FROM permissions WHERE code = $1',
        CASCADE_SUBJECT_CODE,
      );
      expect(deleted).toBe(1);

      const totalGrantsAfter = await prisma.rolePermission.count();
      const subjectGrantsAfter = await prisma.rolePermission.count({
        where: { permissionId: subjectId },
      });

      // 该码的授权归零,且总数**恰好**少了那么多 —— 不是「变小了」而是「少了这些」。
      expect(subjectGrantsAfter).toBe(0);
      expect(totalGrantsAfter).toBe(totalGrantsBefore - subjectGrantsBefore);

      // 两个角色本身还在,只是空了 —— 这正是「无声自伤」难被发现的原因。
      const roleAStillThere = await prisma.rbacRole.findUnique({ where: { id: roleAId } });
      const roleBStillThere = await prisma.rbacRole.findUnique({ where: { id: roleBId } });
      expect(roleAStillThere).not.toBeNull();
      expect(roleBStillThere).not.toBeNull();
    });
  });

  // ===========================================================================
  // 只挡闭包内的码(goal 核验点 2)
  // ===========================================================================
  describe('DELETE:闭包外的码删除行为一字不变', () => {
    it('闭包外的历史码 → 200,物理删成功', async () => {
      const ghost = await prisma.permission.create({
        data: { code: GHOST_CODE, module: 'pb', action: 'legacy', resourceType: 'ghost' },
        select: { id: true },
      });

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/permissions/${ghost.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);

      const gone = await prisma.permission.findUnique({ where: { id: ghost.id } });
      expect(gone).toBeNull();
    });

    it('不存在的 id 仍返 30001,不被护栏误报成 30105', async () => {
      // 次序判据:护栏排在存在性检查之后。反过来会把「查无此码」说成「被保护」。
      const res = await request(httpServer(app))
        .delete('/api/system/v1/permissions/nonexistent000000000000000000')
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);
    });
  });

  // ===========================================================================
  // 创建护栏(DoD 2)
  // ===========================================================================
  describe('POST:不在闭包内的码不得凭空造', () => {
    it('闭包外的码 → 30106,且确实没写进库', async () => {
      const code = 'made-up.fake.permission';
      expect(SEED_PERMISSION_CODES).not.toContain(code);

      const res = await request(httpServer(app))
        .post('/api/system/v1/permissions')
        .set('Authorization', superAdminAuth)
        .send({ code, module: 'made-up', action: 'fake', resourceType: 'permission' });
      expectBizError(res, BizCode.PERMISSION_CODE_NOT_IN_SEED_CATALOG);

      const written = await prisma.permission.findUnique({ where: { code } });
      expect(written).toBeNull();
    });

    it('格式非法的码仍先返 30008,不被护栏抢答', async () => {
      // 次序判据:格式闸在护栏之前。反过来的话,一个手滑打错的码会被说成
      //「不在目录里」,把管理员引到完全错误的方向。
      const res = await request(httpServer(app))
        .post('/api/system/v1/permissions')
        .set('Authorization', superAdminAuth)
        .send({ code: 'BadFormat', module: 'm', action: 'a', resourceType: 'r' });
      expectBizError(res, BizCode.INVALID_PERMISSION_CODE_FORMAT);
    });

    it('闭包内的码过护栏,但 seed 后必已存在 → 30002', async () => {
      // 这条同时说明护栏**只**判目录成员资格,不越权替唯一性检查作答。
      const res = await request(httpServer(app))
        .post('/api/system/v1/permissions')
        .set('Authorization', superAdminAuth)
        .send({
          code: 'rbac.permission.read',
          module: 'rbac',
          action: 'read',
          resourceType: 'permission',
        });
      expectBizError(res, BizCode.PERMISSION_CODE_ALREADY_EXISTS);
    });
  });

  // ===========================================================================
  // 改码护栏 —— 分两段读:
  //   · code 不可改(DoD 3,PR 1):既有实现已锁死,是**回归锁**不是新行为
  //   · description 也不可改(P1-32 PR 3b,2026-08-23):**这一条是新行为**,
  //     而且是**推翻一条刻意设计** —— 见 biz-code 30110 的注释块与 prisma/seed.ts
  //     那句 `update: {}`(原注释「防止运营运行时调整被 seed 回退」的前提已不成立)。
  // ⇒ 至此 PATCH 对闭包内的码**不再存在成功路径**,与 POST 同型且刻意。
  // ===========================================================================
  describe('PATCH:闭包内码的 code 与 description 都不可改', () => {
    // 🔴 本用例**曾经断言 200**(「只改 description → 200,code 不变」)——
    //    那是 PR 1 时代的正确行为,description 当时刻意允许运行时改。
    //    PR 3b 把它关上了。这里**保留这条路曾经通的事实**,把断言翻面成「现在被拒」,
    //    而不是删掉用例 —— 删掉会让「它曾经是允许的」从测试里彻底消失。
    it('只改 description 也被拒(30110;PR 3b 前这里返 200)', async () => {
      const target = await prisma.permission.findUnique({
        where: { code: 'rbac.permission.read' },
        select: { id: true, description: true },
      });
      expect(target).not.toBeNull();

      const res = await request(httpServer(app))
        .patch(`/api/system/v1/permissions/${target!.id}`)
        .set('Authorization', superAdminAuth)
        .send({ description: '改个说明是不允许的' });
      expectBizError(res, BizCode.SEED_PERMISSION_UPDATE_FORBIDDEN);

      // 只看返回码不够:真正的不变量是**库里没被改**。
      const after = await prisma.permission.findUnique({
        where: { id: target!.id },
        select: { code: true, description: true },
      });
      expect(after?.code).toBe('rbac.permission.read');
      expect(after?.description).toBe(target!.description);
    });

    it('试图改 code → 被 DTO 白名单拒,且库里 code 一字未动', async () => {
      const before = await prisma.permission.findUnique({
        where: { code: 'rbac.permission.read' },
        select: { id: true, code: true },
      });
      expect(before).not.toBeNull();

      const res = await request(httpServer(app))
        .patch(`/api/system/v1/permissions/${before!.id}`)
        .set('Authorization', superAdminAuth)
        .send({ code: 'rbac.permission.hijacked' });
      expect(res.status).toBeGreaterThanOrEqual(400);

      // 只看返回码不够 —— 白名单若哪天被放开,返回码可能仍是 200/400 之外的样子,
      // 真正的不变量是「库里的 code 没动」。
      const after = await prisma.permission.findUnique({
        where: { id: before!.id },
        select: { code: true },
      });
      expect(after?.code).toBe(before!.code);
      const hijacked = await prisma.permission.findUnique({
        where: { code: 'rbac.permission.hijacked' },
      });
      expect(hijacked).toBeNull();
    });
  });
});
