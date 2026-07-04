import type { INestApplication } from '@nestjs/common';
import { BindingStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// F3/C1「role-bindings /page + :id + preview + batch」e2e(2026-07-04;冻结路线图
// admin-api-fe-integration-roadmap.md §4 C1 + D6/D9 拍板)。
// 覆盖:RBAC 门(读三路复用 read.record / batch 复用 create.record)/ page 过滤矩阵
// (默认仅当前生效 · includeExpired · 显式 status · roleCode · scopeOrgId · principalQ · q)/
// expand=role,principal(D6:缺省不展开 = 响应形状与旧端点一致)/ detail 34001 /
// preview dry-run(valid + 各 conflicts + 零写入自证)/ batch(ok/blocked/already-exists +
// 幂等重跑 + audit 落痕 + >200 → 400)。
// **旧 4 端点(GET 数组 / POST / PATCH / DELETE)零触碰**:其行为锁在 role-bindings.e2e-spec.ts,本文件不改。
//
// 沿 role-bindings.e2e-spec.ts 范式:rbac.fixture 的 RBAC_PERMISSIONS 未含 role-binding.*,
// 本 spec 在 beforeAll 内联 seed 4 码 + 绑 ops-admin。

const RB_CODES = [
  'role-binding.read.record',
  'role-binding.create.record',
  'role-binding.update.record',
  'role-binding.delete.record',
] as const;

async function seedRoleBindingCodesAndBind(
  prisma: PrismaService,
  opsAdminRoleId: string,
): Promise<void> {
  for (const code of RB_CODES) {
    const [module, action, resourceType] = code.split('.');
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const perms = await prisma.permission.findMany({
    where: { code: { in: [...RB_CODES] } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: opsAdminRoleId, permissionId: p.id })),
    skipDuplicates: true,
  });
}

const NONEXISTENT_ID = 'cl0nexistbinding00000000x';
const PAGE_PATH = '/api/admin/v1/role-bindings/page';
const PREVIEW_PATH = '/api/admin/v1/role-bindings/preview';
const BATCH_PATH = '/api/admin/v1/role-bindings/batch';

