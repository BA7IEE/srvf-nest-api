import type { INestApplication } from '@nestjs/common';
import { BindingStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AUTHZ_REASON_VALUES } from '../../src/modules/authz/authz.dto';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// F3/C2「authz/explain-batch」e2e(2026-07-04;冻结路线图 admin-api-fe-integration-roadmap.md §4 C2 + D8)。
// 覆盖:判权门(authz.explain-batch.decision;单条码不解锁批量)/ 批量矩阵(allow 各源 + deny 各归因
// 逐条独立、顺序保持)/ 入参回显形状(resourceRef 未传则缺省)/ 输入错误(任一 userId 不存在 → 整请求
// 10001;>200 → 400;action 非法 → 400;type ∉ 13 类 → 400)/ reason ⊆ 单条 explain 的 11 值枚举
// (「同一套枚举」= 契约锁,不因批量壳扩值)。
// 判权语义零新增:decision 与单条 explain 同源(AuthzService.explain),此处只锁批量壳自身行为。

const BATCH_PATH = '/api/admin/v1/authz/explain-batch';
const NONEXISTENT_ID = 'cl0nexistuser00000000000x';

const BATCH_CODE = 'authz.explain-batch.decision';

async function seedBatchCodeAndBind(prisma: PrismaService, opsAdminRoleId: string): Promise<void> {
  const perm = await prisma.permission.upsert({
    where: { code: BATCH_CODE },
    update: {},
    create: {
      code: BATCH_CODE,
      module: 'authz',
      action: 'explain-batch',
      resourceType: 'decision',
    },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: [{ roleId: opsAdminRoleId, permissionId: perm.id }],
    skipDuplicates: true,
  });
}

