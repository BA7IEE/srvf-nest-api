import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// F1/A7(admin-api-fe-integration-roadmap.md §4 A7;net-new meta 模块):
// POST admin/v1/meta/resolve-labels 批量 id→label 解析 e2e。
//
// 角色 / 组织 / 职务用**真 seed**(子进程,沿 authz-explain / final-review-authz 范式)——
// ops-admin 真绑 meta.resolve.label(D2 两层权限:入口码 + per-type 各资源既有 .read.* 码,
// member.read.record 是 biz-admin 域码、ops-admin 不持有,借此验证 per-type 过滤非缺口而是设计)。
//
// 覆盖(DoD 4:静默省略 + per-type 过滤 + refs 上限):
//   ① 入口门:裸用户(无 meta.resolve.label)→ 30100
//   ② SUPER_ADMIN 一次性解析 6 类全部成功(member/user/organization/role/position/activity)
//   ③ per-type 过滤:ops-admin(持 meta.resolve.label,不持 member.read.record)→
//      member 类型整体静默省略,其余 5 类正常解析(两层权限互不替代,非缺口)
//   ④ 静默省略:不存在 / 已软删的 id 不出现在结果里,不报错
//   ⑤ type 白名单:非法 type → 400
//   ⑥ refs>200 → 400;refs=[] → 200 空对象

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'metarl-seed-su',
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

const RESOLVE_PATH = '/api/admin/v1/meta/resolve-labels';

