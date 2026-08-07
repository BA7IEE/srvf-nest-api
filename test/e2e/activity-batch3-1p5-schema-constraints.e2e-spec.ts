import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 活动业务改造 v1.1 —— 第 3 批①.5(D 档 schema 小刀;第 76 migration
// `20260806212358_activity_v11_batch3_slice1p5_templates_rule_snapshots_idempotency`)。
// 合同:docs/archive/reviews/activity-business-overhaul-v1.1/
//       SRVF_活动业务全流程改造_详细开发文档_v1.1.md §3.4 / §10.3。
//
// 本 spec 只验证真实 PostgreSQL 的 schema/trigger 执行位:两张表、版本化 unique、
// 三个 snapshot FK、AllocationBatch 补列 FK、§10.3 的 key unique，以及不可变快照。
// 零 endpoint / 零 service 行为；canonical JSON 的计算与模板解析归第 3 批第二刀。
//
// 🔴 每条拒绝前先有合法正对照。单独断言「被拒」无法证明约束绑对:恒拒的 CHECK / 错列
// 都会给出假绿。原生 SQL 的 PG 错误由 Prisma 包为 P2010，SQLSTATE 位于 meta.code。

const T = (iso: string) => `'${iso}'::timestamp`;
const SESSION_START = '2099-08-01T09:00:00.000Z';
const SESSION_END = '2099-08-01T17:00:00.000Z';
const CHECKIN_OPEN = '2099-08-01T08:30:00.000Z';
const CHECKIN_CLOSE = '2099-08-01T10:00:00.000Z';
const CHECKOUT_OPEN = '2099-08-01T16:00:00.000Z';
const CHECKOUT_CLOSE = '2099-08-01T18:00:00.000Z';

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

describe('活动改造 v1.1 第 3 批①.5 schema 约束(第 76 migration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let organizationId: string;
  let activityId: string;
  let userId: string;
  let sessionId: string;
  let reviewId: string;

  let seq = 0;
  const uniq = (label: string) => `v11b3s1p5-${label}-${(seq += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function run(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
        const meta = err.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        const matched = /constraint "([^"]+)"/.exec(message);
        return { sqlState: meta?.code ?? '', constraint: matched?.[1] ?? '', message };
      }
      throw err;
    }
  }

  async function expectAccepted(sql: string): Promise<void> {
    expect(await run(sql)).toBeNull();
  }

  async function expectRejected(
    sql: string,
    expected: { sqlState: string; constraint?: string; key?: string; messageContains?: string },
  ): Promise<RawDbError> {
    const err = await run(sql);
    expect(err).not.toBeNull();
    expect(err!.sqlState).toBe(expected.sqlState);
    if (expected.constraint !== undefined) expect(err!.constraint).toBe(expected.constraint);
    if (expected.key !== undefined) expect(err!.message).toContain(expected.key);
    if (expected.messageContains !== undefined)
      expect(err!.message).toContain(expected.messageContains);
    return err!;
  }

  const sqlText = (value: string | null) => (value === null ? 'NULL' : `'${value}'`);
  const sqlInt = (value: number | null) => (value === null ? 'NULL' : String(value));
  const sqlBool = (value: boolean | null) => (value === null ? 'NULL' : value ? 'TRUE' : 'FALSE');

  // 列名先由下方 information_schema 断言钉住;原生写入只验证 DB 约束本身。
  const templateSql = (
    id: string,
    o: {
      code?: string;
      version?: number;
      statusCode?: string;
      defaultRegistrationModeCode?: string | null;
      defaultLocationRequired?: boolean | null;
      defaultCheckInRadiusMeters?: number | null;
      checkInOpenOffsetMinutes?: number | null;
      checkInCloseOffsetMinutes?: number | null;
      checkOutOpenOffsetMinutes?: number | null;
      checkOutCloseOffsetMinutes?: number | null;
      defaultLateGraceMinutes?: number | null;
      defaultEarlyLeaveThresholdMinutes?: number | null;
      defaultArchiveWaitingDays?: number | null;
      commonPositionTemplates?: string | null;
    } = {},
  ) => {
    const v = {
      code: `template-${id}`,
      version: 1,
      statusCode: 'contract-set-pending',
      defaultRegistrationModeCode: 'open_apply' as string | null,
      defaultLocationRequired: true as boolean | null,
      defaultCheckInRadiusMeters: 300 as number | null,
      checkInOpenOffsetMinutes: -30 as number | null,
      checkInCloseOffsetMinutes: 60 as number | null,
      checkOutOpenOffsetMinutes: -30 as number | null,
      checkOutCloseOffsetMinutes: 60 as number | null,
      defaultLateGraceMinutes: 15 as number | null,
      defaultEarlyLeaveThresholdMinutes: 15 as number | null,
      defaultArchiveWaitingDays: 7 as number | null,
      commonPositionTemplates: '[{"code":"onsite","name":"Onsite"}]' as string | null,
      ...o,
    };
    return `INSERT INTO "ActivityTemplate"
      ("id","updatedAt","code","name","activityTypeCode","statusCode","version",
       "defaultRegistrationModeCode","defaultLocationRequired","defaultCheckInRadiusMeters",
       "checkInOpenOffsetMinutes","checkInCloseOffsetMinutes","checkOutOpenOffsetMinutes",
       "checkOutCloseOffsetMinutes","defaultLateGraceMinutes","defaultEarlyLeaveThresholdMinutes",
       "defaultArchiveWaitingDays","commonPositionTemplates")
      VALUES ('${id}', ${T(SESSION_START)}, '${v.code}', 'Template ${id}', 'v11-template',
       '${v.statusCode}', ${v.version}, ${sqlText(v.defaultRegistrationModeCode)},
       ${sqlBool(v.defaultLocationRequired)}, ${sqlInt(v.defaultCheckInRadiusMeters)},
       ${sqlInt(v.checkInOpenOffsetMinutes)}, ${sqlInt(v.checkInCloseOffsetMinutes)},
       ${sqlInt(v.checkOutOpenOffsetMinutes)}, ${sqlInt(v.checkOutCloseOffsetMinutes)},
       ${sqlInt(v.defaultLateGraceMinutes)}, ${sqlInt(v.defaultEarlyLeaveThresholdMinutes)},
       ${sqlInt(v.defaultArchiveWaitingDays)},
       ${v.commonPositionTemplates === null ? 'NULL' : `'${v.commonPositionTemplates}'::jsonb`})`;
  };

  const snapshotSql = (
    id: string,
    o: {
      activityId?: string;
      workflowRevision?: number;
      templateVersionId?: string | null;
      createdByReviewId?: string;
      resolvedConfig?: string;
      snapshotHash?: string;
    } = {},
  ) => {
    const v = {
      activityId,
      workflowRevision: 0,
      templateVersionId: 'template-1',
      createdByReviewId: reviewId,
      resolvedConfig: '{"activity":{"source":"template"},"sessions":[]}',
      snapshotHash: `canonical-${id}`,
      ...o,
    };
    return `INSERT INTO "ActivityRuleSnapshot"
      ("id","activityId","workflowRevision","templateVersionId","resolvedConfig","snapshotHash","createdByReviewId")
      VALUES ('${id}', '${v.activityId}', ${v.workflowRevision}, ${sqlText(v.templateVersionId)},
       '${v.resolvedConfig}'::jsonb, '${v.snapshotHash}', '${v.createdByReviewId}')`;
  };

  const batchSql = (id: string, ruleSnapshotId: string | null) =>
    `INSERT INTO "ActivityAllocationBatch"
      ("id","updatedAt","activityId","sessionId","modeCode","candidateSnapshotHash",
       "statusCode","operationKey","ruleSnapshotId")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', '${sessionId}', 'first_come',
       'candidate-hash', 'preparing', 'batch-key-${id}', ${sqlText(ruleSnapshotId)})`;

  const publishReviewSql = (
    id: string,
    requestVersion: number,
    o: {
      status?: 'pending' | 'approved';
      operationKey?: string | null;
      requestHash?: string | null;
      reviewOperationKey?: string | null;
      reviewRequestHash?: string | null;
    } = {},
  ) => {
    const v = {
      status: 'pending' as 'pending' | 'approved',
      operationKey: null as string | null,
      requestHash: null as string | null,
      reviewOperationKey: null as string | null,
      reviewRequestHash: null as string | null,
      ...o,
    };
    return `INSERT INTO "activity_publish_reviews"
      ("id","updatedAt","activityId","requestType","requestVersion","baseRevision","status",
       "snapshot","directPublish","submittedByUserId","submittedAt","operationKey","requestHash",
       "reviewOperationKey","reviewRequestHash")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', 'initial', ${requestVersion}, 0, '${v.status}',
       '{}'::jsonb, FALSE, '${userId}', ${T(SESSION_START)}, ${sqlText(v.operationKey)},
       ${sqlText(v.requestHash)}, ${sqlText(v.reviewOperationKey)}, ${sqlText(v.reviewRequestHash)})`;
  };

  async function createActivity(label: string): Promise<string> {
    return (
      await prisma.activity.create({
        data: {
          title: uniq(`activity-${label}`),
          activityTypeCode: 'v11-batch3-1p5',
          organizationId,
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          location: 'constraint fixture',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;
  }

  async function createReview(requestVersion: number): Promise<string> {
    return (
      await prisma.activityPublishReview.create({
        data: {
          activityId,
          requestType: 'initial',
          requestVersion,
          baseRevision: 0,
          status: 'approved',
          snapshot: { activity: {}, sessions: [] },
          submittedByUserId: userId,
        },
        select: { id: true },
      })
    ).id;
  }

  beforeEach(async () => {
    await resetDb(app);
    // ActivityTemplate 在本刀尚未被 Activity 反向引用；不能借 CASCADE 假装它会随 Activity
    // 清掉。写集不含 test/setup，因此本 spec 只在已由 resetDb 验证过的**当前 worker 库**
    // 局部 TRUNCATE 自己的 fixture，避免跨 it 残留；不触碰任何其它数据库。
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ActivityTemplate" RESTART IDENTITY CASCADE');

    organizationId = (
      await prisma.organization.create({
        data: { name: uniq('org'), nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;
    userId = (
      await prisma.user.create({
        data: { username: uniq('user').toLowerCase(), passwordHash: 'x' },
        select: { id: true },
      })
    ).id;
    activityId = await createActivity('base');
    sessionId = (
      await prisma.activitySession.create({
        data: {
          activityId,
          code: uniq('session'),
          name: uniq('session'),
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          locationText: 'constraint fixture',
          checkInOpenAt: new Date(CHECKIN_OPEN),
          checkInCloseAt: new Date(CHECKIN_CLOSE),
          checkOutOpenAt: new Date(CHECKOUT_OPEN),
          checkOutCloseAt: new Date(CHECKOUT_CLOSE),
          locationRequired: false,
          locationPolicySourceCode: 'system',
          statusCode: 'scheduled',
        },
        select: { id: true },
      })
    ).id;
    reviewId = await createReview(1);
  });

  describe('§3.4 ActivityTemplate:逐项落列、版本化与未定义 statusCode', () => {
    it('结构:合同点名的基础列和每项默认配置均为预期类型', async () => {
      const core = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'ActivityTemplate'
          AND column_name IN ('id', 'createdAt', 'updatedAt', 'code', 'name',
                              'activityTypeCode', 'statusCode', 'version')
        ORDER BY ordinal_position
      `;
      expect(core).toEqual([
        { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'createdAt', data_type: 'timestamp without time zone', is_nullable: 'NO' },
        { column_name: 'updatedAt', data_type: 'timestamp without time zone', is_nullable: 'NO' },
        { column_name: 'code', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'name', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'activityTypeCode', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'statusCode', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'version', data_type: 'integer', is_nullable: 'NO' },
      ]);

      const defaults = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'ActivityTemplate'
          AND column_name IN ('defaultRegistrationModeCode', 'defaultLocationRequired',
                              'defaultCheckInRadiusMeters', 'checkInOpenOffsetMinutes',
                              'checkInCloseOffsetMinutes', 'checkOutOpenOffsetMinutes',
                              'checkOutCloseOffsetMinutes', 'defaultLateGraceMinutes',
                              'defaultEarlyLeaveThresholdMinutes', 'defaultArchiveWaitingDays',
                              'commonPositionTemplates')
        ORDER BY column_name
      `;
      expect(defaults).toEqual([
        { column_name: 'checkInCloseOffsetMinutes', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'checkInOpenOffsetMinutes', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'checkOutCloseOffsetMinutes', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'checkOutOpenOffsetMinutes', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'commonPositionTemplates', data_type: 'jsonb', is_nullable: 'YES' },
        { column_name: 'defaultArchiveWaitingDays', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'defaultCheckInRadiusMeters', data_type: 'integer', is_nullable: 'YES' },
        {
          column_name: 'defaultEarlyLeaveThresholdMinutes',
          data_type: 'integer',
          is_nullable: 'YES',
        },
        { column_name: 'defaultLateGraceMinutes', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'defaultLocationRequired', data_type: 'boolean', is_nullable: 'YES' },
        { column_name: 'defaultRegistrationModeCode', data_type: 'text', is_nullable: 'YES' },
      ]);
    });

    it('立正对照:同 code 的不同版本及未定义集合中的 statusCode 都必须能写入', async () => {
      await expectAccepted(templateSql('template-1', { code: 'service-day', version: 1 }));
      await expectAccepted(
        templateSql('template-2', {
          code: 'service-day',
          version: 2,
          statusCode: 'future-status-not-yet-contracted',
        }),
      );
    });

    it('同 (code, version) 重复被拒;statusCode 没有擅自钉 CHECK', async () => {
      await expectAccepted(templateSql('template-1', { code: 'service-day', version: 1 }));
      await expectRejected(templateSql('template-dup', { code: 'service-day', version: 1 }), {
        sqlState: '23505',
        key: 'Key (code, version)',
      });

      const checks = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '"ActivityTemplate"'::regclass AND contype = 'c'
      `;
      expect(checks).toEqual([]);
    });
  });

  describe('§3.4 ActivityRuleSnapshot:形状、FK 与唯一版本锚点', () => {
    it('结构:不可变表没有 updatedAt/deletedAt，且合同字段全为必填', async () => {
      const cols = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'ActivityRuleSnapshot'
        ORDER BY ordinal_position
      `;
      expect(cols).toEqual([
        { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'createdAt', data_type: 'timestamp without time zone', is_nullable: 'NO' },
        { column_name: 'activityId', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'workflowRevision', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'templateVersionId', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'resolvedConfig', data_type: 'jsonb', is_nullable: 'NO' },
        { column_name: 'snapshotHash', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'createdByReviewId', data_type: 'text', is_nullable: 'NO' },
      ]);

      const fks = await prisma.$queryRaw<Array<{ conname: string; target: string }>>`
        SELECT conname, confrelid::regclass::text AS target
        FROM pg_constraint
        WHERE conrelid = '"ActivityRuleSnapshot"'::regclass AND contype = 'f'
        ORDER BY conname
      `;
      expect(fks).toEqual([
        { conname: 'ActivityRuleSnapshot_activityId_fkey', target: '"Activity"' },
        {
          conname: 'ActivityRuleSnapshot_createdByReviewId_fkey',
          target: 'activity_publish_reviews',
        },
        { conname: 'ActivityRuleSnapshot_templateVersionId_fkey', target: '"ActivityTemplate"' },
      ]);
    });

    it('立正对照:真实活动、模板版本和审核请求组成的快照可以插入', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-1'));
      const rows = await prisma.$queryRaw<Array<{ id: string; snapshotHash: string }>>`
        SELECT id, "snapshotHash" FROM "ActivityRuleSnapshot" WHERE id = 'snapshot-1'
      `;
      expect(rows).toEqual([{ id: 'snapshot-1', snapshotHash: 'canonical-snapshot-1' }]);
    });

    it('立正对照:无模板活动的快照可以插入', async () => {
      await expectAccepted(snapshotSql('snapshot-without-template', { templateVersionId: null }));
      const rows = await prisma.$queryRaw<Array<{ id: string; templateVersionId: string | null }>>`
        SELECT id, "templateVersionId" FROM "ActivityRuleSnapshot"
        WHERE id = 'snapshot-without-template'
      `;
      expect(rows).toEqual([{ id: 'snapshot-without-template', templateVersionId: null }]);
    });

    it('三根 FK 分别拒绝不存在的活动、模板版本与审核请求', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-ok'));
      await expectRejected(
        snapshotSql('snapshot-no-activity', {
          activityId: 'no-such-activity',
          workflowRevision: 1,
        }),
        {
          sqlState: '23503',
          constraint: 'ActivityRuleSnapshot_activityId_fkey',
        },
      );
      await expectRejected(
        snapshotSql('snapshot-no-template', {
          templateVersionId: 'no-such-template',
          workflowRevision: 2,
        }),
        {
          sqlState: '23503',
          constraint: 'ActivityRuleSnapshot_templateVersionId_fkey',
        },
      );
      await expectRejected(
        snapshotSql('snapshot-no-review', {
          createdByReviewId: 'no-such-review',
          workflowRevision: 3,
        }),
        {
          sqlState: '23503',
          constraint: 'ActivityRuleSnapshot_createdByReviewId_fkey',
        },
      );
    });

    it('同 activity + workflowRevision 只能生成一份快照', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-1'));
      const reviewId2 = await createReview(2);
      await expectRejected(
        snapshotSql('snapshot-same-revision', { createdByReviewId: reviewId2 }),
        {
          sqlState: '23505',
          key: 'Key ("activityId", "workflowRevision")',
        },
      );
    });
  });

  describe('🔴 §3.4 ActivityRuleSnapshot append-only trigger 四条判据', () => {
    it('[1/4] INSERT 放行', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-1'));
    });

    it('[2/4] UPDATE 被 trigger 拒(55000)', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-1'));
      await expectRejected(
        `UPDATE "ActivityRuleSnapshot" SET "snapshotHash" = 'tampered' WHERE id = 'snapshot-1'`,
        { sqlState: '55000', messageContains: 'activity rule snapshot is append-only' },
      );
    });

    it('[3/4] DELETE 被 trigger 拒(55000)', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-1'));
      await expectRejected(`DELETE FROM "ActivityRuleSnapshot" WHERE id = 'snapshot-1'`, {
        sqlState: '55000',
        messageContains: 'activity rule snapshot is append-only',
      });
    });

    it('[4/4] TRUNCATE 放行，且 trigger 清库后仍存活', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-1'));
      await resetDb(app);
      expect(await prisma.activityRuleSnapshot.count()).toBe(0);

      const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = '"ActivityRuleSnapshot"'::regclass
          AND NOT tgisinternal
        ORDER BY tgname
      `;
      expect(triggers).toEqual([{ tgname: 'trg_activity_rule_snapshot_10_append_only' }]);
    });
  });

  describe('§3.11 还债:ActivityAllocationBatch.ruleSnapshotId', () => {
    it('立正对照:NULL 的兼容批次与指向真实快照的批次都能写入', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-1'));
      await expectAccepted(batchSql('batch-null', null));
      await expectAccepted(batchSql('batch-snapshot', 'snapshot-1'));
    });

    it('不存在的 ruleSnapshotId 被真 FK 拒绝', async () => {
      await expectAccepted(templateSql('template-1'));
      await expectAccepted(snapshotSql('snapshot-1'));
      await expectRejected(batchSql('batch-no-snapshot', 'no-such-snapshot'), {
        sqlState: '23503',
        constraint: 'ActivityAllocationBatch_ruleSnapshotId_fkey',
      });
    });
  });

  describe('§10.3 第 3 批闭集动作的幂等列', () => {
    it('Activity 的取消／提前终止 hash 列可空，且每种 operationKey 都是单列 unique', async () => {
      const cols = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'Activity'
          AND column_name IN ('cancelOperationKey', 'cancelRequestHash',
                              'terminateOperationKey', 'terminateRequestHash')
        ORDER BY column_name
      `;
      expect(cols).toEqual([
        { column_name: 'cancelOperationKey', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'cancelRequestHash', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'terminateOperationKey', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'terminateRequestHash', data_type: 'text', is_nullable: 'YES' },
      ]);

      const activityId2 = await createActivity('idempotency-peer');
      await expectAccepted(
        `UPDATE "Activity" SET "cancelOperationKey" = 'cancel-a', "cancelRequestHash" = 'cancel-hash-a',
         "terminateOperationKey" = 'terminate-a', "terminateRequestHash" = 'terminate-hash-a'
         WHERE id = '${activityId}'`,
      );
      await expectAccepted(
        `UPDATE "Activity" SET "cancelOperationKey" = 'cancel-b', "cancelRequestHash" = 'cancel-hash-b',
         "terminateOperationKey" = 'terminate-b', "terminateRequestHash" = 'terminate-hash-b'
         WHERE id = '${activityId2}'`,
      );
      await expectRejected(
        `UPDATE "Activity" SET "cancelOperationKey" = 'cancel-a' WHERE id = '${activityId2}'`,
        { sqlState: '23505', key: 'Key ("cancelOperationKey")' },
      );
      await expectRejected(
        `UPDATE "Activity" SET "terminateOperationKey" = 'terminate-a' WHERE id = '${activityId2}'`,
        { sqlState: '23505', key: 'Key ("terminateOperationKey")' },
      );
    });

    it('同活动在已有提交完成审核后可以再次发布;同 submit / review operationKey 不能复用不同 payload', async () => {
      // reviewId 已占 requestVersion=1。既有 partial unique 只允许一条 pending，故先让
      // 首次提交完成审核，再证明同一活动可用另一 operationKey 发起下一次提交。
      await expectAccepted(
        publishReviewSql('publish-1', 2, {
          operationKey: 'publish-submit-a',
          requestHash: 'publish-hash-a',
        }),
      );
      await expectAccepted(
        `UPDATE "activity_publish_reviews"
         SET "status" = 'approved', "reviewOperationKey" = 'publish-review-a',
             "reviewRequestHash" = 'review-hash-a'
         WHERE id = 'publish-1'`,
      );
      await expectAccepted(
        publishReviewSql('publish-2', 3, {
          operationKey: 'publish-submit-b',
          requestHash: 'publish-hash-b',
        }),
      );
      await expectRejected(
        publishReviewSql('publish-dup-submit', 4, {
          status: 'approved',
          operationKey: 'publish-submit-a',
          requestHash: 'different-canonical-payload',
        }),
        { sqlState: '23505', key: 'Key ("operationKey")' },
      );
      await expectRejected(
        publishReviewSql('publish-dup-review', 5, {
          status: 'approved',
          operationKey: 'publish-submit-c',
          reviewOperationKey: 'publish-review-a',
          reviewRequestHash: 'different-canonical-payload',
        }),
        { sqlState: '23505', key: 'Key ("reviewOperationKey")' },
      );
    });

    it('ActivityPublishReview 的发布／审核 hash 列均为可空 TEXT，成功结果仍由本行 id 引用', async () => {
      const cols = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'activity_publish_reviews'
          AND column_name IN ('operationKey', 'requestHash', 'reviewOperationKey', 'reviewRequestHash')
        ORDER BY column_name
      `;
      expect(cols).toEqual([
        { column_name: 'operationKey', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'requestHash', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'reviewOperationKey', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'reviewRequestHash', data_type: 'text', is_nullable: 'YES' },
      ]);

      await expectAccepted(
        publishReviewSql('publish-reference', 2, {
          operationKey: 'publish-reference-key',
          requestHash: 'publish-reference-hash',
        }),
      );
      const rows = await prisma.$queryRaw<Array<{ id: string; operationKey: string | null }>>`
        SELECT id, "operationKey" FROM "activity_publish_reviews" WHERE id = 'publish-reference'
      `;
      expect(rows).toEqual([{ id: 'publish-reference', operationKey: 'publish-reference-key' }]);
    });
  });
});