describe('F3/C1 role-bindings 增强面(page / detail / preview / batch)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminAuth: string; // ops-admin 持有者
  let plainAdminAuth: string; // ADMIN 不持 ops-admin
  let userAuth: string;

  let roleAId: string; // code rbe-role-a
  let roleBId: string; // code rbe-role-b
  let orgId: string;

  let targetAliceId: string; // USER 主体(username 供 principalQ)
  let targetBobId: string;
  let memberId: string;

  let bActiveId: string; // alice × roleA × GLOBAL,ACTIVE 无限期,note 'rbe-alpha-note'
  let bEndedId: string; // alice × roleA × GLOBAL,ENDED(显式 status 过滤命中)
  let bExpiredId: string; // bob × roleB × GLOBAL,ACTIVE 但 endedAt 已过(默认排除)
  let bOrgScopedId: string; // member 主体 × roleB × ORGANIZATION@org,ACTIVE

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'rbe-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'rbe-adm-plain', role: Role.ADMIN });
    await createTestUser(app, { username: 'rbe-user', role: Role.USER });
    adminAuth = (await loginAs(app, 'rbe-adm')).authHeader;
    plainAdminAuth = (await loginAs(app, 'rbe-adm-plain')).authHeader;
    userAuth = (await loginAs(app, 'rbe-user')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedRoleBindingCodesAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    const alice = await createTestUser(app, { username: 'rbe-target-alice', role: Role.USER });
    const bob = await createTestUser(app, { username: 'rbe-target-bob', role: Role.USER });
    targetAliceId = alice.id;
    targetBobId = bob.id;

    const roleA = await prisma.rbacRole.create({
      data: { code: 'rbe-role-a', displayName: 'RBE 角色甲' },
      select: { id: true },
    });
    const roleB = await prisma.rbacRole.create({
      data: { code: 'rbe-role-b', displayName: 'RBE 角色乙' },
      select: { id: true },
    });
    roleAId = roleA.id;
    roleBId = roleB.id;

    const org = await prisma.organization.create({
      data: { name: 'RBE Org', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    orgId = org.id;
    const member = await prisma.member.create({
      data: { memberNo: 'rbe-m1', displayName: 'RBE 队员甲' },
      select: { id: true },
    });
    memberId = member.id;

    // 分页/过滤基线绑定(直插;各行 dims 互异,不撞 partial unique)
    const now = new Date('2026-07-04T00:00:00.000Z');
    const past = new Date('2026-01-01T00:00:00.000Z');
    const earlier = new Date('2025-01-01T00:00:00.000Z');
    const bActive = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: targetAliceId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
        status: BindingStatus.ACTIVE,
        startedAt: past,
        note: 'rbe-alpha-note',
      },
      select: { id: true },
    });
    bActiveId = bActive.id;
    const bEnded = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: targetAliceId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
        status: BindingStatus.ENDED,
        startedAt: earlier,
        endedAt: past,
      },
      select: { id: true },
    });
    bEndedId = bEnded.id;
    const bExpired = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: targetBobId,
        roleId: roleBId,
        scopeType: 'GLOBAL',
        status: BindingStatus.ACTIVE,
        startedAt: earlier,
        endedAt: now, // 已到期(<= 当前时刻)但 status 仍 ACTIVE:默认收窄应排除
      },
      select: { id: true },
    });
    bExpiredId = bExpired.id;
    const bOrgScoped = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: memberId,
        roleId: roleBId,
        scopeType: 'ORGANIZATION',
        scopeOrgId: orgId,
        status: BindingStatus.ACTIVE,
        startedAt: past,
      },
      select: { id: true },
    });
    bOrgScopedId = bOrgScoped.id;
  });

  afterAll(async () => {
    await app.close();
  });

  function getPage(auth: string, query: Record<string, string> = {}) {
    return request(httpServer(app)).get(PAGE_PATH).query(query).set('Authorization', auth);
  }

  // ============ RBAC 门 ============

  describe('RBAC 门(读三路 read.record / batch create.record)', () => {
    it('page / detail / preview / batch:ADMIN 不持 ops-admin → 30100', async () => {
      expectBizError(await getPage(plainAdminAuth), BizCode.RBAC_FORBIDDEN);
      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/role-bindings/${bActiveId}`)
          .set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .get(PREVIEW_PATH)
          .query({
            principalType: 'USER',
            principalId: targetAliceId,
            roleId: roleAId,
            scopeType: 'GLOBAL',
          })
          .set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(BATCH_PATH)
          .set('Authorization', plainAdminAuth)
          .send({
            items: [
              {
                principalType: 'USER',
                principalId: targetAliceId,
                roleId: roleAId,
                scopeType: 'GLOBAL',
              },
            ],
          }),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('未登录 page → 401;USER → 30100', async () => {
      expectBizError(await request(httpServer(app)).get(PAGE_PATH), BizCode.UNAUTHORIZED);
      expectBizError(await getPage(userAuth), BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ page 过滤矩阵 ============

  describe('GET /role-bindings/page(D9 分页 + 过滤)', () => {
    it('默认仅「当前生效」:ENDED 与 ACTIVE-已到期 都不出现;分页外壳 items/total/page/pageSize', async () => {
      const res = await getPage(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ page: 1, pageSize: 20 });
      const ids = res.body.data.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(bActiveId);
      expect(ids).toContain(bOrgScopedId);
      expect(ids).not.toContain(bEndedId);
      expect(ids).not.toContain(bExpiredId);
      expect(res.body.data.total).toBe(ids.length);
    });

    it('includeExpired=true → 全部未软删;includeExpired=false 逐字等默认', async () => {
      const all = await getPage(adminAuth, { includeExpired: 'true' });
      const allIds = all.body.data.items.map((i: { id: string }) => i.id);
      expect(allIds).toEqual(
        expect.arrayContaining([bActiveId, bEndedId, bExpiredId, bOrgScopedId]),
      );

      const explicit = await getPage(adminAuth, { includeExpired: 'false' });
      const defaults = await getPage(adminAuth);
      expect(explicit.body.data).toEqual(defaults.body.data);
    });

    it('显式 status=ENDED 优先于默认收窄', async () => {
      const res = await getPage(adminAuth, { status: 'ENDED' });
      const ids = res.body.data.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(bEndedId);
      expect(ids).not.toContain(bActiveId);
    });

    it('roleCode / scopeOrgId 精确过滤', async () => {
      const byRole = await getPage(adminAuth, { roleCode: 'rbe-role-a' });
      expect(byRole.body.data.items.map((i: { id: string }) => i.id)).toEqual([bActiveId]);

      const byOrg = await getPage(adminAuth, { scopeOrgId: orgId });
      expect(byOrg.body.data.items.map((i: { id: string }) => i.id)).toEqual([bOrgScopedId]);
    });

    it('principalQ:USER 主体命中 username;MEMBER 主体命中 displayName', async () => {
      const byUser = await getPage(adminAuth, { principalQ: 'target-alice' });
      expect(byUser.body.data.items.map((i: { id: string }) => i.id)).toEqual([bActiveId]);

      const byMember = await getPage(adminAuth, { principalQ: 'RBE 队员甲' });
      expect(byMember.body.data.items.map((i: { id: string }) => i.id)).toEqual([bOrgScopedId]);
    });

    it('q 命中 note 与角色 code(contains + insensitive)', async () => {
      const byNote = await getPage(adminAuth, { q: 'ALPHA-NOTE' });
      expect(byNote.body.data.items.map((i: { id: string }) => i.id)).toEqual([bActiveId]);

      const byRoleCode = await getPage(adminAuth, { q: 'rbe-role-b' });
      expect(byRoleCode.body.data.items.map((i: { id: string }) => i.id)).toEqual([bOrgScopedId]);
    });

    it('pageSize=1 分页切片 + total 不随页变', async () => {
      const p1 = await getPage(adminAuth, { pageSize: '1', page: '1', includeExpired: 'true' });
      const p2 = await getPage(adminAuth, { pageSize: '1', page: '2', includeExpired: 'true' });
      expect(p1.body.data.items).toHaveLength(1);
      expect(p2.body.data.items).toHaveLength(1);
      expect(p1.body.data.items[0].id).not.toBe(p2.body.data.items[0].id);
      expect(p1.body.data.total).toBe(p2.body.data.total);
    });
  });

  // ============ expand(D6) ============

  describe('expand=role,principal(D6:默认关 = 形状与旧端点一致)', () => {
    it('缺省 expand:items 不含 role / principal 键(响应形状零变化)', async () => {
      const res = await getPage(adminAuth, { roleCode: 'rbe-role-a' });
      const item = res.body.data.items[0];
      expect(item).not.toHaveProperty('role');
      expect(item).not.toHaveProperty('principal');
    });

    it('expand=role,principal:USER 主体附 username;MEMBER 主体附 memberNo/displayName;role 附 code/displayName', async () => {
      const res = await getPage(adminAuth, { expand: 'role,principal', includeExpired: 'true' });
      expect(res.status).toBe(200);
      const items: Array<{
        id: string;
        role?: { id: string; code: string; displayName: string };
        principal?: Record<string, unknown>;
      }> = res.body.data.items;
      const active = items.find((i) => i.id === bActiveId)!;
      expect(active.role).toEqual({ id: roleAId, code: 'rbe-role-a', displayName: 'RBE 角色甲' });
      expect(active.principal).toMatchObject({
        type: 'USER',
        id: targetAliceId,
        username: 'rbe-target-alice',
      });
      const orgScoped = items.find((i) => i.id === bOrgScopedId)!;
      expect(orgScoped.principal).toMatchObject({
        type: 'MEMBER',
        id: memberId,
        memberNo: 'rbe-m1',
        displayName: 'RBE 队员甲',
      });
    });

    it('expand 白名单外 token → 40000', async () => {
      expectBizError(await getPage(adminAuth, { expand: 'role,bogus' }), BizCode.BAD_REQUEST);
    });
  });

  // ============ detail ============

  describe('GET /role-bindings/:id(detail)', () => {
    it('命中 → 200 完整形状(不含 role/principal 展开键)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/role-bindings/${bActiveId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: bActiveId,
        principalType: 'USER',
        principalId: targetAliceId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
        note: 'rbe-alpha-note',
      });
      expect(res.body.data).not.toHaveProperty('role');
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('不存在 → 34001', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/role-bindings/${NONEXISTENT_ID}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ROLE_BINDING_NOT_FOUND);
    });
  });

  // ============ preview(dry-run) ============

  describe('GET /role-bindings/preview(dry-run 零写入)', () => {
    function getPreview(query: Record<string, string>) {
      return request(httpServer(app))
        .get(PREVIEW_PATH)
        .query(query)
        .set('Authorization', adminAuth);
    }

    it('可建组合 → valid:true + conflicts 空 + resolvedScope 归一化;且零写入', async () => {
      const before = await prisma.roleBinding.count();
      const res = await getPreview({
        principalType: 'USER',
        principalId: targetBobId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        valid: true,
        conflicts: [],
        resolvedScope: {
          scopeType: 'GLOBAL',
          scopeOrgId: null,
          scopeActivityId: null,
          scopeResourceType: null,
          scopeResourceId: null,
        },
      });
      expect(await prisma.roleBinding.count()).toBe(before);
    });

    it('同维度 ACTIVE 已存在 → valid:false + 34002(ACTIVE-已到期行同维度亦按唯一约束口径命中)', async () => {
      const res = await getPreview({
        principalType: 'USER',
        principalId: targetAliceId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
      });
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.conflicts).toEqual([
        expect.objectContaining({ bizCode: BizCode.ROLE_BINDING_ALREADY_EXISTS.code }),
      ]);
    });

    it('scope 形状非法(GLOBAL + scopeOrgId)→ 34003;任期非法 → 34005;SYSTEM 带 principalId → 34004', async () => {
      const shape = await getPreview({
        principalType: 'USER',
        principalId: targetBobId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
        scopeOrgId: orgId,
      });
      expect(shape.body.data.conflicts.map((c: { bizCode: number }) => c.bizCode)).toContain(
        BizCode.ROLE_BINDING_SCOPE_INVALID.code,
      );

      const tenure = await getPreview({
        principalType: 'USER',
        principalId: targetBobId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
        startedAt: '2026-07-01T00:00:00.000Z',
        endedAt: '2026-06-01T00:00:00.000Z',
      });
      expect(tenure.body.data.conflicts.map((c: { bizCode: number }) => c.bizCode)).toContain(
        BizCode.ROLE_BINDING_TENURE_INVALID.code,
      );

      const sys = await getPreview({
        principalType: 'SYSTEM',
        principalId: targetBobId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
      });
      expect(sys.body.data.conflicts.map((c: { bizCode: number }) => c.bizCode)).toContain(
        BizCode.ROLE_BINDING_PRINCIPAL_INVALID.code,
      );
    });

    it('主体不存在 → 10001;角色不存在 → ROLE_NOT_FOUND;多重问题逐项累积', async () => {
      const res = await getPreview({
        principalType: 'USER',
        principalId: NONEXISTENT_ID,
        roleId: NONEXISTENT_ID,
        scopeType: 'GLOBAL',
      });
      expect(res.body.data.valid).toBe(false);
      const codes = res.body.data.conflicts.map((c: { bizCode: number }) => c.bizCode);
      expect(codes).toContain(BizCode.USER_NOT_FOUND.code);
      expect(codes).toContain(BizCode.ROLE_NOT_FOUND.code);
    });

    it('ORGANIZATION scope + 不存在的 scopeOrgId → ORGANIZATION_NOT_FOUND(零写入)', async () => {
      const before = await prisma.roleBinding.count();
      const res = await getPreview({
        principalType: 'USER',
        principalId: targetBobId,
        roleId: roleAId,
        scopeType: 'ORGANIZATION',
        scopeOrgId: NONEXISTENT_ID,
      });
      expect(res.body.data.conflicts.map((c: { bizCode: number }) => c.bizCode)).toContain(
        BizCode.ORGANIZATION_NOT_FOUND.code,
      );
      expect(await prisma.roleBinding.count()).toBe(before);
    });
  });

  // ============ batch ============

  describe('POST /role-bindings/batch(逐条独立 + 幂等)', () => {
    function postBatch(items: Array<Record<string, unknown>>) {
      return request(httpServer(app))
        .post(BATCH_PATH)
        .set('Authorization', adminAuth)
        .send({ items });
    }

    it('混合批:ok + already-exists + blocked 逐条独立;summary 正确;audit 落痕;幂等重跑', async () => {
      const items = [
        { principalType: 'USER', principalId: targetBobId, roleId: roleAId, scopeType: 'GLOBAL' },
        { principalType: 'USER', principalId: targetAliceId, roleId: roleAId, scopeType: 'GLOBAL' },
        { principalType: 'SYSTEM', principalId: targetBobId, roleId: roleAId, scopeType: 'GLOBAL' },
      ];
      const res = await postBatch(items);
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.items).toHaveLength(3);
      expect(data.items[0]).toMatchObject({ index: 0, outcome: 'ok' });
      expect(data.items[0].bindingId).toBeTruthy();
      expect(data.items[1]).toMatchObject({
        index: 1,
        outcome: 'already-exists',
        bizCode: BizCode.ROLE_BINDING_ALREADY_EXISTS.code,
        bindingId: null,
      });
      expect(data.items[2]).toMatchObject({
        index: 2,
        outcome: 'blocked',
        bizCode: BizCode.ROLE_BINDING_PRINCIPAL_INVALID.code,
      });
      expect(data.summary).toEqual({ total: 3, ok: 1, blocked: 1, alreadyExists: 1 });

      // 落库 + audit(复用单条 create 路径 → role-binding.create 事件)
      const createdId: string = data.items[0].bindingId;
      const row = await prisma.roleBinding.findUnique({
        where: { id: createdId },
        select: { status: true, createdByUserId: true },
      });
      expect(row).toMatchObject({ status: 'ACTIVE' });
      const audit = await prisma.auditLog.findFirst({
        where: { event: 'role-binding.create', resourceId: createdId },
        select: { id: true },
      });
      expect(audit).not.toBeNull();

      // 幂等重跑:第一条转 already-exists,零新建
      const before = await prisma.roleBinding.count();
      const rerun = await postBatch(items);
      expect(rerun.body.data.summary).toEqual({ total: 3, ok: 0, blocked: 1, alreadyExists: 2 });
      expect(await prisma.roleBinding.count()).toBe(before);
    });

    it('>200 条 → 40000(ArrayMaxSize);空 items → 40000', async () => {
      const tooMany = Array.from({ length: 201 }, () => ({
        principalType: 'USER',
        principalId: targetBobId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
      }));
      expectBizError(await postBatch(tooMany), BizCode.BAD_REQUEST, { strictMessage: false });
      expectBizError(await postBatch([]), BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });
});