describe('F3/C2 authz/explain-batch(批量权限解释壳)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let opsAuth: string; // ADMIN + ops-admin(持 explain-batch 码)
  let plainAdminAuth: string; // ADMIN 无绑定 → 30100
  let userAuth: string;

  let tGrantedId: string; // USER + GLOBAL 绑定(角色含 aeb.read.record)→ matched
  let tNoneId: string; // USER 零授权 → no_permission
  let tSaId: string; // SUPER_ADMIN → super_admin_pass
  let grantedBindingId: string;
  let activityId: string; // 带 ref 完整三源路径用(matchedGrant 带 bindingId)

  const GRANTED_CODE = 'aeb.read.record';

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'aeb-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'aeb-adm-plain', role: Role.ADMIN });
    await createTestUser(app, { username: 'aeb-user', role: Role.USER });
    opsAuth = (await loginAs(app, 'aeb-adm')).authHeader;
    plainAdminAuth = (await loginAs(app, 'aeb-adm-plain')).authHeader;
    userAuth = (await loginAs(app, 'aeb-user')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedBatchCodeAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // 目标用户矩阵
    const tGranted = await createTestUser(app, { username: 'aeb-t-granted', role: Role.USER });
    const tNone = await createTestUser(app, { username: 'aeb-t-none', role: Role.USER });
    const tSa = await createTestUser(app, { username: 'aeb-t-sa', role: Role.SUPER_ADMIN });
    tGrantedId = tGranted.id;
    tNoneId = tNone.id;
    tSaId = tSa.id;

    const perm = await prisma.permission.create({
      data: { code: GRANTED_CODE, module: 'aeb', action: 'read', resourceType: 'record' },
      select: { id: true },
    });
    const role = await prisma.rbacRole.create({
      data: { code: 'aeb-role', displayName: 'AEB 角色' },
      select: { id: true },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const binding = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: tGrantedId,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: BindingStatus.ACTIVE,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    grantedBindingId = binding.id;

    const org = await prisma.organization.create({
      data: { name: 'AEB Org', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: 'AEB 活动',
        activityTypeCode: 'general',
        organizationId: org.id,
        startAt: new Date('2026-06-01T00:00:00.000Z'),
        endAt: new Date('2026-06-01T08:00:00.000Z'),
        location: 'AEB',
        statusCode: 'published',
      },
      select: { id: true },
    });
    activityId = activity.id;
  });

  afterAll(async () => {
    await app.close();
  });

  function postBatch(auth: string, body: Record<string, unknown>) {
    return request(httpServer(app)).post(BATCH_PATH).set('Authorization', auth).send(body);
  }

  // ============ 判权门 ============

  describe('判权门(独立新码,单条 explain 码不解锁批量)', () => {
    it('未登录 → 401;裸 USER / 裸 ADMIN → 30100', async () => {
      expectBizError(
        await request(httpServer(app))
          .post(BATCH_PATH)
          .send({ items: [{ userId: tNoneId, action: GRANTED_CODE }] }),
        BizCode.UNAUTHORIZED,
      );
      expectBizError(
        await postBatch(userAuth, { items: [{ userId: tNoneId, action: GRANTED_CODE }] }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await postBatch(plainAdminAuth, { items: [{ userId: tNoneId, action: GRANTED_CODE }] }),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  // ============ 批量矩阵 ============

  describe('批量矩阵(逐条独立;deny 是 200 数据;同一套 11 值枚举)', () => {
    it('allow(matched + bindingId / super_admin_pass)与 deny(no_permission / resource_not_found)同批共存,顺序保持', async () => {
      const res = await postBatch(opsAuth, {
        items: [
          { userId: tGrantedId, action: GRANTED_CODE },
          { userId: tNoneId, action: GRANTED_CODE },
          { userId: tSaId, action: GRANTED_CODE },
          {
            userId: tGrantedId,
            action: GRANTED_CODE,
            resourceRef: { type: 'activity', id: NONEXISTENT_ID },
          },
          {
            userId: tGrantedId,
            action: GRANTED_CODE,
            resourceRef: { type: 'activity', id: activityId },
          },
        ],
      });
      expect(res.status).toBe(200);
      const items = res.body.data.items;
      expect(items).toHaveLength(5);

      expect(items[0]).toMatchObject({
        userId: tGrantedId,
        action: GRANTED_CODE,
        decision: { allow: true, reason: 'matched' },
      });
      // 无 ref 项走退化路径:合成 matchedGrant(无 bindingId/roleCode)= PR8 行为锁口径
      expect(items[0].decision.matchedGrant).toEqual({
        source: 'role_binding',
        scopeType: 'GLOBAL',
      });
      expect(items[0]).not.toHaveProperty('resourceRef'); // 未传则缺省(回显形状)

      expect(items[1].decision).toMatchObject({ allow: false, reason: 'no_permission' });
      expect(items[2].decision).toMatchObject({ allow: true, reason: 'super_admin_pass' });

      expect(items[3].resourceRef).toEqual({ type: 'activity', id: NONEXISTENT_ID });
      expect(items[3].decision).toMatchObject({ allow: false, reason: 'resource_not_found' });

      // 带 ref 完整三源路径:matchedGrant 带实体 bindingId + roleCode(GLOBAL 绑定 covers 一切资源)
      expect(items[4].resourceRef).toEqual({ type: 'activity', id: activityId });
      expect(items[4].decision).toMatchObject({ allow: true, reason: 'matched' });
      expect(items[4].decision.matchedGrant).toMatchObject({
        source: 'role_binding',
        bindingId: grantedBindingId,
        roleCode: 'aeb-role',
        scopeType: 'GLOBAL',
      });

      // reason ⊆ 单条 explain 的 11 值稳定枚举(批量壳不扩值)
      for (const item of items) {
        expect(AUTHZ_REASON_VALUES).toContain(item.decision.reason);
      }
    });

    it('同一 userId 重复出现逐条独立返回(去重仅在加载层,不影响输出)', async () => {
      const res = await postBatch(opsAuth, {
        items: [
          { userId: tSaId, action: 'aeb.read.record' },
          { userId: tSaId, action: 'aeb.update.record' },
        ],
      });
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.items[0].action).toBe('aeb.read.record');
      expect(res.body.data.items[1].action).toBe('aeb.update.record');
    });
  });

  // ============ 输入错误(异常,镜像单条语义) ============

  describe('输入错误(仅输入错走异常)', () => {
    it('任一 userId 不存在/已软删 → 整请求 10001', async () => {
      const res = await postBatch(opsAuth, {
        items: [
          { userId: tGrantedId, action: GRANTED_CODE },
          { userId: NONEXISTENT_ID, action: GRANTED_CODE },
        ],
      });
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    it('>200 条 / 空 items / action 非法 / type ∉ 13 类 / 未知字段 → 400', async () => {
      const tooMany = Array.from({ length: 201 }, () => ({
        userId: tGrantedId,
        action: GRANTED_CODE,
      }));
      const lax = { strictMessage: false } as const;
      expectBizError(await postBatch(opsAuth, { items: tooMany }), BizCode.BAD_REQUEST, lax);
      expectBizError(await postBatch(opsAuth, { items: [] }), BizCode.BAD_REQUEST, lax);
      expectBizError(
        await postBatch(opsAuth, { items: [{ userId: tGrantedId, action: 'NOT-A-CODE' }] }),
        BizCode.BAD_REQUEST,
        lax,
      );
      expectBizError(
        await postBatch(opsAuth, {
          items: [
            {
              userId: tGrantedId,
              action: GRANTED_CODE,
              resourceRef: { type: 'bogus_type', id: 'x' },
            },
          ],
        }),
        BizCode.BAD_REQUEST,
        lax,
      );
      expectBizError(
        await postBatch(opsAuth, {
          items: [{ userId: tGrantedId, action: GRANTED_CODE, extra: true }],
        }),
        BizCode.BAD_REQUEST,
        lax,
      );
    });
  });
});
