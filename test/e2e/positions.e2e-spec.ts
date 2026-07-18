import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.2 / §3.3 / §7.2):职务定义 + 职务规则 CRUD e2e。
// 覆盖 positions 5 端点 + position-rules 4 端点主成功 + 关键失败:
//   - 权限边界(R 模式 rbac.can;USER / ADMIN 默认无 ops-admin → 30100;功能路径走 SUPER_ADMIN 短路,沿 PR2 memberships)
//   - positions:code 唯一(POSITION_CODE_DUPLICATE)/ 详情软删 404 / PATCH 禁改 code(400)/ **删除守卫**(被规则引用 → POSITION_IN_USE)
//   - position-rules:nodeTypeCode 字典校验(POSITION_RULE_NODE_TYPE_INVALID)/ positionId 存在(POSITION_NOT_FOUND)/
//     (nodeType,position) 唯一(POSITION_RULE_ALREADY_EXISTS)/ required-min-max 基数一致性
//   - R6 行为:同一 nodeType 可登记多个领导职务规则(team-leader + dept-leader 均 201)
//   - R8 行为:requireMembership=false 可落库
// position.* / position-rule.* 绑 ops-admin 由 seed-rbac.e2e-spec 对账;本 spec 功能路径走 SUPER_ADMIN 短路。

