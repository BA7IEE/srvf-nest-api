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

    // 评审 findings F5(R2)**翻面**:这条原先断言「身份字段一律不在 PATCH 白名单」。
    // 那条设计在本模型里走不通 —— `code` 是含软删行的全量 @unique,
    // 软删一个填错的 DRAFT 标准之后它的 code 被永久占用,「删掉重建」只能换 code。
    // 首批初始化打错一个字就是死胡同。现在 DRAFT 期开放**除 code 外**的身份字段。
    //
    // 反向断言的寿命只到它锁住的事实成立那一刻 —— 这一刀让它过期,同刀翻面。
    it('code 与 status 永远不在 PATCH 白名单 → 40000(改 code 等于改身份;status 走独立端点)', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      for (const forbidden of [{ code: 'x' }, { status: 'ACTIVE' }]) {
        const res = await request(httpServer(app))
          .patch(`${base}/${id}`)
          .set('Authorization', opsAuth)
          .send(forbidden);
        expect(res.status).toBe(400);
      }
    });

    it('R2 DRAFT 期可改身份字段(除 code)', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      const res = await request(httpServer(app))
        .patch(`${base}/${id}`)
        .set('Authorization', opsAuth)
        .send({ kind: 'FAMILY', categoryCode: otherCategoryCode, isInternal: true });
      expect(res.status).toBe(200);
      expect(res.body.data.kind).toBe('FAMILY');
      expect(res.body.data.categoryCode).toBe(otherCategoryCode);
      expect(res.body.data.isInternal).toBe(true);
    });

    it('R2 首次 ACTIVE 之后身份字段永久锁死 → 18033(哪怕后来又 INACTIVE)', async () => {
      const id = await createActiveStandard();
      expectBizError(
        await request(httpServer(app))
          .patch(`${base}/${id}`)
          .set('Authorization', opsAuth)
          .send({ categoryCode: otherCategoryCode }),
        BizCode.CERTIFICATE_STANDARD_IMMUTABLE,
      );

      // 停用后仍然不可改 —— 判据是 `activatedAt`(首次启用过)而不是当前 status。
      // 只看 status 会让一个 INACTIVE 标准被误判成可改身份,而它可能已被历史证书引用。
      await request(httpServer(app))
        .patch(`${base}/${id}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'INACTIVE' });
      expectBizError(
        await request(httpServer(app))
          .patch(`${base}/${id}`)
          .set('Authorization', opsAuth)
          .send({ kind: 'FAMILY' }),
        BizCode.CERTIFICATE_STANDARD_IMMUTABLE,
      );
    });

    it('R2 改身份字段仍走字典与父级校验(不是把校验一起放开)', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      expectBizError(
        await request(httpServer(app))
          .patch(`${base}/${id}`)
          .set('Authorization', opsAuth)
          .send({ categoryCode: 'no-such-category' }),
        BizCode.CERTIFICATE_TYPE_CODE_INVALID,
      );
      // 自己挂自己 —— DRAFT 行此刻可能已有子节点,create 期「结构上不可能成环」
      // 的论证在这里不成立,必须显式拦。
      expectBizError(
        await request(httpServer(app))
          .patch(`${base}/${id}`)
          .set('Authorization', opsAuth)
          .send({ parentId: id }),
        BizCode.CERTIFICATE_STANDARD_PARENT_INVALID,
      );
    });

    it('PATCH 接受 name / description / sortOrder', async () => {
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

  // 评审 findings H3:`@IsOptional()` 对 `null` 与 `undefined` **都**跳过校验,
  // 而 service 的判据是 `!== undefined` —— 显式 `null` 因此穿过契约层进入
  // 字典查询 / 父节点查询 / Prisma 写入,炸成 500。
  //
  // 契约上「可省略」与「可为空」是两件事,DTO 必须分开表达:
  // 恒有值的字段用 `@ValidateIf(v !== undefined)`(传 null → 400),
  // 真能清空的字段(Update 的 levelCode / parentId / description)才留 `@IsOptional()`。
  //
  // 每条都是**真 HTTP**:`null` 能不能穿过 ValidationPipe 只有真请求答得了,
  // service 单测拿到的永远是已经过完管道的对象。
  describe('H3 显式 null 的契约(400 而不是 500)', () => {
    const CREATE_NON_NULLABLE = ['levelCode', 'parentId', 'isInternal', 'sortOrder'] as const;
    for (const field of CREATE_NON_NULLABLE) {
      it(`POST ${'`'}${field}: null${'`'} → 400(修复前 500)`, async () => {
        const res = await createStandard({ [field]: null });
        expect(res.status).toBe(400);
      });
    }

    // Update DTO 含五个身份字段 + 三个文案/排序字段,同一形状要一起判。
    // `levelCode` / `parentId` 不在这张表里 —— 它们**契约上就允许 null**(清空 / 摘到根)。
    const UPDATE_NON_NULLABLE = [
      'name',
      'sortOrder',
      'kind',
      'categoryCode',
      'isInternal',
    ] as const;
    for (const field of UPDATE_NON_NULLABLE) {
      it(`PATCH ${'`'}${field}: null${'`'} → 400(修复前 500)`, async () => {
        const created = await createStandard();
        const res = await request(httpServer(app))
          .patch(`${base}/${created.body.data.id}`)
          .set('Authorization', opsAuth)
          .send({ [field]: null });
        expect(res.status).toBe(400);
      });
    }

    // levelCode / parentId 传 null = 清空 / 摘到根 —— 这是**刻意保留**的能力,
    // 上面那批收紧不得把它一起收掉(否则 DRAFT 期填错了等级就再也清不掉)。
    it('PATCH levelCode: null / parentId: null 仍是「清空」而不是 400', async () => {
      const familyId = await createActiveStandard({ kind: 'FAMILY' });
      const created = await createStandard({ levelCode, parentId: familyId });
      expect(created.status).toBe(201);
      const res = await request(httpServer(app))
        .patch(`${base}/${created.body.data.id}`)
        .set('Authorization', opsAuth)
        .send({ levelCode: null, parentId: null });
      expect(res.status).toBe(200);
      expect(res.body.data.levelCode).toBeNull();
      expect(res.body.data.parentId).toBeNull();
    });

    // description 单独判定:DB 可空,运行时一直接受 null 且语义就是「清空说明」。
    // 本刀让 DTO / OpenAPI 把这件既成事实说出来(`nullable: true` + `string | null`),
    // **运行时行为一个字节不变** —— 不是顺手放开一个新能力,是让三处语义一致。
    it('description: null 在 create 与 update 都合法,语义 = 空说明', async () => {
      const created = await createStandard({ description: null });
      expect(created.status).toBe(201);
      expect(created.body.data.description).toBeNull();

      const withText = await createStandard({ description: '原说明' });
      const cleared = await request(httpServer(app))
        .patch(`${base}/${withText.body.data.id}`)
        .set('Authorization', opsAuth)
        .send({ description: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.description).toBeNull();
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

    // 评审 findings H4:冻结稿 §5.2「禁止形成父子循环」此前**零执法** ——
    // 全文件没有任何环检查,只有 update 路径上一句 `nextParentId === id` 的自引用拦截。
    //
    // ⚠️ 与 findings 原文的出入(已在 PR body 说明):原文给的两级环可达路径
    // 「建 DRAFT FAMILY A → 建 DRAFT FAMILY B 挂 A → 改 A 挂 B」**走不通** ——
    // 第二步就撞 `assertParentUsable` 的「父不能是 DRAFT」(上一条用例锁着)。
    // 事实上通过 API 根本构造不出环:设边要求父**已启用**、子**从未启用**,
    // 于是沿环一圈得到 activation 时刻严格递减又必须回到自己,矛盾。
    //
    // 那为什么还要补检查:那个「不可达」是三条互不相关的规则(父非 DRAFT /
    // 首启后身份锁死 / 状态机不可回 DRAFT)撞出来的**涌现性质**,三处代码里
    // 没有一个字提到「环」。谁哪天放松「父必须非 DRAFT」——「让我在 DRAFT 期
    // 把整棵树搭完再启用」是很自然的诉求 —— 环当场可达,而不会有任何测试变红。
    // 所以本刀把这条不变量做成**本地的、显式的、有执行位的**检查。
    //
    // 真实后果也一并记准(不夸大):后端是扁平一层查询、不做递归遍历,
    // 成环**不会**挂服务;真实后果是两节点互为子节点 ⇒ 删除守卫的子节点计数恒非零
    // ⇒ 谁都删不掉。admin-web 要渲染树,递归渲染遇环会挂 —— 那是另一个仓库,按推断记。
    it('H4 自引用必拒(create 与 update 两条设 parentId 的路径)', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      expectBizError(
        await request(httpServer(app))
          .patch(`${base}/${id}`)
          .set('Authorization', opsAuth)
          .send({ parentId: id }),
        BizCode.CERTIFICATE_STANDARD_PARENT_INVALID,
      );
    });

    it('H4 findings 原文那条两级环路径确实走不通 —— 第二步就被「父不能是 DRAFT」拦下', async () => {
      const familyA = await createStandard({ kind: 'FAMILY' });
      expect(familyA.status).toBe(201);
      // 第 2 步:建 FAMILY B 挂在**仍是 DRAFT** 的 A 下 → 18034,环从这里就断了。
      expectBizError(
        await createStandard({ kind: 'FAMILY', parentId: familyA.body.data.id }),
        BizCode.CERTIFICATE_STANDARD_STATE_INVALID,
      );
    });

    it('H4 合法挂树仍然通过 —— 环检查不得误伤正常的多级目录', async () => {
      const root = await createActiveStandard({ kind: 'FAMILY' });
      const midRes = await createStandard({ kind: 'FAMILY', parentId: root });
      expect(midRes.status).toBe(201);
      const mid = midRes.body.data.id as string;
      await activateStandard(mid);
      const leaf = await createStandard({ parentId: mid });
      expect(leaf.status).toBe(201);
      expect(leaf.body.data.parentId).toBe(mid);

      // DRAFT 期把叶子从 mid 改挂到 root(合法的重新挂树)也必须放行。
      const moved = await request(httpServer(app))
        .patch(`${base}/${leaf.body.data.id}`)
        .set('Authorization', opsAuth)
        .send({ parentId: root });
      expect(moved.status).toBe(200);
      expect(moved.body.data.parentId).toBe(root);
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

    // 评审 findings F5(R3):**只有 DRAFT 可删**。下面两条改用 DRAFT 父/DRAFT 标准,
    // 否则它们会因为「不是 DRAFT」而拒 —— 拒对了,但证明的不再是「被引用所以拒」。
    it('被子节点引用 → 18032(直插构造:R3 之后这个组合经 API 已不可达)', async () => {
      // R3 之前:建 ACTIVE FAMILY → 挂子 → 删父,靠引用计数拒。
      // R3 之后这条路走不通了 —— 挂子要求父是 ACTIVE(18034),而 ACTIVE 不可删,
      // 于是「有子节点的 DRAFT 父」经 API 造不出来。
      //
      // 守卫本身仍然保留(seed / 运维直写 / 将来放开父级规则都可能造出这种行),
      // 所以这里直插构造那个状态,证明**守卫**没随可达性一起消失。
      // 换成断言 18033 就是把「引用计数」这条不变量悄悄测没了。
      const created = await createStandard({ kind: 'FAMILY' });
      const familyId = created.body.data.id as string;
      await prisma.certificateStandard.create({
        data: {
          code: `std-child-${Math.random().toString(36).slice(2, 10)}`,
          name: '直插子节点',
          kind: 'CREDENTIAL',
          status: 'DRAFT',
          categoryCode,
          parentId: familyId,
        },
      });
      expectBizError(
        await request(httpServer(app)).delete(`${base}/${familyId}`).set('Authorization', opsAuth),
        BizCode.CERTIFICATE_STANDARD_IN_USE,
      );
    });

    it('被认定规则引用 → 18032', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      expect((await createPolicy(id)).status).toBe(201);
      expectBizError(
        await request(httpServer(app)).delete(`${base}/${id}`).set('Authorization', opsAuth),
        BizCode.CERTIFICATE_STANDARD_IN_USE,
      );
    });

    it('R3 已启用过的标准不可删 —— 即使零引用', async () => {
      // 修复前 ACTIVE / INACTIVE 也能软删。零引用的 ACTIVE 标准被删掉的后果是
      // 「这个 code 被永久占用且再也建不出来」,而 code 是长期稳定标识。
      const id = await createActiveStandard();
      expectBizError(
        await request(httpServer(app)).delete(`${base}/${id}`).set('Authorization', opsAuth),
        BizCode.CERTIFICATE_STANDARD_IN_USE,
      );
      await request(httpServer(app))
        .patch(`${base}/${id}/status`)
        .set('Authorization', opsAuth)
        .send({ status: 'INACTIVE' });
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
    it('Standard 创建 / 激活 各落一条 certificate-standard.change,operation 闭集', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      await activateStandard(id);

      const logs = await prisma.auditLog.findMany({
        where: { event: 'certificate-standard.change', resourceId: id },
        orderBy: { createdAt: 'asc' },
        select: { context: true, resourceType: true },
      });
      expect(logs).toHaveLength(2);
      expect(logs.every((l) => l.resourceType === 'certificate_standard')).toBe(true);
      const ops = logs.map((l) => (l.context as { extra: { operation: string } }).extra.operation);
      expect(ops).toEqual(['create', 'activate']);
    });

    // 删除审计单独一条:R3 之后只有 DRAFT 可删,上面那条链(建→激活→删)
    // 在同一个标准上已经走不通了。
    it('Standard 删除落一条 operation=delete(DRAFT 标准)', async () => {
      const created = await createStandard();
      const id = created.body.data.id as string;
      expect(
        (await request(httpServer(app)).delete(`${base}/${id}`).set('Authorization', opsAuth))
          .status,
      ).toBe(204);

      const logs = await prisma.auditLog.findMany({
        where: { event: 'certificate-standard.change', resourceId: id },
        orderBy: { createdAt: 'asc' },
        select: { context: true },
      });
      const ops = logs.map((l) => (l.context as { extra: { operation: string } }).extra.operation);
      expect(ops).toEqual(['create', 'delete']);
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
