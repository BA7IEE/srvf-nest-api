import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.7.2 last-super-admin spec(3 正向用例)
//
// **重要**:14.7 不测 LAST_SUPER_ADMIN_PROTECTED (10103) 负向用例 ——
// 在 v1 当前 service 实现下,assertNotSelf 先于 assertNotLastSuperAdmin,
// "唯一一个 SUPER_ADMIN 操作自己"被自我保护提前拦截 (10102),
// assertNotLastSuperAdmin 是冗余防御深度,unit test 可测,E2E 不可达。
//
// 触发 10103 需同时满足:
//   1. 操作者是 SUPER_ADMIN(否则 assertCanManageUser 拒成 10101)
//   2. 操作者 ACTIVE(否则 token 鉴权拒成 40100)
//   3. 操作者 ≠ 目标(否则 assertNotSelf 先抛 10102)
//   4. 排除目标后剩余 active SUPER_ADMIN === 0
// 但 1+2+3 ⇒ 操作者活着且不是目标,排除目标后操作者必然在剩余里 → 始终 ≥ 1。
// 不可能同时满足。
//
// 所以本 spec 只做正向回归:db 多个 SUPER_ADMIN 时,SUPER_ADMIN 互操作链路工作。
// 反向 10103 留给单元测试或 service 重构后再评估(不在 v0.1.0 范围)。
describe('SUPER_ADMIN 互操作正向回归(剩余 active SUPER_ADMIN ≥ 1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('A 软删另一个 SUPER_ADMIN B(db 中还有 C 作为后备) → 200,B 状态正确,剩余仍 ≥ 1', async () => {
    await createTestUser(app, { username: 'lsadel1a', role: Role.SUPER_ADMIN });
    const b = await createTestUser(app, { username: 'lsadel1b', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'lsadel1c', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'lsadel1a');

    const res = await request(httpServer(app))
      .delete(`/api/users/${b.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);

    const dbB = await prisma.user.findUnique({ where: { id: b.id } });
    expect(dbB?.deletedAt).not.toBeNull();
    expect(dbB?.status).toBe(UserStatus.DISABLED);

    // db 中应还有 ≥ 1 个 active SUPER_ADMIN(A 与 C)
    const remaining = await prisma.user.count({
      where: { role: Role.SUPER_ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
    });
    expect(remaining).toBeGreaterThanOrEqual(1);
  });

  it('A 把另一个 SUPER_ADMIN B 改 status=DISABLED(db 中还有 C) → 200', async () => {
    await createTestUser(app, { username: 'lsadis1a', role: Role.SUPER_ADMIN });
    const b = await createTestUser(app, { username: 'lsadis1b', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'lsadis1c', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'lsadis1a');

    const res = await request(httpServer(app))
      .patch(`/api/users/${b.id}/status`)
      .set('Authorization', authHeader)
      .send({ status: 'DISABLED' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(UserStatus.DISABLED);

    const dbB = await prisma.user.findUnique({ where: { id: b.id } });
    expect(dbB?.status).toBe(UserStatus.DISABLED);
  });

  it('A 把另一个 SUPER_ADMIN B 降级为 ADMIN(db 中还有 C) → 200', async () => {
    await createTestUser(app, { username: 'lsarole1a', role: Role.SUPER_ADMIN });
    const b = await createTestUser(app, { username: 'lsarole1b', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'lsarole1c', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'lsarole1a');

    const res = await request(httpServer(app))
      .patch(`/api/users/${b.id}/role`)
      .set('Authorization', authHeader)
      .send({ role: Role.ADMIN });

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe(Role.ADMIN);

    const dbB = await prisma.user.findUnique({ where: { id: b.id } });
    expect(dbB?.role).toBe(Role.ADMIN);
  });
});