describe('positions / position-rules CRUD', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;

  let nodeTypeRescue: string; // 有效 node_type 字典项(R6 用)
  let nodeTypeGroup: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'pos-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'pos-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'pos-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'pos-su')).authHeader;
    adminDefaultAuth = (await loginAs(app, 'pos-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'pos-user')).authHeader;

    // node_type 字典(position-rule.nodeTypeCode 校验依赖;resetDb 已清空 seed,需自建)。
    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: 'Node Type' },
      select: { id: true },
    });
    const rescue = await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'e2e-nt-rescue', label: '救援队' },
      select: { code: true },
    });
    nodeTypeRescue = rescue.code;
    const group = await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'e2e-nt-group', label: '组' },
      select: { code: true },
    });
    nodeTypeGroup = group.code;
  });

  afterAll(async () => {
    await app.close();
  });

  let posSeq = 0;
  const uniqCode = (prefix: string) => `${prefix}-${(posSeq += 1)}`;

  const postPosition = (auth: string, body: object) =>
    request(httpServer(app)).post('/api/admin/v1/positions').set('Authorization', auth).send(body);

  const postRule = (auth: string, body: object) =>
    request(httpServer(app))
      .post('/api/admin/v1/position-rules')
      .set('Authorization', auth)
      .send(body);

  // 便捷:建一个 position 返回 id(SUPER_ADMIN)。
  const newPosition = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await postPosition(superAdminAuth, {
      code: uniqCode('e2e-pos'),
      name: '测试职务',
      categoryCode: 'LEADER',
      ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET /positions → 401', async () => {
      const res = await request(httpServer(app)).get('/api/admin/v1/positions');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET /positions → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/positions')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN 默认无 ops-admin GET /positions → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/positions')
        .set('Authorization', adminDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET /position-rules → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/position-rules')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST /positions → 30100', async () => {
      const res = await postPosition(userAuth, {
        code: uniqCode('e2e-pb'),
        name: 'x',
        categoryCode: 'LEADER',
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ positions CRUD ============

  describe('positions CRUD', () => {
    it('POST 创建 → 201 + 字段(含默认值)', async () => {
      const code = uniqCode('e2e-create');
      const res = await postPosition(superAdminAuth, {
        code,
        name: '队长',
        categoryCode: 'LEADER',
        rank: 10,
        isLeadership: true,
        allowMultiple: false,
      });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.code).toBe(code);
      expect(res.body.data.name).toBe('队长');
      expect(res.body.data.categoryCode).toBe('LEADER');
      expect(res.body.data.rank).toBe(10);
      expect(res.body.data.isLeadership).toBe(true);
      expect(res.body.data.allowMultiple).toBe(false);
      expect(res.body.data.allowConcurrent).toBe(true); // 列默认
      expect(res.body.data.status).toBe('ACTIVE'); // 列默认
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('POST 重复 code → POSITION_CODE_DUPLICATE', async () => {
      const code = uniqCode('e2e-dup');
      const first = await postPosition(superAdminAuth, { code, name: 'a', categoryCode: 'LEADER' });
      expect(first.status).toBe(201);
      const second = await postPosition(superAdminAuth, {
        code,
        name: 'b',
        categoryCode: 'DEPUTY',
      });
      expectBizError(second, BizCode.POSITION_CODE_DUPLICATE);
    });

    it('GET list → 200 分页(items/total/page/pageSize)+ categoryCode 过滤', async () => {
      await newPosition({ categoryCode: 'STAFF' });
      const res = await request(httpServer(app))
        .get('/api/admin/v1/positions?categoryCode=STAFF&pageSize=50')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(typeof res.body.data.total).toBe('number');
      expect(res.body.data.page).toBe(1);
      for (const item of res.body.data.items) {
        expect(item.categoryCode).toBe('STAFF');
      }
    });

    it('GET :id → 200;不存在 → POSITION_NOT_FOUND', async () => {
      const id = await newPosition();
      const ok = await request(httpServer(app))
        .get(`/api/admin/v1/positions/${id}`)
        .set('Authorization', superAdminAuth);
      expect(ok.status).toBe(200);
      expect(ok.body.data.id).toBe(id);

      const missing = await request(httpServer(app))
        .get('/api/admin/v1/positions/cl0000000000000000000000')
        .set('Authorization', superAdminAuth);
      expectBizError(missing, BizCode.POSITION_NOT_FOUND);
    });

    it('PATCH :id 改 name/status → 200;禁改 code → 400', async () => {
      const id = await newPosition();
      const ok = await request(httpServer(app))
        .patch(`/api/admin/v1/positions/${id}`)
        .set('Authorization', superAdminAuth)
        .send({ name: '改名', status: 'INACTIVE' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.name).toBe('改名');
      expect(ok.body.data.status).toBe('INACTIVE');

      // code 不在 UpdatePositionDto 白名单 → forbidNonWhitelisted 拦截 → 400
      // (ValidationPipe 自带 message "property code should not exist",非通用 40000 文案 → strictMessage:false)
      const forbidden = await request(httpServer(app))
        .patch(`/api/admin/v1/positions/${id}`)
        .set('Authorization', superAdminAuth)
        .send({ code: 'new-code' });
      expectBizError(forbidden, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH 不存在 → POSITION_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch('/api/admin/v1/positions/cl0000000000000000000000')
        .set('Authorization', superAdminAuth)
        .send({ name: 'x' });
      expectBizError(res, BizCode.POSITION_NOT_FOUND);
    });

    it('DELETE :id → 204;之后 GET → 404', async () => {
      const id = await newPosition();
      const del = await request(httpServer(app))
        .delete(`/api/admin/v1/positions/${id}`)
        .set('Authorization', superAdminAuth);
      expect(del.status).toBe(204);
      const after = await request(httpServer(app))
        .get(`/api/admin/v1/positions/${id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(after, BizCode.POSITION_NOT_FOUND);
    });
  });

  // ============ F1/A5 选择器(admin-api-fe-integration-roadmap.md §4 A5)============

  describe('GET /options 选择器投影', () => {
    it('SUPER_ADMIN → 200,items 含 {id,label,categoryCode},label=name', async () => {
      const id = await newPosition({ name: 'F1选择器职务', categoryCode: 'STAFF' });
      const res = await request(httpServer(app))
        .get('/api/admin/v1/positions/options')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data as object).sort()).toEqual(['items']);
      const item = (res.body.data.items as Array<Record<string, unknown>>).find((i) => i.id === id);
      expect(item).toEqual({ id, label: 'F1选择器职务', categoryCode: 'STAFF' });
    });

    it('q 模糊命中 name', async () => {
      await newPosition({ name: 'F1选择器唯一名称XYZ', categoryCode: 'STAFF' });
      const res = await request(httpServer(app))
        .get('/api/admin/v1/positions/options')
        .query({ q: '唯一名称XYZ' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const names = (res.body.data.items as Array<{ label: string }>).map((i) => i.label);
      expect(names).toEqual(['F1选择器唯一名称XYZ']);
    });

    it('categoryCode 过滤生效', async () => {
      const id = await newPosition({ name: 'F1过滤LEADER', categoryCode: 'LEADER' });
      const res = await request(httpServer(app))
        .get('/api/admin/v1/positions/options')
        .query({ categoryCode: 'LEADER' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const ids = (res.body.data.items as Array<{ id: string; categoryCode: string }>).map(
        (i) => i.id,
      );
      expect(ids).toContain(id);
      for (const item of res.body.data.items as Array<{ categoryCode: string }>) {
        expect(item.categoryCode).toBe('LEADER');
      }
    });

    it('limit 截断生效', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/positions/options')
        .query({ limit: 1 })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect((res.body.data.items as unknown[]).length).toBeLessThanOrEqual(1);
    });

    it('USER 调用 → RBAC_FORBIDDEN(同 list 复用 position.read.definition,D2 不新增码)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/positions/options')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ 删除守卫(冻结稿 §7.2)============

  describe('删除守卫', () => {
    it('职务被规则引用时禁删 → POSITION_IN_USE;删规则后可删', async () => {
      const positionId = await newPosition();
      const ruleRes = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId,
      });
      expect(ruleRes.status).toBe(201);
      const ruleId = ruleRes.body.data.id as string;

      // 被引用 → 禁删
      const blocked = await request(httpServer(app))
        .delete(`/api/admin/v1/positions/${positionId}`)
        .set('Authorization', superAdminAuth);
      expectBizError(blocked, BizCode.POSITION_IN_USE);

      // 删规则(释放引用)后 → 可删职务
      const delRule = await request(httpServer(app))
        .delete(`/api/admin/v1/position-rules/${ruleId}`)
        .set('Authorization', superAdminAuth);
      expect(delRule.status).toBe(204);
      const delPos = await request(httpServer(app))
        .delete(`/api/admin/v1/positions/${positionId}`)
        .set('Authorization', superAdminAuth);
      expect(delPos.status).toBe(204);
    });
  });

  // ============ position-rules CRUD ============

  describe('position-rules CRUD', () => {
    it('POST 创建(有效 nodeType + position)→ 201 + 字段默认值', async () => {
      const positionId = await newPosition();
      const res = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.nodeTypeCode).toBe(nodeTypeRescue);
      expect(res.body.data.positionId).toBe(positionId);
      expect(res.body.data.required).toBe(false); // 列默认
      expect(res.body.data.requireMembership).toBe(true); // 列默认
      expect(res.body.data.allowConcurrent).toBe(true); // 列默认
      expect(res.body.data.minCount).toBeNull();
      expect(res.body.data.maxCount).toBeNull();
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('POST 拒绝负数 minCount/maxCount', async () => {
      const negativeMin = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId: await newPosition(),
        minCount: -1,
      });
      const negativeMax = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId: await newPosition(),
        maxCount: -1,
      });

      // DTO @Min(0) 拦截的 ValidationPipe 文案不是 BizCode 固定 message。
      expectBizError(negativeMin, BizCode.BAD_REQUEST, { strictMessage: false });
      expectBizError(negativeMax, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    // 杀死“required/min 语义冲突可入库”的变异。
    it('POST 拒绝 required=false/minCount>0 与 required=true/minCount=0', async () => {
      const falseWithPositiveMin = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId: await newPosition(),
        required: false,
        minCount: 1,
      });
      const trueWithZeroMin = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId: await newPosition(),
        required: true,
        minCount: 0,
      });

      expectBizError(falseWithPositiveMin, BizCode.BAD_REQUEST);
      expectBizError(trueWithZeroMin, BizCode.BAD_REQUEST);
    });

    // 杀死“min/max 不比较”与“required=true 不隐含建议下限 1”的变异。
    it('POST 拒绝 minCount>maxCount 以及 required=true/maxCount=0', async () => {
      const inverted = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId: await newPosition(),
        required: true,
        minCount: 2,
        maxCount: 1,
      });
      const requiredButZeroMax = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId: await newPosition(),
        required: true,
        maxCount: 0,
      });

      expectBizError(inverted, BizCode.BAD_REQUEST);
      expectBizError(requiredButZeroMax, BizCode.BAD_REQUEST);
    });

    it('POST nodeTypeCode 非字典项 → POSITION_RULE_NODE_TYPE_INVALID', async () => {
      const positionId = await newPosition();
      const res = await postRule(superAdminAuth, {
        nodeTypeCode: 'not-a-real-node-type',
        positionId,
      });
      expectBizError(res, BizCode.POSITION_RULE_NODE_TYPE_INVALID);
    });

    it('POST positionId 不存在 → POSITION_NOT_FOUND', async () => {
      const res = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId: 'cl0000000000000000000000',
      });
      expectBizError(res, BizCode.POSITION_NOT_FOUND);
    });

    it('POST 同 (nodeType, position) 重复 → POSITION_RULE_ALREADY_EXISTS', async () => {
      const positionId = await newPosition();
      const first = await postRule(superAdminAuth, { nodeTypeCode: nodeTypeGroup, positionId });
      expect(first.status).toBe(201);
      const dup = await postRule(superAdminAuth, { nodeTypeCode: nodeTypeGroup, positionId });
      expectBizError(dup, BizCode.POSITION_RULE_ALREADY_EXISTS);
    });

    it('GET list 按 nodeTypeCode 过滤 → 200', async () => {
      const positionId = await newPosition();
      await postRule(superAdminAuth, { nodeTypeCode: nodeTypeRescue, positionId });
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/position-rules?nodeTypeCode=${nodeTypeRescue}&pageSize=50`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
      for (const item of res.body.data.items) {
        expect(item.nodeTypeCode).toBe(nodeTypeRescue);
      }
    });

    it('PATCH :id 改 required/status → 200;不存在 → POSITION_RULE_NOT_FOUND', async () => {
      const positionId = await newPosition();
      const created = await postRule(superAdminAuth, { nodeTypeCode: nodeTypeGroup, positionId });
      const id = created.body.data.id as string;
      const ok = await request(httpServer(app))
        .patch(`/api/admin/v1/position-rules/${id}`)
        .set('Authorization', superAdminAuth)
        .send({ required: true, minCount: 1 });
      expect(ok.status).toBe(200);
      expect(ok.body.data.required).toBe(true);
      expect(ok.body.data.minCount).toBe(1);

      const missing = await request(httpServer(app))
        .patch('/api/admin/v1/position-rules/cl0000000000000000000000')
        .set('Authorization', superAdminAuth)
        .send({ required: true });
      expectBizError(missing, BizCode.POSITION_RULE_NOT_FOUND);
    });

    // 杀死“PATCH 只看局部 DTO、不与现有基数合并校验”的变异。
    it('PATCH 基于合并后配置校验,冲突不落库且可显式解决', async () => {
      const positionId = await newPosition();
      const created = await postRule(superAdminAuth, {
        nodeTypeCode: nodeTypeRescue,
        positionId,
        required: true,
        minCount: 2,
        maxCount: 3,
      });
      const id = created.body.data.id as string;

      const tooSmallMax = await request(httpServer(app))
        .patch(`/api/admin/v1/position-rules/${id}`)
        .set('Authorization', superAdminAuth)
        .send({ maxCount: 1 });
      const requiredFalseOnly = await request(httpServer(app))
        .patch(`/api/admin/v1/position-rules/${id}`)
        .set('Authorization', superAdminAuth)
        .send({ required: false });

      expectBizError(tooSmallMax, BizCode.BAD_REQUEST);
      expectBizError(requiredFalseOnly, BizCode.BAD_REQUEST);

      const resolved = await request(httpServer(app))
        .patch(`/api/admin/v1/position-rules/${id}`)
        .set('Authorization', superAdminAuth)
        .send({ required: false, minCount: null });
      expect(resolved.status).toBe(200);
      expect(resolved.body.data.required).toBe(false);
      expect(resolved.body.data.minCount).toBeNull();
      expect(resolved.body.data.maxCount).toBe(3);
    });

    it('DELETE :id → 204', async () => {
      const positionId = await newPosition();
      const created = await postRule(superAdminAuth, { nodeTypeCode: nodeTypeRescue, positionId });
      const del = await request(httpServer(app))
        .delete(`/api/admin/v1/position-rules/${created.body.data.id}`)
        .set('Authorization', superAdminAuth);
      expect(del.status).toBe(204);
    });
  });

  // ============ R6 / R8 行为 ============

  describe('R6 / R8 行为', () => {
    it('R6:同一 nodeType 可登记多个领导职务规则(team + dept 均 201)', async () => {
      const teamLeader = await newPosition({
        code: uniqCode('e2e-r6-team'),
        categoryCode: 'LEADER',
      });
      const deptLeader = await newPosition({
        code: uniqCode('e2e-r6-dept'),
        categoryCode: 'LEADER',
      });
      // 用一个专用 nodeType,避免与其它用例撞唯一
      const nt = await prisma.dictItem.create({
        data: {
          typeId: (await prisma.dictType.findFirstOrThrow({ where: { code: 'node_type' } })).id,
          code: uniqCode('e2e-nt-r6'),
          label: 'R6',
        },
        select: { code: true },
      });
      const r1 = await postRule(superAdminAuth, { nodeTypeCode: nt.code, positionId: teamLeader });
      const r2 = await postRule(superAdminAuth, { nodeTypeCode: nt.code, positionId: deptLeader });
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      // 同 nodeType 两条领导规则并存
      const list = await request(httpServer(app))
        .get(`/api/admin/v1/position-rules?nodeTypeCode=${nt.code}&pageSize=50`)
        .set('Authorization', superAdminAuth);
      expect(list.body.data.items.length).toBe(2);
    });

    it('R8:requireMembership=false 可落库', async () => {
      const positionId = await newPosition();
      const nt = await prisma.dictItem.create({
        data: {
          typeId: (await prisma.dictType.findFirstOrThrow({ where: { code: 'node_type' } })).id,
          code: uniqCode('e2e-nt-r8'),
          label: 'R8',
        },
        select: { code: true },
      });
      const res = await postRule(superAdminAuth, {
        nodeTypeCode: nt.code,
        positionId,
        requireMembership: false,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.requireMembership).toBe(false);
    });
  });
});
