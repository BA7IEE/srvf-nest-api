import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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

// 证书标准库 PR-3 e2e(冻结稿 §5.2 / §5.3 / §5.4 / §7.1 / §7.2 / §13.1 / §13.2 / §22.1 / §22.2)。
//
// 本 spec 覆盖 13 个端点的判权边界、状态机、字段组合、删除守卫、options 投影,
// 以及 §22.2 明确要求的**真实 PostgreSQL 并发激活**(不 mock —— 那条不变量
// 恰恰只在真并发下才成立或失效)。
//
// 权限码 seed:本仓 `rbac.fixture` 的 RBAC_PERMISSIONS **不含**本刀 8 码,
// 且它的 count 被 rbac 元 e2e 依赖 —— 沿 role-bindings.e2e 先例,本 spec 在
// beforeAll 内联 seed 这 8 码并绑 ops-admin,不动共享 fixture。

const STANDARD_CODES = [
  'certificate-standard.read.record',
  'certificate-standard.create.record',
  'certificate-standard.update.record',
  'certificate-standard.delete.record',
  'certificate-recognition-policy.read.record',
  'certificate-recognition-policy.create.record',
  'certificate-recognition-policy.update.record',
  'certificate-recognition-policy.delete.record',
] as const;

// options 的替代入口码之一(§16.4)。用它单独建一个角色,证明
// **不持 certificate-standard.read.record 也能读 options** —— 这正是 PR-2
// 设计订正留给 PR-3 的硬要求:8 条配置面码只绑 ops-admin,建证的人靠替代码进。
const CERT_CREATE_CODE = 'certificate.create.record';

