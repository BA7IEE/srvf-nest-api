import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * Integration Foundation v1 — PR1 Schema 地基的**双向变异对拍**(规格书 §57 验收 +
 * T0 冻结稿 §12.2 红字:「每条 CHECK 做双向变异对拍,而不只看 migration 跑通」)。
 *
 * 手法(免夹具):PG 对 INSERT **先验 CHECK、后验 FK** ⇒ 用哑 FK 值可以把两种失败
 * 区分开 —— 违规形状死于 `23514`(check_violation),合法形状穿过 CHECK 后死于
 * `23503`(foreign_key_violation)。每条 CHECK 各一对:
 *   反向 = 违规行必 23514;正向 = 合法行不是 23514(而是 23503)。
 *
 * 本 spec 的启动本身就是「干净库全 100 条 migration 重放」的执行位
 * (e2e 派生库 migrate deploy)。
 */

describe('Integration Foundation v1 PR1 —— schema 地基 CHECK 双向变异对拍(第 100 条 migration)', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * 裸 SQL 的错误码提取:Prisma 把底层 PG 错误包成 P2010,真实码在 meta.code
   * (23514=check_violation / 23503=foreign_key_violation / 23505=unique_violation)。
   */
  async function rawInsert(sql: string): Promise<string | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        const metaCode = (error.meta as { code?: string } | undefined)?.code;
        return metaCode ?? error.code;
      }
      throw error;
    }
  }

  it('枚举:PrincipalType 恰含 SERVICE_PRINCIPAL(终态五值)', async () => {
    const labels = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'PrincipalType'
      ORDER BY e.enumsortorder
    `;
    expect(labels.map((row) => row.enumlabel)).toEqual([
      'USER',
      'MEMBER',
      'POSITION_ASSIGNMENT',
      'SYSTEM',
      'SERVICE_PRINCIPAL',
    ]);
  });

  it('Permission 资格门 CHECK-P1:delegated ⇒ servicePrincipal(存量为零回填)', async () => {
    // resetDb 后 permissions 为空 —— 自造探针行,零回填断言对探针生效(列默认即事实)。
    await rawInsert(
      `INSERT INTO "permissions" ("id","code","module","action","resourceType","updatedAt")
       VALUES ('perm_probe','probe.check','probe','check','probe','2026-08-28')`,
    );
    const probe = await prisma.$queryRaw<
      Array<{ servicePrincipalAllowed: boolean; delegatedAccessAllowed: boolean }>
    >`SELECT "servicePrincipalAllowed", "delegatedAccessAllowed" FROM "permissions" WHERE id = 'perm_probe'`;
    // 零回填:新行走列默认,两个资格门都是 false。
    expect(probe[0]?.servicePrincipalAllowed).toBe(false);
    expect(probe[0]?.delegatedAccessAllowed).toBe(false);

    const code = await rawInsert(
      `UPDATE "permissions" SET "delegatedAccessAllowed" = true WHERE id = 'perm_probe'`,
    );
    expect(code).toBe('23514');
    const ok = await rawInsert(
      `UPDATE "permissions" SET "servicePrincipalAllowed" = true, "delegatedAccessAllowed" = true WHERE id = 'perm_probe'`,
    );
    expect(ok).toBe(null);
    await rawInsert(`DELETE FROM "permissions" WHERE id = 'perm_probe'`);
  });

  describe('DelegationGrant CHECK-D1(endedAt > startedAt)', () => {
    it('反向:endedAt ≤ startedAt 必 23514', async () => {
      const code = await rawInsert(
        `INSERT INTO "delegation_grants" ("id","servicePrincipalId","subjectUserId","scopeType","startedAt","endedAt","createdByUserId")
         VALUES ('dg_test','sp_dummy','user_dummy','GLOBAL','2099-09-01','2099-09-01','user_dummy')`,
      );
      expect(code).toBe('23514');
    });
    it('正向:endedAt > startedAt 穿过 CHECK(死于 FK 23503)', async () => {
      const code = await rawInsert(
        `INSERT INTO "delegation_grants" ("id","servicePrincipalId","subjectUserId","scopeType","startedAt","endedAt","createdByUserId")
         VALUES ('dg_test','sp_dummy','user_dummy','GLOBAL','2099-09-01','2099-09-02','user_dummy')`,
      );
      expect(code).toBe('23503');
    });
  });

  describe('DelegationGrant CHECK-D2(scope 形状闭集)', () => {
    it('反向:GLOBAL 带 scopeOrgId 必 23514', async () => {
      const code = await rawInsert(
        `INSERT INTO "delegation_grants" ("id","servicePrincipalId","subjectUserId","scopeType","scopeOrgId","createdByUserId")
         VALUES ('dg_test','sp_dummy','user_dummy','GLOBAL','org_dummy','user_dummy')`,
      );
      expect(code).toBe('23514');
    });
    it('反向:ORGANIZATION 缺 scopeOrgId 必 23514', async () => {
      const code = await rawInsert(
        `INSERT INTO "delegation_grants" ("id","servicePrincipalId","subjectUserId","scopeType","createdByUserId")
         VALUES ('dg_test','sp_dummy','user_dummy','ORGANIZATION','user_dummy')`,
      );
      expect(code).toBe('23514');
    });
    it('反向:RESOURCE 缺 scopeResourceId 必 23514', async () => {
      const code = await rawInsert(
        `INSERT INTO "delegation_grants" ("id","servicePrincipalId","subjectUserId","scopeType","scopeResourceType","createdByUserId")
         VALUES ('dg_test','sp_dummy','user_dummy','RESOURCE','member','user_dummy')`,
      );
      expect(code).toBe('23514');
    });
    it('正向:GLOBAL 全空 / ORGANIZATION 带 org / RESOURCE 带双键 —— 均穿过 CHECK(23503)', async () => {
      for (const scope of [
        `('dg_test','sp_dummy','user_dummy','GLOBAL',NULL,NULL,NULL,NULL,'user_dummy')`,
        `('dg_test','sp_dummy','user_dummy','ORGANIZATION','org_x',NULL,NULL,NULL,'user_dummy')`,
        `('dg_test','sp_dummy','user_dummy','RESOURCE',NULL,NULL,'member','m1','user_dummy')`,
      ]) {
        const code = await rawInsert(
          `INSERT INTO "delegation_grants" ("id","servicePrincipalId","subjectUserId","scopeType","scopeOrgId","scopeActivityId","scopeResourceType","scopeResourceId","createdByUserId")
           VALUES ${scope}`,
        );
        expect(code).toBe('23503');
      }
    });
  });

  describe('AuditLog 双主体 4 条 CHECK(A1–A4;三项全 null 必须放行)', () => {
    const base = `INSERT INTO "audit_logs" ("id","resourceType","event","context"`;
    it('正向:三项全 null(SRVF 内部系统任务形态)插入成功', async () => {
      const code = await rawInsert(`${base}) VALUES ('al_test','member','member.update','{}')`);
      expect(code).toBe(null);
      await rawInsert(`DELETE FROM "audit_logs" WHERE id = 'al_test'`);
    });
    it('A1 反向:actorUser 与 actorServicePrincipal 同时非空必 23514', async () => {
      const code = await rawInsert(
        `${base},"actorUserId","actorServicePrincipalId") VALUES ('al_test','member','member.update','{}','u1','sp_dummy')`,
      );
      expect(code).toBe('23514');
    });
    it('A2 反向:onBehalfOfUser 无 SP 必 23514', async () => {
      const code = await rawInsert(
        `${base},"onBehalfOfUserId") VALUES ('al_test','member','member.update','{}','u1')`,
      );
      expect(code).toBe('23514');
    });
    it('A3 反向:actorCredentialId 无 SP 必 23514', async () => {
      const code = await rawInsert(
        `${base},"actorCredentialId") VALUES ('al_test','member','member.update','{}','cred_dummy')`,
      );
      expect(code).toBe('23514');
    });
    it('A4 反向:onBehalfOfRoleSnap 无 onBehalfOfUser 必 23514', async () => {
      const code = await rawInsert(
        `${base},"onBehalfOfRoleSnap") VALUES ('al_test','member','member.update','{}','USER')`,
      );
      expect(code).toBe('23514');
    });
    it('正向:机器自身(actorSP+credential,无 onBehalfOf)与机器代人(SP+onBehalfOf+快照)均穿过 CHECK', async () => {
      const machineSelf = await rawInsert(
        `${base},"actorServicePrincipalId","actorCredentialId") VALUES ('al_test','member','member.update','{}','sp_dummy','cred_dummy')`,
      );
      expect(machineSelf).toBe('23503');
      const machineDelegated = await rawInsert(
        `${base},"actorServicePrincipalId","onBehalfOfUserId","onBehalfOfRoleSnap") VALUES ('al_test','member','member.update','{}','sp_dummy','u1','USER')`,
      );
      expect(machineDelegated).toBe('23503');
    });
  });

  it('IntegrationCommandReceipt 幂等唯一:同 (SP, operation, key) 第二条必撞唯一(23505)', async () => {
    const probeUser = await prisma.user.create({
      data: { username: 'pr1_probe_user', passwordHash: 'probe', role: 'SUPER_ADMIN' },
      select: { id: true },
    });
    await prisma.servicePrincipal.create({
      data: {
        id: 'sp_receipt_probe',
        clientId: 'srvf_sp_probe_1',
        name: 'receipt 探针',
        createdByUserId: probeUser.id,
      },
    });
    await prisma.servicePrincipalCredential.create({
      data: {
        id: 'cred_probe',
        servicePrincipalId: 'sp_receipt_probe',
        secretHash: 'probe_hash_only_not_a_real_secret',
        createdByUserId: probeUser.id,
      },
    });
    await prisma.integrationCommandReceipt.create({
      data: {
        servicePrincipalId: 'sp_receipt_probe',
        credentialId: 'cred_probe',
        operation: 'probe.echo',
        idempotencyKey: 'probe-key-1',
        requestHash: 'hash',
      },
    });
    const code = await rawInsert(
      `INSERT INTO "integration_command_receipts" ("id","servicePrincipalId","credentialId","operation","idempotencyKey","requestHash")
       VALUES ('rc2','sp_receipt_probe','cred_probe','probe.echo','probe-key-1','hash2')`,
    );
    expect(code).toBe('23505');
    // 同 SP 不同 operation 同 key 不撞(规格书 §65.7)。
    const otherOp = await rawInsert(
      `INSERT INTO "integration_command_receipts" ("id","servicePrincipalId","credentialId","operation","idempotencyKey","requestHash")
       VALUES ('rc3','sp_receipt_probe','cred_probe','probe.other','probe-key-1','hash')`,
    );
    expect(otherOp).toBe(null);
  });
});