describe('POST admin/v1/meta/resolve-labels(F1/A7 批量 id→label 解析)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superAdminAuth: string;
  let opsOnlyAuth: string; // ADMIN + ops-admin(持 meta.resolve.label,不持 member.read.record)
  let bareAuth: string; // 裸 USER,零绑定

  let memberId: string;
  let targetUserId: string;
  let organizationId: string;
  let roleId: string;
  let positionId: string;
  let activityId: string;

  function resolveLabels(auth: string, refs: Array<{ type: string; id: string }>) {
    return request(httpServer(app)).post(RESOLVE_PATH).set('Authorization', auth).send({ refs });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    runSeed();
    prisma = app.get(PrismaService);

    const opsAdminRoleId = (
      await prisma.rbacRole.findFirstOrThrow({ where: { code: 'ops-admin' }, select: { id: true } })
    ).id;

    const opsCaller = await createTestUser(app, { username: 'metarl-ops', role: Role.ADMIN });
    await grantOpsAdminToUser(app, opsCaller.id, opsAdminRoleId);
    opsOnlyAuth = (await loginAs(app, 'metarl-ops')).authHeader;

    await createTestUser(app, { username: 'metarl-bare', role: Role.USER });
    bareAuth = (await loginAs(app, 'metarl-bare')).authHeader;

    superAdminAuth = (await loginAs(app, SEED_ENV.SUPER_ADMIN_USERNAME)).authHeader;

    // 待解析实体:member/user 直接造;organization/role/position 复用真 seed 已有实体。
    const member = await prisma.member.create({
      data: { memberNo: 'metarl-mem-1', displayName: 'F1解析队员甲' },
      select: { id: true },
    });
    memberId = member.id;

    const targetUser = await createTestUser(app, {
      username: 'metarl-target',
      role: Role.USER,
      nickname: 'F1解析用户昵称',
    });
    targetUserId = targetUser.id;

    const org = await prisma.organization.findFirstOrThrow({
      where: { code: 'SRVF' },
      select: { id: true },
    });
    organizationId = org.id;

    roleId = opsAdminRoleId;

    const position = await prisma.organizationPosition.findFirstOrThrow({
      where: { code: 'team-leader' },
      select: { id: true },
    });
    positionId = position.id;

    const activity = await prisma.activity.create({
      data: {
        title: 'F1解析活动',
        activityTypeCode: 'metarl-type',
        organizationId,
        startAt: new Date('2027-01-01T08:00:00.000Z'),
        endAt: new Date('2027-01-01T12:00:00.000Z'),
        location: '测试地点',
        statusCode: 'published',
      },
      select: { id: true },
    });
    activityId = activity.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('① 裸用户(无 meta.resolve.label)→ RBAC_FORBIDDEN(入口门槛,先于 per-type 过滤)', async () => {
    const res = await resolveLabels(bareAuth, [{ type: 'organization', id: organizationId }]);
    expectBizError(res, BizCode.RBAC_FORBIDDEN);
  });

  it('② SUPER_ADMIN 一次性解析 6 类全部成功,label + 极少字段正确', async () => {
    const res = await resolveLabels(superAdminAuth, [
      { type: 'member', id: memberId },
      { type: 'user', id: targetUserId },
      { type: 'organization', id: organizationId },
      { type: 'role', id: roleId },
      { type: 'position', id: positionId },
      { type: 'activity', id: activityId },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data as Record<string, Record<string, Record<string, unknown>>>;

    expect(data.member[memberId]).toEqual({
      label: 'F1解析队员甲',
      memberNo: 'metarl-mem-1',
      gradeCode: null,
    });
    expect(data.user[targetUserId]).toEqual({
      label: 'F1解析用户昵称',
      username: 'metarl-target',
    });
    expect(data.organization[organizationId]).toMatchObject({ code: 'SRVF' });
    expect(data.role[roleId]).toMatchObject({ label: '运营管理员', code: 'ops-admin' });
    expect(data.position[positionId]).toMatchObject({ categoryCode: 'LEADER' });
    expect(data.activity[activityId]).toEqual({
      label: 'F1解析活动',
      startAt: '2027-01-01T08:00:00.000Z',
      statusCode: 'published',
    });
  });

  it('③ per-type 过滤:ops-admin 持 meta.resolve.label 但不持 member.read.record → member 整体静默省略,其余 5 类正常', async () => {
    const res = await resolveLabels(opsOnlyAuth, [
      { type: 'member', id: memberId },
      { type: 'user', id: targetUserId },
      { type: 'organization', id: organizationId },
      { type: 'role', id: roleId },
      { type: 'position', id: positionId },
      { type: 'activity', id: activityId },
    ]);
    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('member');
    expect(data).toHaveProperty('user');
    expect(data).toHaveProperty('organization');
    expect(data).toHaveProperty('role');
    expect(data).toHaveProperty('position');
    expect(data).toHaveProperty('activity');
  });

  it('④ 静默省略:不存在 / 已软删的 id 不出现在结果里,不报错', async () => {
    const softDeleted = await prisma.member.create({
      data: { memberNo: 'metarl-mem-deleted', displayName: '已软删队员', deletedAt: new Date() },
      select: { id: true },
    });
    const nonExistentId = 'cl0000000000000000000000';

    const res = await resolveLabels(superAdminAuth, [
      { type: 'member', id: memberId },
      { type: 'member', id: softDeleted.id },
      { type: 'member', id: nonExistentId },
    ]);
    expect(res.status).toBe(200);
    const memberBucket = res.body.data.member as Record<string, unknown>;
    expect(Object.keys(memberBucket)).toEqual([memberId]);
    expect(memberBucket[softDeleted.id]).toBeUndefined();
    expect(memberBucket[nonExistentId]).toBeUndefined();
  });

  it('⑤ type 不在白名单闭集 → 400', async () => {
    const res = await resolveLabels(superAdminAuth, [{ type: 'not-a-real-type', id: memberId }]);
    expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
  });

  it('⑥ refs 超过 200 条 → 400', async () => {
    const refs = Array.from({ length: 201 }, (_, i) => ({ type: 'member', id: `pad-${i}` }));
    const res = await resolveLabels(superAdminAuth, refs);
    expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
  });

  it('refs 恰好 200 条 → 200(边界值不误伤)', async () => {
    const refs = Array.from({ length: 199 }, (_, i) => ({ type: 'member', id: `pad-${i}` }));
    refs.push({ type: 'member', id: memberId });
    const res = await resolveLabels(superAdminAuth, refs);
    expect(res.status).toBe(200);
    expect(res.body.data.member[memberId]).toBeDefined();
  });

  it('refs 为空数组 → 200,返回空对象(非报错)', async () => {
    const res = await resolveLabels(superAdminAuth, []);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({});
  });

  it('混合多 type 单请求:仅返回实际命中的 type key(未命中的 type 不出现)', async () => {
    const res = await resolveLabels(superAdminAuth, [
      { type: 'member', id: 'cl0000000000000000000001' },
      { type: 'organization', id: organizationId },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('member');
    expect(res.body.data).toHaveProperty('organization');
  });
});