describe('certificate standards + recognition policies(PR-3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let opsAuth: string; // 持 8 码
  let optionsOnlyAuth: string; // 只持 certificate.create.record
  let plainAdminAuth: string; // ADMIN 但无任何证书标准码
  let userAuth: string;

  let categoryCode: string; // ACTIVE cert_type
  let otherCategoryCode: string; // 另一个 ACTIVE cert_type(测父子 category 不一致)
  let levelCode: string; // ACTIVE cert_sub_type

  const base = '/api/admin/v1/certificate-standards';
  const policyBase = '/api/admin/v1/certificate-recognition-policies';

  async function seedStandardCodesAndBind(opsAdminRoleId: string): Promise<void> {
    for (const code of STANDARD_CODES) {
      const [module, action, resourceType] = code.split('.');
      const perm = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code, module, action, resourceType },
        select: { id: true },
      });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
        update: {},
        create: { roleId: opsAdminRoleId, permissionId: perm.id },
      });
    }
  }

  // 建一个只持 certificate.create.record 的角色并绑给 optionsOnly 用户。
  async function seedOptionsOnlyRole(userId: string): Promise<void> {
    const perm = await prisma.permission.upsert({
      where: { code: CERT_CREATE_CODE },
      update: {},
      create: {
        code: CERT_CREATE_CODE,
        module: 'certificate',
        action: 'create',
        resourceType: 'record',
      },
      select: { id: true },
    });
    const role = await prisma.rbacRole.create({
      data: { code: 'cs-e2e-options-only', displayName: '仅建证(用于 options 替代入口码)' },
      select: { id: true },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: perm.id },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userId,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    });
  }

  // 建 Standard 的便捷函数(默认 CREDENTIAL + 本 spec 的 categoryCode)。
  async function createStandard(
    overrides: Record<string, unknown> = {},
    auth = opsAuth,
  ): Promise<request.Response> {
    return request(httpServer(app))
      .post(base)
      .set('Authorization', auth)
      .send({
        code: `std-${Math.random().toString(36).slice(2, 10)}`,
        name: '测试标准',
        kind: 'CREDENTIAL',
        categoryCode,
        ...overrides,
      });
  }

  async function activateStandard(id: string): Promise<void> {
    const res = await request(httpServer(app))
      .patch(`${base}/${id}/status`)
      .set('Authorization', opsAuth)
      .send({ status: 'ACTIVE' });
    expect(res.status).toBe(200);
  }

  // 建一个 ACTIVE CREDENTIAL Standard,返回 id。
  async function createActiveStandard(overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await createStandard(overrides);
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    await activateStandard(id);
    return id;
  }

  async function createPolicy(
    standardId: string,
    body: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(httpServer(app))
      .post(`${base}/${standardId}/recognition-policies`)
      .set('Authorization', opsAuth)
      .send({
        issuerPolicy: 'ALLOWLIST',
        validityMode: 'FIXED_MONTHS',
        validityMonths: 24,
        certNumberMode: 'REQUIRED',
        issuers: [{ name: '深圳市急救中心' }],
        ...body,
      });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const ops = await createTestUser(app, { username: 'cs-ops', role: Role.ADMIN });
    const optionsOnly = await createTestUser(app, { username: 'cs-opt', role: Role.USER });
    await createTestUser(app, { username: 'cs-adm-plain', role: Role.ADMIN });
    await createTestUser(app, { username: 'cs-user', role: Role.USER });
    opsAuth = (await loginAs(app, 'cs-ops')).authHeader;
    optionsOnlyAuth = (await loginAs(app, 'cs-opt')).authHeader;
    plainAdminAuth = (await loginAs(app, 'cs-adm-plain')).authHeader;
    userAuth = (await loginAs(app, 'cs-user')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedStandardCodesAndBind(seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, ops.id, seed.opsAdminRoleId);
    await seedOptionsOnlyRole(optionsOnly.id);

    // 字典:两个 ACTIVE cert_type + 一个 ACTIVE cert_sub_type。
    const certType = await prisma.dictType.create({
      data: { code: 'cert_type', label: '证书大类' },
      select: { id: true },
    });
    const subType = await prisma.dictType.create({
      data: { code: 'cert_sub_type', label: '证书子类型' },
      select: { id: true },
    });
    categoryCode = (
      await prisma.dictItem.create({
        data: { typeId: certType.id, code: 'cs-bsafe', label: 'BSAFE' },
        select: { code: true },
      })
    ).code;
    otherCategoryCode = (
      await prisma.dictItem.create({
        data: { typeId: certType.id, code: 'cs-first-aid', label: '急救' },
        select: { code: true },
      })
    ).code;
    levelCode = (
      await prisma.dictItem.create({
        data: { typeId: subType.id, code: 'cs-l2', label: '二级' },
        select: { code: true },
      })
    ).code;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 判权边界 ============

  describe('判权边界(service 层 rbac.can;0 @Roles)', () => {
    it('未登录 → 401', async () => {
      expect((await request(httpServer(app)).get(base)).status).toBe(401);
    });

    it('USER 无码 → 30100', async () => {
      expectBizError(
        await request(httpServer(app)).get(base).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('ADMIN 但无证书标准码 → 30100(ADMIN 身份不自动放行配置面)', async () => {
      expectBizError(
        await request(httpServer(app)).get(base).set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('ops-admin(持 8 码)→ 200', async () => {
      expect((await request(httpServer(app)).get(base).set('Authorization', opsAuth)).status).toBe(
        200,
      );
    });
  });

  // ============ §16.4 options 替代入口码(PR-2 留下的硬要求)============

  describe('§16.4 options 替代入口码', () => {
    it('只持 certificate.create.record 也能读 options(不持 certificate-standard.read.record)', async () => {
      const res = await request(httpServer(app))
        .get(`${base}/options`)
        .set('Authorization', optionsOnlyAuth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });

    it('但同一个用户读 list 仍 30100 —— 替代码只开 options,不是万能钥匙', async () => {
      expectBizError(
        await request(httpServer(app)).get(base).set('Authorization', optionsOnlyAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('完全无码的 USER 读 options 仍 30100', async () => {
      expectBizError(
        await request(httpServer(app)).get(`${base}/options`).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  // ============ Standard CRUD + 状态机 ============

  describe('Standard 创建与身份字段', () => {
    it('创建恒 DRAFT(不能一步到可用)', async () => {
      const res = await createStandard();
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('DRAFT');
      expect(res.body.data.activatedAt).toBeNull();
    });

    it('code 重复 → 18003', async () => {
      const code = `dup-${Date.now()}`;
      expect((await createStandard({ code })).status).toBe(201);
      expectBizError(await createStandard({ code }), BizCode.CERTIFICATE_STANDARD_CODE_EXISTS);
    });

    it('code 软删后**不可复用**(D-CERT-004)', async () => {
      const code = `reuse-${Date.now()}`;
      const created = await createStandard({ code });
      expect(created.status).toBe(201);
      const delRes = await request(httpServer(app))
        .delete(`${base}/${created.body.data.id}`)
        .set('Authorization', opsAuth);
      expect(delRes.status).toBe(204);
      // 软删行仍占 code —— 全量 @unique 而非 partial unique,正是为了这条。
      expectBizError(await createStandard({ code }), BizCode.CERTIFICATE_STANDARD_CODE_EXISTS);
    });

    it('categoryCode 不是 ACTIVE cert_type → 18010', async () => {
      expectBizError(
        await createStandard({ categoryCode: 'not-a-real-dict-code' }),
        BizCode.CERTIFICATE_TYPE_CODE_INVALID,
      );
    });

    it('levelCode 不是 ACTIVE cert_sub_type → 18011', async () => {
      expectBizError(
        await createStandard({ levelCode: 'not-a-real-sub-code' }),
        BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
      );
    });

    it('合法 levelCode 放行', async () => {
      expect((await createStandard({ levelCode })).status).toBe(201);
    });

    it('身份字段不在 PATCH 白名单 → 40000(契约层就拦住,不靠运行时判状态)', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      for (const forbidden of [
        { code: 'x' },
        { kind: 'FAMILY' },
        { categoryCode: otherCategoryCode },
        { levelCode },
        { isInternal: true },
        { parentId: id },
        { status: 'ACTIVE' },
      ]) {
        const res = await request(httpServer(app))
          .patch(`${base}/${id}`)
          .set('Authorization', opsAuth)
          .send(forbidden);
        expect(res.status).toBe(400);
      }
    });

    it('PATCH 只接受 name / description / sortOrder', async () => {
      const created = await createStandard();
      const res = await request(httpServer(app))
        .patch(`${base}/${created.body.data.id}`)
        .set('Authorization', opsAuth)
        .send({ name: '改名了', description: '说明', sortOrder: 7 });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('改名了');
      expect(res.body.data.sortOrder).toBe(7);
    });
  });

  describe('Standard 父级约束(§5.2)', () => {
    it('父必须是 FAMILY:挂到 CREDENTIAL 下 → 18012', async () => {
      const credentialParent = await createActiveStandard();
      expectBizError(
        await createStandard({ parentId: credentialParent }),
        BizCode.CERTIFICATE_STANDARD_KIND_INVALID,
      );
    });

    it('父子 categoryCode 必须一致 → 不一致 18019', async () => {
      const familyId = await createActiveStandard({ kind: 'FAMILY' });
      expectBizError(
        await createStandard({ parentId: familyId, categoryCode: otherCategoryCode }),
        BizCode.CERTIFICATE_STANDARD_PARENT_INVALID,
      );
    });

    it('父是 ACTIVE FAMILY 且同 category → 放行', async () => {
      const familyId = await createActiveStandard({ kind: 'FAMILY' });
      const res = await createStandard({ parentId: familyId });
      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBe(familyId);
    });

    it('父还是 DRAFT → 18034(避免子启用而父悬空)', async () => {
      const draftFamily = await createStandard({ kind: 'FAMILY' });
      expectBizError(
        await createStandard({ parentId: draftFamily.body.data.id }),
        BizCode.CERTIFICATE_STANDARD_STATE_INVALID,
      );
    });

    it('父不存在 → 18002', async () => {
      expectBizError(
        await createStandard({ parentId: 'cl0000000000000000000000' }),
        BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
      );
    });
  });

  describe('Standard 状态机(§7.1)', () => {
    it('DRAFT→ACTIVE 写 activatedAt', async () => {
      const created = await createStandard();
      const res = await request(httpServer(app))
        .patch(`${base}/${created.body.data.id}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'ACTIVE' });
      expect(res.status).toBe(200);
      expect(res.body.data.activatedAt).not.toBeNull();
    });

    it('activatedAt 记首次启用,不被 INACTIVE→ACTIVE 覆盖', async () => {
      const id = await createActiveStandard();
      const first = await request(httpServer(app))
        .get(`${base}/${id}`)
        .set('Authorization', opsAuth);
      const firstActivatedAt = first.body.data.activatedAt as string;

      for (const status of ['INACTIVE', 'ACTIVE']) {
        const res = await request(httpServer(app))
          .patch(`${base}/${id}/status`)
          .set('Authorization', opsAuth)
          .send({ status });
        expect(res.status).toBe(200);
      }
      const again = await request(httpServer(app))
        .get(`${base}/${id}`)
        .set('Authorization', opsAuth);
      expect(again.body.data.activatedAt).toBe(firstActivatedAt);
    });

    it('DRAFT→INACTIVE 非法 → 18034', async () => {
      const created = await createStandard();
      expectBizError(
        await request(httpServer(app))
          .patch(`${base}/${created.body.data.id}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'INACTIVE' }),
        BizCode.CERTIFICATE_STANDARD_STATE_INVALID,
      );
    });

    it('同态→同态非法(ACTIVE→ACTIVE)→ 18034', async () => {
      const id = await createActiveStandard();
      expectBizError(
        await request(httpServer(app))
          .patch(`${base}/${id}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' }),
        BizCode.CERTIFICATE_STANDARD_STATE_INVALID,
      );
    });

    it('DTO 不接受 DRAFT 作为目标状态 → 40000', async () => {
      const id = await createActiveStandard();
      const res = await request(httpServer(app))
        .patch(`${base}/${id}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'DRAFT' });
      expect(res.status).toBe(400);
    });

    it('INACTIVE→ACTIVE 前重校验字典:category 字典被停用则拒', async () => {
      const tempType = await prisma.dictType.findFirstOrThrow({
        where: { code: 'cert_type' },
        select: { id: true },
      });
      const tempItem = await prisma.dictItem.create({
        data: { typeId: tempType.id, code: `cs-temp-${Date.now()}`, label: '临时' },
        select: { id: true, code: true },
      });
      const id = await createActiveStandard({ categoryCode: tempItem.code });
      await request(httpServer(app))
        .patch(`${base}/${id}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'INACTIVE' });

      // 停用该字典项后再尝试恢复 ACTIVE。
      await prisma.dictItem.update({ where: { id: tempItem.id }, data: { status: 'INACTIVE' } });
      expectBizError(
        await request(httpServer(app))
          .patch(`${base}/${id}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' }),
        BizCode.CERTIFICATE_TYPE_CODE_INVALID,
      );
    });
  });

  describe('Standard 删除守卫(§18 18032)', () => {
    it('无引用 → 204', async () => {
      const created = await createStandard();
      const res = await request(httpServer(app))
        .delete(`${base}/${created.body.data.id}`)
        .set('Authorization', opsAuth);
      expect(res.status).toBe(204);
    });

    it('被子节点引用 → 18032', async () => {
      const familyId = await createActiveStandard({ kind: 'FAMILY' });
      expect((await createStandard({ parentId: familyId })).status).toBe(201);
      expectBizError(
        await request(httpServer(app)).delete(`${base}/${familyId}`).set('Authorization', opsAuth),
        BizCode.CERTIFICATE_STANDARD_IN_USE,
      );
    });

    it('被认定规则引用 → 18032', async () => {
      const id = await createActiveStandard();
      expect((await createPolicy(id)).status).toBe(201);
      expectBizError(
        await request(httpServer(app)).delete(`${base}/${id}`).set('Authorization', opsAuth),
        BizCode.CERTIFICATE_STANDARD_IN_USE,
      );
    });

    it('软删后详情 404', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      await request(httpServer(app)).delete(`${base}/${id}`).set('Authorization', opsAuth);
      expectBizError(
        await request(httpServer(app)).get(`${base}/${id}`).set('Authorization', opsAuth),
        BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
      );
    });
  });

  // ============ Policy ============

  describe('Policy 创建与字段组合(§5.3 / §5.4)', () => {
    it('FAMILY 不能配 Policy → 18012', async () => {
      const familyId = await createActiveStandard({ kind: 'FAMILY' });
      expectBizError(await createPolicy(familyId), BizCode.CERTIFICATE_STANDARD_KIND_INVALID);
    });

    it('version 服务端分配:首版 1,再建为 2(客户端传不进来)', async () => {
      const id = await createActiveStandard();
      const v1 = await createPolicy(id);
      expect(v1.status).toBe(201);
      expect(v1.body.data.version).toBe(1);
      expect(v1.body.data.status).toBe('DRAFT');
      const v2 = await createPolicy(id);
      expect(v2.body.data.version).toBe(2);
    });

    it('FIXED_MONTHS 缺月数 → 18015;非 FIXED_MONTHS 带月数 → 18015', async () => {
      const id = await createActiveStandard();
      expectBizError(
        await createPolicy(id, { validityMode: 'FIXED_MONTHS', validityMonths: undefined }),
        BizCode.CERTIFICATE_VALIDITY_INVALID,
      );
      expectBizError(
        await createPolicy(id, { validityMode: 'PERMANENT', validityMonths: 24 }),
        BizCode.CERTIFICATE_VALIDITY_INVALID,
      );
    });

    it('四种 validityMode 各自的合法形态都放行', async () => {
      const id = await createActiveStandard();
      const cases = [
        { validityMode: 'PERMANENT', validityMonths: undefined },
        { validityMode: 'FIXED_MONTHS', validityMonths: 24 },
        { validityMode: 'EXPLICIT_REQUIRED', validityMonths: undefined },
        { validityMode: 'EXPLICIT_OPTIONAL', validityMonths: undefined },
      ];
      for (const c of cases) {
        const res = await createPolicy(id, c);
        expect(res.status).toBe(201);
        expect(res.body.data.validityMode).toBe(c.validityMode);
        expect(res.body.data.validityMonths).toBe(c.validityMonths ?? null);
      }
    });

    it('issuer 数量三态:FIXED 恰好 1 / ALLOWLIST ≥1 / FREE_TEXT 恰好 0', async () => {
      const id = await createActiveStandard();
      expect(
        (await createPolicy(id, { issuerPolicy: 'FIXED', issuers: [{ name: 'A' }] })).status,
      ).toBe(201);
      expectBizError(
        await createPolicy(id, { issuerPolicy: 'FIXED', issuers: [{ name: 'A' }, { name: 'B' }] }),
        BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
      );
      expectBizError(
        await createPolicy(id, { issuerPolicy: 'ALLOWLIST', issuers: [] }),
        BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
      );
      expect((await createPolicy(id, { issuerPolicy: 'FREE_TEXT', issuers: [] })).status).toBe(201);
      expectBizError(
        await createPolicy(id, { issuerPolicy: 'FREE_TEXT', issuers: [{ name: 'A' }] }),
        BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
      );
    });

    it('机构名归一后重复 → 18013(大小写与空白不同也算重复)', async () => {
      const id = await createActiveStandard();
      expectBizError(
        await createPolicy(id, {
          issuerPolicy: 'ALLOWLIST',
          issuers: [{ name: 'Red Cross' }, { name: '  red   CROSS ' }],
        }),
        BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
      );
    });

    it('中文机构名不做后缀剥离:两个相近但不同的机构可共存', async () => {
      const id = await createActiveStandard();
      const res = await createPolicy(id, {
        issuerPolicy: 'ALLOWLIST',
        issuers: [{ name: '深圳市急救中心' }, { name: '深圳市急救' }],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.issuers).toHaveLength(2);
    });
  });

  describe('Policy 激活(§5.3 七步)', () => {
    it('激活会**原子退役**该 Standard 当前 ACTIVE 版', async () => {
      const id = await createActiveStandard();
      const v1 = await createPolicy(id);
      const v2 = await createPolicy(id);

      const a1 = await request(httpServer(app))
        .patch(`${policyBase}/${v1.body.data.id}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'ACTIVE' });
      expect(a1.status).toBe(200);
      expect(a1.body.data.activatedAt).not.toBeNull();

      const a2 = await request(httpServer(app))
        .patch(`${policyBase}/${v2.body.data.id}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'ACTIVE' });
      expect(a2.status).toBe(200);

      // v1 应已 RETIRED,且全表只剩一个 ACTIVE。
      const list = await request(httpServer(app))
        .get(`${base}/${id}/recognition-policies`)
        .set('Authorization', opsAuth);
      const byId = new Map<string, { status: string; retiredAt: string | null }>(
        (
          list.body.data.items as Array<{ id: string; status: string; retiredAt: string | null }>
        ).map((p) => [p.id, { status: p.status, retiredAt: p.retiredAt }]),
      );
      expect(byId.get(v1.body.data.id as string)?.status).toBe('RETIRED');
      expect(byId.get(v1.body.data.id as string)?.retiredAt).not.toBeNull();
      expect(byId.get(v2.body.data.id as string)?.status).toBe('ACTIVE');
      expect(
        (list.body.data.items as Array<{ status: string }>).filter((p) => p.status === 'ACTIVE'),
      ).toHaveLength(1);
    });

    it('Standard 非 ACTIVE 时不能激活 Policy → 18031', async () => {
      const created = await createStandard();
      const draftStandardId = created.body.data.id as string;
      // DRAFT Standard 上可以建 DRAFT Policy,但不能激活。
      const policy = await createPolicy(draftStandardId);
      expect(policy.status).toBe(201);
      expectBizError(
        await request(httpServer(app))
          .patch(`${policyBase}/${policy.body.data.id}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' }),
        BizCode.CERTIFICATE_STANDARD_INACTIVE,
      );
    });

    it('ACTIVE / RETIRED 的 Policy 不可修改 → 18036', async () => {
      const id = await createActiveStandard();
      const p = await createPolicy(id);
      const pid = p.body.data.id as string;
      await request(httpServer(app))
        .patch(`${policyBase}/${pid}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'ACTIVE' });

      expectBizError(
        await request(httpServer(app))
          .patch(`${policyBase}/${pid}`)
          .set('Authorization', opsAuth)
          .send({ certNumberMode: 'NONE' }),
        BizCode.CERTIFICATE_POLICY_IMMUTABLE,
      );
      expectBizError(
        await request(httpServer(app)).delete(`${policyBase}/${pid}`).set('Authorization', opsAuth),
        BizCode.CERTIFICATE_POLICY_IMMUTABLE,
      );
    });

    it('RETIRED 不可恢复为 ACTIVE → 18037', async () => {
      const id = await createActiveStandard();
      const v1 = await createPolicy(id);
      const v2 = await createPolicy(id);
      const pid1 = v1.body.data.id as string;
      for (const p of [pid1, v2.body.data.id as string]) {
        await request(httpServer(app))
          .patch(`${policyBase}/${p}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' });
      }
      // pid1 此刻已被 v2 的激活原子退役。
      expectBizError(
        await request(httpServer(app))
          .patch(`${policyBase}/${pid1}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' }),
        BizCode.CERTIFICATE_POLICY_STATE_INVALID,
      );
    });

    it('DRAFT 的 issuers 整体替换(不做增量 merge)', async () => {
      const id = await createActiveStandard();
      const p = await createPolicy(id, {
        issuerPolicy: 'ALLOWLIST',
        issuers: [{ name: 'A' }, { name: 'B' }],
      });
      const res = await request(httpServer(app))
        .patch(`${policyBase}/${p.body.data.id}`)
        .set('Authorization', opsAuth)
        .send({ issuers: [{ name: 'C' }] });
      expect(res.status).toBe(200);
      expect(res.body.data.issuers.map((i: { name: string }) => i.name)).toEqual(['C']);
    });

    it('替换后 issuer 数量仍须匹配 issuerPolicy → 违反即 18013', async () => {
      const id = await createActiveStandard();
      const p = await createPolicy(id, { issuerPolicy: 'ALLOWLIST', issuers: [{ name: 'A' }] });
      expectBizError(
        await request(httpServer(app))
          .patch(`${policyBase}/${p.body.data.id}`)
          .set('Authorization', opsAuth)
          .send({ issuers: [] }),
        BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID,
      );
    });
  });

  // ============ §22.2 真并发激活 ============

  describe('§22.2 并发激活(真实 PostgreSQL,不 mock)', () => {
    it('同一 Policy 并发激活:恰好一个 200,另一个 18037', async () => {
      const id = await createActiveStandard();
      const p = await createPolicy(id);
      const pid = p.body.data.id as string;

      const fire = (): Promise<request.Response> =>
        request(httpServer(app))
          .patch(`${policyBase}/${pid}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' });

      const [r1, r2] = await Promise.all([fire(), fire()]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, BizCode.CERTIFICATE_POLICY_STATE_INVALID.httpStatus]);

      const loser = r1.status === 200 ? r2 : r1;
      expect(loser.body.code).toBe(BizCode.CERTIFICATE_POLICY_STATE_INVALID.code);

      // 无论谁赢,DB 里该 Standard 恒只有一个 ACTIVE。
      const activeCount = await prisma.certificateRecognitionPolicy.count({
        where: { standardId: id, status: 'ACTIVE', deletedAt: null },
      });
      expect(activeCount).toBe(1);
    });

    it('两个不同版本并发激活:串行化后仍恒只有一个 ACTIVE(partial unique 兜底)', async () => {
      const id = await createActiveStandard();
      const v1 = await createPolicy(id);
      const v2 = await createPolicy(id);

      const fire = (pid: string): Promise<request.Response> =>
        request(httpServer(app))
          .patch(`${policyBase}/${pid}/status`)
          .set('Authorization', opsAuth)
          .send({ status: 'ACTIVE' });

      await Promise.all([fire(v1.body.data.id as string), fire(v2.body.data.id as string)]);

      // 这里不断言「只有一个成功」—— 两个**不同版本**的激活是两次合法管理动作,
      // 行锁把它们串行化,后者原子退役前者,两次都可以成功。
      // 真正的不变量是 D-CERT-006:任一时刻至多一个 ACTIVE。
      const activeCount = await prisma.certificateRecognitionPolicy.count({
        where: { standardId: id, status: 'ACTIVE', deletedAt: null },
      });
      expect(activeCount).toBe(1);
    });
  });

  // ============ options 投影(§13.1)============

  describe('options 投影', () => {
    it('只返 CREDENTIAL,不返 FAMILY', async () => {
      const familyId = await createActiveStandard({ kind: 'FAMILY' });
      const res = await request(httpServer(app))
        .get(`${base}/options?limit=200`)
        .set('Authorization', opsAuth);
      expect(res.status).toBe(200);
      const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).not.toContain(familyId);
    });

    it('无 ACTIVE Policy → currentlyRecognized=false 且 currentPolicy=null(已收录待认定)', async () => {
      const id = await createActiveStandard();
      const res = await request(httpServer(app))
        .get(`${base}/options?limit=200`)
        .set('Authorization', opsAuth);
      const item = (
        res.body.data.items as Array<{
          id: string;
          currentlyRecognized: boolean;
          currentPolicy: unknown;
        }>
      ).find((i) => i.id === id);
      expect(item?.currentlyRecognized).toBe(false);
      expect(item?.currentPolicy).toBeNull();
    });

    it('有 ACTIVE Policy → 带回规则摘要与 issuer 选项(前端据此决定表单形态)', async () => {
      const id = await createActiveStandard();
      const p = await createPolicy(id, {
        issuerPolicy: 'ALLOWLIST',
        validityMode: 'FIXED_MONTHS',
        validityMonths: 36,
        certNumberMode: 'OPTIONAL',
        issuers: [{ name: '机构甲' }, { name: '机构乙' }],
      });
      await request(httpServer(app))
        .patch(`${policyBase}/${p.body.data.id}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'ACTIVE' });

      const res = await request(httpServer(app))
        .get(`${base}/options?recognizedOnly=true&limit=200`)
        .set('Authorization', opsAuth);
      const item = (
        res.body.data.items as Array<{
          id: string;
          currentlyRecognized: boolean;
          currentPolicy: {
            issuerPolicy: string;
            validityMode: string;
            validityMonths: number | null;
            certNumberMode: string;
            issuers: Array<{ id: string; name: string }>;
          } | null;
        }>
      ).find((i) => i.id === id);
      expect(item?.currentlyRecognized).toBe(true);
      expect(item?.currentPolicy?.issuerPolicy).toBe('ALLOWLIST');
      expect(item?.currentPolicy?.validityMode).toBe('FIXED_MONTHS');
      expect(item?.currentPolicy?.validityMonths).toBe(36);
      expect(item?.currentPolicy?.certNumberMode).toBe('OPTIONAL');
      expect(item?.currentPolicy?.issuers.map((i) => i.name)).toEqual(['机构甲', '机构乙']);
    });

    it('recognizedOnly=true 排除无 ACTIVE Policy 的标准', async () => {
      const noPolicy = await createActiveStandard();
      const res = await request(httpServer(app))
        .get(`${base}/options?recognizedOnly=true&limit=200`)
        .set('Authorization', opsAuth);
      const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).not.toContain(noPolicy);
    });

    it('DRAFT 标准恒不进 options(任何 recognizedOnly 取值)', async () => {
      const draft = await createStandard();
      const draftId = draft.body.data.id as string;
      for (const qs of ['', '?recognizedOnly=true', '?recognizedOnly=false']) {
        const res = await request(httpServer(app))
          .get(`${base}/options${qs}${qs ? '&' : '?'}limit=200`)
          .set('Authorization', opsAuth);
        const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
        expect(ids).not.toContain(draftId);
      }
    });
  });

  // ============ 审计(§17)============

  describe('审计(§17 两个高价值事件)', () => {
    it('Standard 创建 / 激活 / 删除各落一条 certificate-standard.change,operation 闭集', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      await activateStandard(id);
      await request(httpServer(app)).delete(`${base}/${id}`).set('Authorization', opsAuth);

      const logs = await prisma.auditLog.findMany({
        where: { event: 'certificate-standard.change', resourceId: id },
        orderBy: { createdAt: 'asc' },
        select: { context: true, resourceType: true },
      });
      expect(logs).toHaveLength(3);
      expect(logs.every((l) => l.resourceType === 'certificate_standard')).toBe(true);
      const ops = logs.map((l) => (l.context as { extra: { operation: string } }).extra.operation);
      expect(ops).toEqual(['create', 'activate', 'delete']);
    });

    it('Policy 建版与激活落 certificate-recognition-policy.change;快照含 issuerNames 不含敏感字段', async () => {
      const id = await createActiveStandard();
      const p = await createPolicy(id, {
        issuerPolicy: 'ALLOWLIST',
        issuers: [{ name: '审计机构' }],
      });
      const pid = p.body.data.id as string;
      await request(httpServer(app))
        .patch(`${policyBase}/${pid}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'ACTIVE' });

      const logs = await prisma.auditLog.findMany({
        where: { event: 'certificate-recognition-policy.change', resourceId: pid },
        orderBy: { createdAt: 'asc' },
        select: { context: true },
      });
      expect(logs).toHaveLength(2);
      const ops = logs.map((l) => (l.context as { extra: { operation: string } }).extra.operation);
      expect(ops).toEqual(['create-policy', 'activate-policy']);
      const dump = JSON.stringify(logs);
      expect(dump).toContain('审计机构'); // canonical 机构名可写(§17)
      expect(dump).toContain('policyVersion');

      // 快照不得出现真正的敏感字段(§15.6 / §17)。
      // 逐 key 精确比对而不是对整串跑宽正则 —— `certNumber` 是禁的,
      // 但 `certNumberMode`(REQUIRED/OPTIONAL/NONE 规则名)是 §17 明确允许的,
      // 用 /certNumber/i 会把后者一起误伤(第一版就栽在这)。
      const FORBIDDEN_KEYS = ['certNumber', 'imageKeys', 'signedUrl', 'verifyNote', 'reviewNote'];
      const collectKeys = (v: unknown, acc: Set<string>): void => {
        if (Array.isArray(v)) {
          v.forEach((x) => collectKeys(x, acc));
        } else if (v !== null && typeof v === 'object') {
          for (const [k, val] of Object.entries(v)) {
            acc.add(k);
            collectKeys(val, acc);
          }
        }
      };
      const keys = new Set<string>();
      collectKeys(logs, keys);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys.has(forbidden)).toBe(false);
      }
      // 允许清单里的 certNumberMode 确实在(证明上面比的是精确 key 而非子串)
      expect(keys.has('certNumberMode')).toBe(true);
    });
  });
});
