import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 活动改造 v1.1 —— 第 1 批第二刀(2026-08-04;第 72 migration
// `20260804040000_activity_v11_slice2_form_qualification_invitation`) + 第 4 批 Form
// 前置微刀 D-FORM-0(2026-08-07;第 79 migration
// `20260807183000_activity_v11_batch4_form_closed_sets`)。
// 合同:docs/archive/reviews/activity-business-overhaul-v1.1/
//       SRVF_活动业务全流程改造_详细开发文档_v1.1.md §3.6 / §3.7 / §3.12 / §3.13 / §3.14
//
// 本 spec 的**唯一**职责:证明 migration 里的每条 CHECK / unique / partial unique 在真实
// PostgreSQL 上**真的会拒**非法数据 —— 而不是"schema 文本里写了"。沿第一刀同一范式。
//
// 🔴 每条都**双向**断言(违规被拒 + 合法放行)。只断言"被拒"证明不了约束是对的:
// 一条 `CHECK (false)` 也能让所有违规用例全绿,却把合法写入一起拒掉。更阴的是列名写错 ——
// 合法行被外键/非空挡下时,每条"被拒"都成立却**毫无意义**。反向样例是唯一的分辨手段。
//
// 🔴 本刀 NULL 边界是重点。SQL 三值逻辑下 `NULL <比较>` = NULL,而 CHECK **只在结果为
// FALSE 时拒绝** ⇒ 表达式算出 NULL 时判通过,约束静默失效(第一刀真栽过一条)。
// 因此凡涉及可空列的 CHECK,这里都补一条「该列为 NULL」的用例,并明确它该拒还是该放。
//
// 走 $executeRawUnsafe 而非 Prisma model API:CHECK 与 partial unique 的 WHERE、
// NULLS NOT DISTINCT 都是 **DB 层**约束,Prisma client 不认识它们。
// Prisma 把原生语句的数据库错误包成 P2010,SQLSTATE 落在 `meta.code`
// (23505=unique / 23514=check / 23503=foreign key / 23502=not null)。

const T = (iso: string) => `'${iso}'::timestamp`;

// 全部 2099 —— 避免"硬编码历史日期 + 耦合墙钟"的定时炸弹(仓内已有事故案例)。
const SESSION_START = '2099-06-01T09:00:00.000Z';
const SESSION_END = '2099-06-01T17:00:00.000Z';
const CHECKIN_OPEN = '2099-06-01T08:00:00.000Z';
const CHECKIN_CLOSE = '2099-06-01T10:00:00.000Z';
const CHECKOUT_OPEN = '2099-06-01T16:00:00.000Z';
const CHECKOUT_CLOSE = '2099-06-01T18:00:00.000Z';
const EXPIRES_AT = '2099-06-01T12:00:00.000Z';
const NOW_ISO = '2099-05-01T00:00:00.000Z';

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

function sqlText(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNum(value: number | null): string {
  return value === null ? 'NULL' : String(value);
}

function sqlTime(value: string | null): string {
  return value === null ? 'NULL' : T(value);
}

describe('活动改造 v1.1 第 1 批第二刀 schema 约束(第 72 migration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let organizationId: string;
  let activityId: string;
  let memberId: string;
  let userId: string;
  let registrationId: string;
  let sessionId: string;
  let positionId: string;
  let identityId: string;
  let attachmentId: string;
  let draftFormVersionId: string;
  let revisionId: string;
  let ruleSetId: string;

  let seq = 0;
  const uniq = (label: string) => `v11s2-${label}-${(seq += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // 执行一条原生语句;成功返回 null,失败返回归一化的错误标识。
  // 刻意不 throw —— 调用点用返回值做断言,避免 expect().rejects 把"没抛"读成通过。
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

  // ⚠️ 两类错误能拿到的证据不一样(Prisma 6.19 实测,沿第一刀结论):
  // - CHECK(23514)/ FK(23503)/ NOT NULL(23502):meta.message 是 PG 主消息,
  //   含 `constraint "xxx"` ⇒ 可断言到**具体约束名**。
  // - UNIQUE(23505):meta.message 只有 PG 的 DETAIL 行,形如
  //   `Key ("activityId", "memberId", "sessionId")=(a1, m1, null) already exists.`,
  //   **不含约束名** ⇒ 改断言**键列签名**(本 schema 里覆盖该组键列的唯一索引只有一条,
  //   无歧义;partial 谓词由配套的"放行"用例反向锁死)。
  async function expectRejected(
    sql: string,
    expected: { sqlState: string; constraint?: string; key?: string },
  ): Promise<RawDbError> {
    const err = await run(sql);
    expect(err).not.toBeNull();
    expect(err!.sqlState).toBe(expected.sqlState);
    if (expected.constraint !== undefined) {
      expect(err!.constraint).toBe(expected.constraint);
    }
    if (expected.key !== undefined) {
      expect(err!.message).toContain(expected.key);
    }
    return err!;
  }

  async function expectAccepted(sql: string): Promise<void> {
    const err = await run(sql);
    expect(err).toBeNull();
  }

  beforeEach(async () => {
    await resetDb(app);

    organizationId = (
      await prisma.organization.create({
        data: { name: uniq('org'), nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;

    activityId = (
      await prisma.activity.create({
        data: {
          title: uniq('activity'),
          activityTypeCode: 'v11-slice2',
          organizationId,
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          location: 'constraint fixture',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;

    memberId = (
      await prisma.member.create({
        data: { memberNo: uniq('member'), displayName: 'V11 Slice2 Member' },
        select: { id: true },
      })
    ).id;

    userId = (
      await prisma.user.create({
        data: { username: uniq('user').toLowerCase(), passwordHash: 'x' },
        select: { id: true },
      })
    ).id;

    registrationId = (
      await prisma.activityRegistration.create({
        data: { activityId, memberId, statusCode: 'pending' },
        select: { id: true },
      })
    ).id;

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

    positionId = (
      await prisma.activitySessionPosition.create({
        data: {
          activityId,
          sessionId,
          code: uniq('position'),
          name: uniq('position'),
          attendanceRoleCode: 'volunteer',
        },
        select: { id: true },
      })
    ).id;

    identityId = (
      await prisma.activityParticipationIdentity.create({
        data: { activityId, sessionId, registrationId, memberId, currentStatusCode: 'pending' },
        select: { id: true },
      })
    ).id;

    attachmentId = (
      await prisma.attachment.create({
        data: {
          key: uniq('attachment-key'),
          originalName: 'answer.png',
          mime: 'image/png',
          size: 10,
          uploadedBy: userId,
          ownerType: 'activity',
          ownerId: activityId,
        },
        select: { id: true },
      })
    ).id;

    draftFormVersionId = (
      await prisma.registrationFormVersion.create({
        data: { activityId, version: 1, statusCode: 'draft' },
        select: { id: true },
      })
    ).id;

    revisionId = (
      await prisma.activityRegistrationRevision.create({
        data: {
          registrationId,
          revision: 1,
          formVersionId: draftFormVersionId,
          sourceCode: 'self',
          submittedAt: new Date(NOW_ISO),
        },
        select: { id: true },
      })
    ).id;

    ruleSetId = (
      await prisma.activityQualificationRuleSet.create({
        data: { activityId, version: 1, statusCode: 'draft' },
        select: { id: true },
      })
    ).id;
  });

  // 建一道题并返回 id;题型/边界可覆写。用 Prisma model API 建**合法**行,
  // 让"夹具本身能落库"成为后续每条断言的前提(列名写错会在这里就炸,而不是
  // 悄悄让每条"被拒"都变得毫无意义)。
  async function makeField(
    overrides: Partial<{
      typeCode: string;
      visibilityCode: string;
      minValue: number | null;
      maxValue: number | null;
      minLength: number | null;
      maxLength: number | null;
      maxSelections: number | null;
    }> = {},
  ): Promise<string> {
    const code = uniq('field');
    return (
      await prisma.registrationFormField.create({
        data: {
          formVersionId: draftFormVersionId,
          fieldCode: code,
          label: code,
          typeCode: overrides.typeCode ?? 'short_text',
          visibilityCode: overrides.visibilityCode ?? 'self_only',
          minValue: overrides.minValue ?? null,
          maxValue: overrides.maxValue ?? null,
          minLength: overrides.minLength ?? null,
          maxLength: overrides.maxLength ?? null,
          maxSelections: overrides.maxSelections ?? null,
        },
        select: { id: true },
      })
    ).id;
  }

  // ==========================================================================
  // ① 既有表 ActivityRegistration 的新增列(§3.6)
  //
  // 用 UPDATE 打:fixture 行已存在,UPDATE 能精确隔离出"是这一列被拒",
  // 不被 INSERT 缺列之类的无关错误污染。
  // ==========================================================================

  describe('§3.6 ActivityRegistration 新增四列', () => {
    const upd = (setClause: string) =>
      `UPDATE "ActivityRegistration" SET ${setClause} WHERE "id" = ${sqlText(registrationId)}`;

    it('currentRevision 为负被拒;0 与正数放行(NOT NULL DEFAULT 0 ⇒ 无 NULL 边界)', async () => {
      await expectRejected(upd(`"currentRevision" = -1`), {
        sqlState: '23514',
        constraint: 'activity_registration_current_revision_non_negative_check',
      });
      await expectAccepted(upd(`"currentRevision" = 0`));
      await expectAccepted(upd(`"currentRevision" = 7`));
    });

    it('statusSummaryCode 闭集外被拒;五个合法值与 NULL 放行', async () => {
      await expectRejected(upd(`"statusSummaryCode" = 'partial'`), {
        sqlState: '23514',
        constraint: 'activity_registration_status_summary_code_check',
      });
      for (const code of ['active', 'completed', 'cancelled', 'not_selected', 'expired']) {
        await expectAccepted(upd(`"statusSummaryCode" = ${sqlText(code)}`));
      }
      // ★NULL 边界:本列可空(NULL = 尚未聚合,也是全部存量行的形态)⇒ 必须放行。
      await expectAccepted(upd(`"statusSummaryCode" = NULL`));
    });

    it('sourceCode 闭集外被拒;四个合法值与 NULL 放行', async () => {
      await expectRejected(upd(`"sourceCode" = 'import'`), {
        sqlState: '23514',
        constraint: 'activity_registration_source_code_check',
      });
      for (const code of ['self', 'admin', 'invitation', 'onsite']) {
        await expectAccepted(upd(`"sourceCode" = ${sqlText(code)}`));
      }
      await expectAccepted(upd(`"sourceCode" = NULL`));
    });

    it('currentFormVersionId 外键真的在:指向不存在的版本被拒,指向真版本与 NULL 放行', async () => {
      await expectRejected(upd(`"currentFormVersionId" = 'NO-SUCH-FORM-VERSION'`), {
        sqlState: '23503',
        constraint: 'ActivityRegistration_currentFormVersionId_fkey',
      });
      await expectAccepted(upd(`"currentFormVersionId" = ${sqlText(draftFormVersionId)}`));
      await expectAccepted(upd(`"currentFormVersionId" = NULL`));
    });

    it('存量行在新 CHECK 下恒真:什么都不改的全表 UPDATE 放行(零回填自证)', async () => {
      await expectAccepted(`UPDATE "ActivityRegistration" SET "statusCode" = "statusCode"`);
    });
  });

  // ==========================================================================
  // ② 兑现第一刀欠账:ActivitySessionPosition.qualificationRuleSetId + FK(§3.3)
  // ==========================================================================

  describe('§3.3 ActivitySessionPosition.qualificationRuleSetId(第一刀欠账)', () => {
    const upd = (setClause: string) =>
      `UPDATE "ActivitySessionPosition" SET ${setClause} WHERE "id" = ${sqlText(positionId)}`;

    it('列存在且带 FK:指向真规则集放行,指向不存在的被拒,NULL 放行', async () => {
      await expectAccepted(upd(`"qualificationRuleSetId" = ${sqlText(ruleSetId)}`));
      await expectRejected(upd(`"qualificationRuleSetId" = 'NO-SUCH-RULE-SET'`), {
        sqlState: '23503',
        constraint: 'ActivitySessionPosition_qualificationRuleSetId_fkey',
      });
      // 可空 = 岗位不追加岗位级资格时继承场次/活动级规则集(§3.3「可空岗位资格版本」)
      await expectAccepted(upd(`"qualificationRuleSetId" = NULL`));
    });
  });

  // ==========================================================================
  // ③ RegistrationFormVersion(§3.12)
  // ==========================================================================

  describe('§3.12 RegistrationFormVersion', () => {
    const insertVersion = (
      version: number,
      statusCode: string,
      activatedAt: string | null = null,
      retiredAt: string | null = null,
    ) =>
      `INSERT INTO "RegistrationFormVersion"
        ("id","activityId","version","statusCode","activatedAt","retiredAt","updatedAt")
       VALUES (${sqlText(uniq('fv'))},${sqlText(activityId)},${sqlNum(version)},
        ${sqlText(statusCode)},${sqlTime(activatedAt)},${sqlTime(retiredAt)},now())`;

    it('statusCode 闭集外被拒;draft / active / retired 放行', async () => {
      await expectRejected(insertVersion(10, 'archived'), {
        sqlState: '23514',
        constraint: 'registration_form_version_status_code_check',
      });
      await expectAccepted(insertVersion(11, 'draft'));
      await expectAccepted(insertVersion(12, 'active', NOW_ISO));
      await expectAccepted(insertVersion(13, 'retired', NOW_ISO, NOW_ISO));
    });

    it('version=0 被拒;1 放行(fixture 已占 1,这里用 UPDATE 验边界)', async () => {
      await expectRejected(insertVersion(0, 'draft'), {
        sqlState: '23514',
        constraint: 'registration_form_version_number_check',
      });
      await expectAccepted(insertVersion(1000, 'draft'));
    });

    it('生命周期形状:draft 带 activatedAt 被拒、active 带 retiredAt 被拒;弃稿(未激活直接退役)放行', async () => {
      await expectRejected(insertVersion(20, 'draft', NOW_ISO), {
        sqlState: '23514',
        constraint: 'registration_form_version_lifecycle_shape_check',
      });
      await expectRejected(insertVersion(21, 'active', null, NOW_ISO), {
        sqlState: '23514',
        constraint: 'registration_form_version_lifecycle_shape_check',
      });
      // ★NULL 边界(单向蕴含,不是双向):
      // - retired 但 retiredAt 为 NULL → 放行(合同只要求"有值时必须是 retired")
      // - active 但 activatedAt 为 NULL → 放行(尚未回填时刻)
      await expectAccepted(insertVersion(22, 'retired', null, null));
      await expectAccepted(insertVersion(23, 'active', null, null));
      // 弃稿:从未激活直接退役
      await expectAccepted(insertVersion(24, 'retired', null, NOW_ISO));
    });

    it('(activityId, version) 重复被拒;不同 version 放行', async () => {
      await expectAccepted(insertVersion(30, 'draft'));
      await expectRejected(insertVersion(30, 'draft'), {
        sqlState: '23505',
        key: 'activityId',
      });
      await expectAccepted(insertVersion(31, 'draft'));
    });

    it('一活动至多一个 active:第二条 active 被拒;第二条 draft / retired 放行', async () => {
      await expectAccepted(insertVersion(40, 'active', NOW_ISO));
      await expectRejected(insertVersion(41, 'active', NOW_ISO), {
        sqlState: '23505',
        key: 'activityId',
      });
      // partial 谓词的反向锁:draft / retired 必须能有多条,否则连第二版草稿都建不出来。
      await expectAccepted(insertVersion(42, 'draft'));
      await expectAccepted(insertVersion(43, 'draft'));
      await expectAccepted(insertVersion(44, 'retired', NOW_ISO, NOW_ISO));
      await expectAccepted(insertVersion(45, 'retired', NOW_ISO, NOW_ISO));
    });
  });

  // ==========================================================================
  // ④ RegistrationFormField(§3.12)—— DoD 5「范围/长度类列两两成对时的空值组合」
  // ==========================================================================

  describe('§3.12 RegistrationFormField', () => {
    const insertField = (cols: {
      typeCode?: string;
      visibilityCode?: string;
      minValue?: number | null;
      maxValue?: number | null;
      minLength?: number | null;
      maxLength?: number | null;
      maxSelections?: number | null;
    }) => {
      const code = uniq('fd');
      return `INSERT INTO "RegistrationFormField"
        ("id","formVersionId","fieldCode","label","typeCode","visibilityCode",
         "minValue","maxValue","minLength","maxLength","maxSelections","updatedAt")
       VALUES (${sqlText(code)},${sqlText(draftFormVersionId)},${sqlText(code)},${sqlText(code)},
        ${sqlText(cols.typeCode ?? 'short_text')},${sqlText(cols.visibilityCode ?? 'self_only')},
        ${sqlNum(cols.minValue ?? null)},${sqlNum(cols.maxValue ?? null)},
        ${sqlNum(cols.minLength ?? null)},${sqlNum(cols.maxLength ?? null)},
        ${sqlNum(cols.maxSelections ?? null)},now())`;
    };

    it('typeCode 闭集外被拒;八种合同题型全部放行', async () => {
      await expectRejected(insertField({ typeCode: 'rich_text' }), {
        sqlState: '23514',
        constraint: 'registration_form_field_type_code_check',
      });
      for (const typeCode of [
        'short_text',
        'long_text',
        'number',
        'date',
        'single_choice',
        'multi_choice',
        'file',
        'confirmation',
      ]) {
        await expectAccepted(insertField({ typeCode }));
      }
    });

    it('第 79 migration:visibilityCode 闭集外被拒;冻结三值全部放行', async () => {
      await expectRejected(insertField({ visibilityCode: 'internal' }), {
        sqlState: '23514',
        constraint: 'registration_form_field_visibility_code_check',
      });
      for (const visibilityCode of ['self_and_registration_staff', 'self_and_owner', 'self_only']) {
        await expectAccepted(insertField({ visibilityCode }));
      }
    });

    it('minValue > maxValue 被拒;★单边(任一为 NULL)与双边为 NULL 全部放行', async () => {
      await expectRejected(insertField({ minValue: 100, maxValue: 1 }), {
        sqlState: '23514',
        constraint: 'registration_form_field_value_range_check',
      });
      await expectAccepted(insertField({ minValue: 1, maxValue: 100 }));
      await expectAccepted(insertField({ minValue: 5, maxValue: 5 })); // 边界相等
      // ★NULL 边界:开区间是合法设计 ⇒ 这三种必须放行。
      // 这也正是不能把本条写成裸 `minValue <= maxValue` 的原因:那样写虽然同样
      // "放行"它们,却是靠整式塌成 NULL 蒙混过关,而非真的判为合法。
      await expectAccepted(insertField({ minValue: 1, maxValue: null }));
      await expectAccepted(insertField({ minValue: null, maxValue: 100 }));
      await expectAccepted(insertField({ minValue: null, maxValue: null }));
    });

    it('★NULL 边界要害:搭档列为 NULL 时长度约束仍然生效(minLength=-1 / maxLength=0 都被拒)', async () => {
      // 这两条是本 spec 里最关键的 NULL 用例:如果 length CHECK 写成裸的
      // `minLength <= maxLength`,搭档为 NULL 时整式 = NULL ⇒ CHECK 判通过,
      // 下面两条会**静默入库**,而"两边都有值且反序"的用例照样红 —— 错误写法在
      // 测试里也会全绿。唯有这两条能把两种写法分开。
      await expectRejected(insertField({ minLength: -1, maxLength: null }), {
        sqlState: '23514',
        constraint: 'registration_form_field_length_range_check',
      });
      await expectRejected(insertField({ minLength: null, maxLength: 0 }), {
        sqlState: '23514',
        constraint: 'registration_form_field_length_range_check',
      });
      await expectRejected(insertField({ minLength: 5, maxLength: 2 }), {
        sqlState: '23514',
        constraint: 'registration_form_field_length_range_check',
      });
      // 反向:合法的单边与边界值必须放行。
      await expectAccepted(insertField({ minLength: 0, maxLength: 10 }));
      await expectAccepted(insertField({ minLength: 3, maxLength: null }));
      await expectAccepted(insertField({ minLength: null, maxLength: 1 }));
      await expectAccepted(insertField({ minLength: 4, maxLength: 4 }));
      await expectAccepted(insertField({ minLength: null, maxLength: null }));
    });

    it('maxSelections=0 被拒;1 与 NULL(不限)放行', async () => {
      await expectRejected(insertField({ typeCode: 'multi_choice', maxSelections: 0 }), {
        sqlState: '23514',
        constraint: 'registration_form_field_max_selections_check',
      });
      await expectAccepted(insertField({ typeCode: 'multi_choice', maxSelections: 1 }));
      await expectAccepted(insertField({ typeCode: 'multi_choice', maxSelections: null }));
    });

    it('(formVersionId, fieldCode) 重复被拒;不同 fieldCode 放行', async () => {
      const fieldCode = uniq('dupcode');
      const insertWithCode = (id: string) =>
        `INSERT INTO "RegistrationFormField"
          ("id","formVersionId","fieldCode","label","typeCode","visibilityCode","updatedAt")
         VALUES (${sqlText(id)},${sqlText(draftFormVersionId)},${sqlText(fieldCode)},'x','short_text','self_only',now())`;
      await expectAccepted(insertWithCode(uniq('f')));
      await expectRejected(insertWithCode(uniq('f')), { sqlState: '23505', key: 'formVersionId' });
    });
  });

  // ==========================================================================
  // ⑤ RegistrationFormAnswer exactly-one(§3.12)—— 本刀最高风险项
  // ==========================================================================

  describe('§3.12 RegistrationFormAnswer exactly-one CHECK', () => {
    // 计数式写法(CASE WHEN … IS NOT NULL THEN 1 ELSE 0 END 求和 = 1)在**结构上**
    // 不可能求值成 NULL:IS NOT NULL 是二值谓词,和恒为 0..5 的非 NULL 整数。
    // 下面的「零个非空」用例就是这一点的直接判据 —— 五列全 NULL 仍被拒,
    // 说明约束在"全空"这一最容易塌成 NULL 的形态上照样做功。
    const insertAnswer = (
      fieldId: string,
      values: {
        valueText?: string | null;
        valueNumber?: number | null;
        valueDate?: string | null;
        valueJson?: string | null;
        attachmentId?: string | null;
      },
    ) =>
      `INSERT INTO "RegistrationFormAnswer"
        ("id","registrationRevisionId","fieldId","valueText","valueNumber","valueDate","valueJson","attachmentId")
       VALUES (${sqlText(uniq('ans'))},${sqlText(revisionId)},${sqlText(fieldId)},
        ${sqlText(values.valueText ?? null)},${sqlNum(values.valueNumber ?? null)},
        ${sqlTime(values.valueDate ?? null)},
        ${values.valueJson == null ? 'NULL' : `${sqlText(values.valueJson)}::jsonb`},
        ${sqlText(values.attachmentId ?? null)})`;

    it('★【零个非空】五列全 NULL 被拒', async () => {
      const fieldId = await makeField();
      await expectRejected(insertAnswer(fieldId, {}), {
        sqlState: '23514',
        constraint: 'registration_form_answer_exactly_one_value_check',
      });
    });

    it('★【两个非空】三种不同的两两组合全部被拒', async () => {
      const f1 = await makeField();
      const f2 = await makeField();
      const f3 = await makeField();
      await expectRejected(insertAnswer(f1, { valueText: 't', valueNumber: 1 }), {
        sqlState: '23514',
        constraint: 'registration_form_answer_exactly_one_value_check',
      });
      await expectRejected(insertAnswer(f2, { valueJson: '{"a":1}', attachmentId }), {
        sqlState: '23514',
        constraint: 'registration_form_answer_exactly_one_value_check',
      });
      await expectRejected(insertAnswer(f3, { valueDate: NOW_ISO, valueText: 't' }), {
        sqlState: '23514',
        constraint: 'registration_form_answer_exactly_one_value_check',
      });
    });

    it('【五个全非空】被拒', async () => {
      const fieldId = await makeField();
      await expectRejected(
        insertAnswer(fieldId, {
          valueText: 't',
          valueNumber: 1,
          valueDate: NOW_ISO,
          valueJson: '{"a":1}',
          attachmentId,
        }),
        { sqlState: '23514', constraint: 'registration_form_answer_exactly_one_value_check' },
      );
    });

    it('每种合法单值各一条全部放行(五个正对照)', async () => {
      await expectAccepted(insertAnswer(await makeField(), { valueText: '答案文本' }));
      await expectAccepted(insertAnswer(await makeField(), { valueNumber: 42.5 }));
      await expectAccepted(insertAnswer(await makeField(), { valueDate: NOW_ISO }));
      await expectAccepted(insertAnswer(await makeField(), { valueJson: '{"a":1}' }));
      await expectAccepted(insertAnswer(await makeField(), { attachmentId }));
    });

    it('(registrationRevisionId, fieldId) 重复被拒;换一道题放行', async () => {
      const fieldId = await makeField();
      await expectAccepted(insertAnswer(fieldId, { valueText: 'first' }));
      await expectRejected(insertAnswer(fieldId, { valueText: 'second' }), {
        sqlState: '23505',
        key: 'registrationRevisionId',
      });
      await expectAccepted(insertAnswer(await makeField(), { valueText: 'other field' }));
    });

    it('attachmentId 外键真的在:指向不存在的附件被拒', async () => {
      const fieldId = await makeField();
      await expectRejected(insertAnswer(fieldId, { attachmentId: 'NO-SUCH-ATTACHMENT' }), {
        sqlState: '23503',
        constraint: 'RegistrationFormAnswer_attachmentId_fkey',
      });
    });
  });

  // ==========================================================================
  // ⑥ ActivityRegistrationRevision(§3.7)
  // ==========================================================================

  describe('§3.7 ActivityRegistrationRevision', () => {
    const insertRevision = (cols: {
      revision: number;
      sourceCode?: string;
      formVersionId?: string | null;
      submittedByUserId?: string | null;
      requestKey?: string | null;
      requestHash?: string | null;
    }) =>
      `INSERT INTO "ActivityRegistrationRevision"
        ("id","registrationId","revision","formVersionId","sourceCode","submittedByUserId",
         "submittedAt","requestKey","requestHash")
       VALUES (${sqlText(uniq('rev'))},${sqlText(registrationId)},${sqlNum(cols.revision)},
        ${sqlText(cols.formVersionId ?? null)},${sqlText(cols.sourceCode ?? 'self')},
        ${sqlText(cols.submittedByUserId ?? null)},${T(NOW_ISO)},
        ${sqlText(cols.requestKey ?? null)},${sqlText(cols.requestHash ?? null)})`;

    it('revision 为负被拒;0 与正数放行', async () => {
      await expectRejected(insertRevision({ revision: -1 }), {
        sqlState: '23514',
        constraint: 'activity_registration_revision_number_check',
      });
      await expectAccepted(insertRevision({ revision: 0 }));
      await expectAccepted(insertRevision({ revision: 2 }));
    });

    it('sourceCode 闭集外被拒;四个合法值放行(本列 NOT NULL,不放行 NULL)', async () => {
      await expectRejected(insertRevision({ revision: 3, sourceCode: 'import' }), {
        sqlState: '23514',
        constraint: 'activity_registration_revision_source_code_check',
      });
      let n = 10;
      for (const sourceCode of ['self', 'admin', 'invitation', 'onsite']) {
        await expectAccepted(insertRevision({ revision: (n += 1), sourceCode }));
      }
    });

    it('formVersionId / submittedByUserId 可空是真可空(活动无自定义报名表 + 系统代建)', async () => {
      await expectAccepted(
        insertRevision({ revision: 20, formVersionId: null, submittedByUserId: null }),
      );
      await expectAccepted(
        insertRevision({
          revision: 21,
          formVersionId: draftFormVersionId,
          submittedByUserId: userId,
        }),
      );
    });

    it('(registrationId, revision) 重复被拒', async () => {
      await expectAccepted(insertRevision({ revision: 30 }));
      await expectRejected(insertRevision({ revision: 30 }), {
        sqlState: '23505',
        key: 'registrationId',
      });
    });

    it('requestKey 幂等唯一:同 key 被拒(即便 hash 不同);★多条 NULL key 放行', async () => {
      await expectAccepted(insertRevision({ revision: 40, requestKey: 'rk-1', requestHash: 'h1' }));
      // 同 key 配**不同** payload —— 正是幂等键要拦的冲突。键取 requestKey 单列
      // (而非 (requestKey, requestHash) 复合)才拦得住;复合会放行这条。
      await expectRejected(
        insertRevision({ revision: 41, requestKey: 'rk-1', requestHash: 'DIFFERENT' }),
        { sqlState: '23505', key: 'requestKey' },
      );
      await expectAccepted(insertRevision({ revision: 42, requestKey: 'rk-2', requestHash: 'h2' }));
      // ★NULL 边界:partial 谓词 WHERE requestKey IS NOT NULL ⇒ 无 key 的写入不参与去重。
      await expectAccepted(insertRevision({ revision: 43, requestKey: null }));
      await expectAccepted(insertRevision({ revision: 44, requestKey: null }));
    });
  });

  // ==========================================================================
  // ⑦ RegistrationUploadSession(§3.12)
  // ==========================================================================

  describe('§3.12 RegistrationUploadSession', () => {
    const insertSession = (cols: {
      id?: string;
      tokenHash?: string;
      expiresAt?: string | null;
      consumedAt?: string | null;
      statusCode?: string;
    }) =>
      `INSERT INTO "RegistrationUploadSession"
        ("id","activityId","memberId","formVersionId","tokenHash","expiresAt","consumedAt","statusCode","updatedAt")
       VALUES (${sqlText(cols.id ?? uniq('ups'))},${sqlText(activityId)},${sqlText(memberId)},
        ${sqlText(draftFormVersionId)},${sqlText(cols.tokenHash ?? uniq('hash'))},
        ${sqlTime(cols.expiresAt === undefined ? EXPIRES_AT : cols.expiresAt)},
        ${sqlTime(cols.consumedAt ?? null)},${sqlText(cols.statusCode ?? 'active')},now())`;

    it('expiresAt 必填:缺失被拒(23502 非空,不是 CHECK —— CHECK 对 NULL 判通过,表达不了必填)', async () => {
      await expectRejected(insertSession({ expiresAt: null }), { sqlState: '23502' });
      await expectAccepted(insertSession({}));
    });

    it('第 72 migration 的既有单向 consumedAt 守卫仍在:非 consumed 带 consumedAt 被拒', async () => {
      await expectRejected(insertSession({ consumedAt: NOW_ISO, statusCode: 'active' }), {
        sqlState: '23514',
        constraint: 'registration_upload_session_consumed_shape_check',
      });
      await expectAccepted(insertSession({ consumedAt: NOW_ISO, statusCode: 'consumed' }));
    });

    it('第 79 migration:statusCode 闭集与 consumedAt 双向生命周期', async () => {
      // statusCode 闭集先关未知值;expiresAt 过期由读取时派生,不是持久化状态。
      await expectRejected(insertSession({ statusCode: 'expired', consumedAt: null }), {
        sqlState: '23514',
        constraint: 'registration_upload_session_status_code_check',
      });
      // 生命周期的反向半边只能由第 79 migration 新 CHECK 拦住:第 72 migration 的
      // 单向约束对 consumed/null 不做功。
      await expectRejected(insertSession({ statusCode: 'consumed', consumedAt: null }), {
        sqlState: '23514',
        constraint: 'registration_upload_session_lifecycle_shape_check',
      });
      // 两个非 consumed 状态带 consumedAt 都必须拒;第 72 的既有单向 CHECK 与新
      // 生命周期 CHECK 都会拦,故这里仅断言 SQLSTATE,不把裁决绑定到任一重叠约束。
      await expectRejected(insertSession({ statusCode: 'active', consumedAt: NOW_ISO }), {
        sqlState: '23514',
      });
      await expectRejected(insertSession({ statusCode: 'revoked', consumedAt: NOW_ISO }), {
        sqlState: '23514',
      });

      await expectAccepted(insertSession({ statusCode: 'active', consumedAt: null }));
      await expectAccepted(insertSession({ statusCode: 'revoked', consumedAt: null }));
      await expectAccepted(insertSession({ statusCode: 'consumed', consumedAt: NOW_ISO }));
    });

    it('tokenHash 全局唯一:重复被拒', async () => {
      await expectAccepted(insertSession({ tokenHash: 'sha256-fixed' }));
      await expectRejected(insertSession({ tokenHash: 'sha256-fixed' }), {
        sqlState: '23505',
        key: 'tokenHash',
      });
    });
  });

  // ==========================================================================
  // 第 79 migration —— 报名上传会话的附件归属与数据库结构
  // ==========================================================================

  describe('第 79 migration Form closed sets', () => {
    const insertAttachment = (ownerId: string, ownerType: string) =>
      `INSERT INTO "attachments"
        ("id","updatedAt","key","originalName","mime","size","uploadedBy","ownerType","ownerId")
       VALUES (${sqlText(uniq('upload-attachment'))},now(),${sqlText(uniq('upload-key'))},
        'form-upload.png','image/png',10,${sqlText(userId)},${sqlText(ownerType)},${sqlText(ownerId)})`;

    async function makeUploadSession(): Promise<string> {
      return (
        await prisma.registrationUploadSession.create({
          data: {
            activityId,
            memberId,
            formVersionId: draftFormVersionId,
            tokenHash: uniq('upload-token-hash'),
            expiresAt: new Date(EXPIRES_AT),
            statusCode: 'active',
          },
          select: { id: true },
        })
      ).id;
    }

    it('同一上传会话首附件放行、第二附件拒绝;不同会话与其它 ownerType 均可多附件', async () => {
      const firstSessionId = await makeUploadSession();
      const secondSessionId = await makeUploadSession();

      await expectAccepted(insertAttachment(firstSessionId, 'registration-upload-session'));
      await expectRejected(insertAttachment(firstSessionId, 'registration-upload-session'), {
        sqlState: '23505',
        key: 'Key ("ownerId")',
      });
      await expectAccepted(insertAttachment(secondSessionId, 'registration-upload-session'));

      // partial 谓词必须严格限于 registration-upload-session:现有 activity 附件与
      // 后续新增的两条仍都能共享同一个 ownerId。
      await expectAccepted(insertAttachment(activityId, 'activity'));
      await expectAccepted(insertAttachment(activityId, 'activity'));
    });

    it('pg 结构精确命中第 79 migration 的三条 CHECK 与 partial unique', async () => {
      const checks = await prisma.$queryRaw<Array<{ conname: string; definition: string }>>`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE contype = 'c'
          AND conname IN (
            'registration_form_field_visibility_code_check',
            'registration_upload_session_status_code_check',
            'registration_upload_session_lifecycle_shape_check'
          )
        ORDER BY conname
      `;
      expect(checks.map((check) => check.conname)).toEqual([
        'registration_form_field_visibility_code_check',
        'registration_upload_session_lifecycle_shape_check',
        'registration_upload_session_status_code_check',
      ]);

      const checkDefs = new Map(checks.map((check) => [check.conname, check.definition]));
      expect(checkDefs.get('registration_form_field_visibility_code_check')).toContain(
        'self_and_registration_staff',
      );
      expect(checkDefs.get('registration_form_field_visibility_code_check')).toContain(
        'self_and_owner',
      );
      expect(checkDefs.get('registration_form_field_visibility_code_check')).toContain('self_only');
      expect(checkDefs.get('registration_upload_session_status_code_check')).toContain("'active'");
      expect(checkDefs.get('registration_upload_session_status_code_check')).toContain(
        "'consumed'",
      );
      expect(checkDefs.get('registration_upload_session_status_code_check')).toContain("'revoked'");
      expect(checkDefs.get('registration_upload_session_lifecycle_shape_check')).toContain(
        '"consumedAt" IS NOT NULL',
      );
      expect(checkDefs.get('registration_upload_session_lifecycle_shape_check')).toContain(
        '"statusCode"',
      );

      const indexes = await prisma.$queryRaw<
        Array<{
          indexName: string;
          isUnique: boolean;
          keyColumns: string[];
          predicate: string | null;
        }>
      >`
        SELECT index_class.relname AS "indexName",
               index_meta.indisunique AS "isUnique",
               ARRAY(
                 SELECT attribute.attname
                 FROM unnest(index_meta.indkey) WITH ORDINALITY AS key_column(attnum, ordinal)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = index_meta.indrelid
                  AND attribute.attnum = key_column.attnum
                 ORDER BY key_column.ordinal
               ) AS "keyColumns",
               pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
        FROM pg_index index_meta
        JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
        WHERE index_meta.indrelid = 'attachments'::regclass
          AND index_class.relname = 'attachments_registration_upload_session_owner_unique'
      `;
      expect(indexes).toEqual([
        {
          indexName: 'attachments_registration_upload_session_owner_unique',
          isUnique: true,
          keyColumns: ['ownerId'],
          predicate: `("ownerType" = 'registration-upload-session'::text)`,
        },
      ]);
    });
  });

  // ==========================================================================
  // ⑧ 资格规则与评估快照(§3.13)
  // ==========================================================================

  describe('§3.13 Qualification 三表', () => {
    it('RuleSet version=0 被拒;1 放行;三级作用域(活动/场次/岗位)全部放行', async () => {
      const insertRuleSet = (version: number, session: string | null, position: string | null) =>
        `INSERT INTO "ActivityQualificationRuleSet"
          ("id","activityId","sessionId","positionId","version","statusCode","updatedAt")
         VALUES (${sqlText(uniq('rs'))},${sqlText(activityId)},${sqlText(session)},
          ${sqlText(position)},${sqlNum(version)},'draft',now())`;
      await expectRejected(insertRuleSet(0, null, null), {
        sqlState: '23514',
        constraint: 'activity_qualification_rule_set_version_check',
      });
      // ★NULL 边界:sessionId 为 NULL 时复合外键 (activityId, sessionId) 按
      // PostgreSQL MATCH SIMPLE **不校验** —— 这正是"活动级规则集"要的行为。
      await expectAccepted(insertRuleSet(2, null, null));
      await expectAccepted(insertRuleSet(3, sessionId, null));
      await expectAccepted(insertRuleSet(4, sessionId, positionId));
    });

    it('RuleSet 场次锚点仍受复合外键约束:sessionId 有值但不属于该活动 → 被拒', async () => {
      const otherActivity = await prisma.activity.create({
        data: {
          title: uniq('other-activity'),
          activityTypeCode: 'v11-slice2',
          organizationId,
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          location: 'other',
          statusCode: 'draft',
        },
        select: { id: true },
      });
      // 用别的活动的 id 配本活动的 session ⇒ (activityId, sessionId) 组合不存在。
      await expectRejected(
        `INSERT INTO "ActivityQualificationRuleSet"
          ("id","activityId","sessionId","version","statusCode","updatedAt")
         VALUES (${sqlText(uniq('rs'))},${sqlText(otherActivity.id)},${sqlText(sessionId)},1,'draft',now())`,
        { sqlState: '23503', constraint: 'ActivityQualificationRuleSet_activityId_sessionId_fkey' },
      );
    });

    it('enforcementCode 闭集外被拒;block / warn 放行', async () => {
      const insertRule = (ruleTypeCode: string, enforcementCode: string) =>
        `INSERT INTO "ActivityQualificationRule"
          ("id","ruleSetId","ruleTypeCode","enforcementCode","operator","updatedAt")
         VALUES (${sqlText(uniq('ru'))},${sqlText(ruleSetId)},${sqlText(ruleTypeCode)},
          ${sqlText(enforcementCode)},'eq',now())`;
      await expectRejected(insertRule('grade', 'info'), {
        sqlState: '23514',
        constraint: 'activity_qualification_rule_enforcement_code_check',
      });
      await expectAccepted(insertRule('grade', 'block'));
      await expectAccepted(insertRule('grade', 'warn'));
    });

    it('ruleTypeCode 闭集外被拒;合同七种全部放行', async () => {
      const insertRule = (ruleTypeCode: string) =>
        `INSERT INTO "ActivityQualificationRule"
          ("id","ruleSetId","ruleTypeCode","enforcementCode","operator","updatedAt")
         VALUES (${sqlText(uniq('ru'))},${sqlText(ruleSetId)},${sqlText(ruleTypeCode)},'block','eq',now())`;
      await expectRejected(insertRule('blood_type'), {
        sqlState: '23514',
        constraint: 'activity_qualification_rule_type_code_check',
      });
      for (const code of [
        'grade',
        'organization',
        'certificate',
        'age',
        'training',
        'gender',
        'insurance',
      ]) {
        await expectAccepted(insertRule(code));
      }
    });

    it('Snapshot resultCode 闭集外被拒;pass / warn / fail 放行', async () => {
      const insertSnapshot = (resultCode: string) =>
        `INSERT INTO "QualificationEvaluationSnapshot"
          ("id","ruleSetVersionId","evaluatedAt","resultCode")
         VALUES (${sqlText(uniq('sn'))},${sqlText(ruleSetId)},${T(NOW_ISO)},${sqlText(resultCode)})`;
      await expectRejected(insertSnapshot('unknown'), {
        sqlState: '23514',
        constraint: 'qualification_evaluation_snapshot_result_code_check',
      });
      for (const code of ['pass', 'warn', 'fail']) {
        await expectAccepted(insertSnapshot(code));
      }
    });

    it('★Snapshot 展示态:identityId 与 registrationRevisionId 双双为 NULL 必须放行(§3.13「展示、提交、审核三次评估」)', async () => {
      const insertSnapshot = (identity: string | null, revision: string | null) =>
        `INSERT INTO "QualificationEvaluationSnapshot"
          ("id","identityId","registrationRevisionId","ruleSetVersionId","evaluatedAt","resultCode")
         VALUES (${sqlText(uniq('sn'))},${sqlText(identity)},${sqlText(revision)},
          ${sqlText(ruleSetId)},${T(NOW_ISO)},'pass')`;
      // 展示评估发生在报名之前 —— 那一刻两个锚点都不存在。若两列 NOT NULL,
      // 这条合同明写的形态根本写不进来。
      await expectAccepted(insertSnapshot(null, null));
      await expectAccepted(insertSnapshot(null, revisionId));
      await expectAccepted(insertSnapshot(identityId, revisionId));
      // 但有值时外键仍然生效,不是"可空 = 不校验"。
      await expectRejected(insertSnapshot('NO-SUCH-IDENTITY', null), {
        sqlState: '23503',
        constraint: 'QualificationEvaluationSnapshot_identityId_fkey',
      });
    });
  });

  // ==========================================================================
  // ⑨ ActivityInvitation(§3.14)—— DoD 5 形状 + DoD 6 NULL 去重
  // ==========================================================================

  describe('§3.14 ActivityInvitation', () => {
    const insertInvitation = (cols: {
      session?: string | null;
      statusCode?: string;
      respondedAt?: string | null;
      revokedAt?: string | null;
      member?: string;
    }) =>
      `INSERT INTO "ActivityInvitation"
        ("id","activityId","memberId","sessionId","statusCode","expiresAt",
         "respondedAt","revokedAt","updatedAt")
       VALUES (${sqlText(uniq('inv'))},${sqlText(activityId)},${sqlText(cols.member ?? memberId)},
        ${sqlText(cols.session === undefined ? sessionId : cols.session)},
        ${sqlText(cols.statusCode ?? 'pending')},${T(EXPIRES_AT)},
        ${sqlTime(cols.respondedAt ?? null)},${sqlTime(cols.revokedAt ?? null)},now())`;

    it('statusCode 闭集外被拒;五态全部放行', async () => {
      await expectRejected(insertInvitation({ statusCode: 'bogus' }), {
        sqlState: '23514',
        constraint: 'activity_invitation_status_code_check',
      });
      await expectAccepted(insertInvitation({ statusCode: 'pending', session: null }));
      await expectAccepted(insertInvitation({ statusCode: 'accepted', respondedAt: NOW_ISO }));
      await expectAccepted(insertInvitation({ statusCode: 'declined', respondedAt: NOW_ISO }));
      await expectAccepted(insertInvitation({ statusCode: 'revoked', revokedAt: NOW_ISO }));
      await expectAccepted(insertInvitation({ statusCode: 'expired' }));
    });

    it('★撤销形状(双向):revoked 缺 revokedAt 被拒、非 revoked 带 revokedAt 被拒', async () => {
      // ★NULL 边界一:状态说 revoked,却查不到什么时候撤销的。
      await expectRejected(insertInvitation({ statusCode: 'revoked', revokedAt: null }), {
        sqlState: '23514',
        constraint: 'activity_invitation_revoked_shape_check',
      });
      // ★NULL 边界二:状态不是 revoked,却带着撤销时间。
      await expectRejected(insertInvitation({ statusCode: 'expired', revokedAt: NOW_ISO }), {
        sqlState: '23514',
        constraint: 'activity_invitation_revoked_shape_check',
      });
      await expectRejected(insertInvitation({ statusCode: 'pending', revokedAt: NOW_ISO }), {
        sqlState: '23514',
        constraint: 'activity_invitation_revoked_shape_check',
      });
      await expectAccepted(insertInvitation({ statusCode: 'revoked', revokedAt: NOW_ISO }));
    });

    it('★应答形状(单向):accepted/declined 缺 respondedAt 被拒;pending 带 respondedAt 被拒', async () => {
      await expectRejected(insertInvitation({ statusCode: 'accepted', respondedAt: null }), {
        sqlState: '23514',
        constraint: 'activity_invitation_responded_shape_check',
      });
      await expectRejected(insertInvitation({ statusCode: 'declined', respondedAt: null }), {
        sqlState: '23514',
        constraint: 'activity_invitation_responded_shape_check',
      });
      await expectRejected(insertInvitation({ statusCode: 'pending', respondedAt: NOW_ISO }), {
        sqlState: '23514',
        constraint: 'activity_invitation_responded_shape_check',
      });
    });

    it('应答形状**刻意单向**:「先接受、后被撤销」必须放行(双向写法会抹掉这个事实)', async () => {
      await expectAccepted(
        insertInvitation({ statusCode: 'revoked', respondedAt: NOW_ISO, revokedAt: NOW_ISO }),
      );
      // expired 同理不约束 respondedAt。
      await expectAccepted(insertInvitation({ statusCode: 'expired', respondedAt: NOW_ISO }));
    });

    it('★DoD 6:两张 sessionId 为 NULL 的 active(pending)活动级邀请 —— 第二张被拒', async () => {
      // 这是 NULLS NOT DISTINCT 的判据。若索引漏掉该子句,PostgreSQL 默认把 NULL
      // 视为互不相等 ⇒ 下面第二条会**静默入库**,索引在"活动级邀请"这一整类行上
      // 完全失效 —— 而场次级邀请(sessionId 有值)照样被拦,于是漏写在只测场次级的
      // 用例里完全看不出来。必须专门测 NULL 这一支。
      await expectAccepted(insertInvitation({ session: null, statusCode: 'pending' }));
      await expectRejected(insertInvitation({ session: null, statusCode: 'pending' }), {
        sqlState: '23505',
        key: 'activityId',
      });
    });

    it('active partial unique 同样拦场次级重复;非 pending 终态可重复(拒绝后能改邀)', async () => {
      await expectAccepted(insertInvitation({ session: sessionId, statusCode: 'pending' }));
      await expectRejected(insertInvitation({ session: sessionId, statusCode: 'pending' }), {
        sqlState: '23505',
        key: 'activityId',
      });
      // partial 谓词的反向锁:declined / revoked / expired 必须能重复,
      // 否则一次拒绝就把这个人在这个场次上永久锁死,再也发不出第二张邀请。
      await expectAccepted(
        insertInvitation({ session: sessionId, statusCode: 'declined', respondedAt: NOW_ISO }),
      );
      await expectAccepted(
        insertInvitation({ session: sessionId, statusCode: 'declined', respondedAt: NOW_ISO }),
      );
      await expectAccepted(
        insertInvitation({ session: sessionId, statusCode: 'revoked', revokedAt: NOW_ISO }),
      );
      await expectAccepted(
        insertInvitation({ session: sessionId, statusCode: 'revoked', revokedAt: NOW_ISO }),
      );
      await expectAccepted(insertInvitation({ session: sessionId, statusCode: 'expired' }));
      await expectAccepted(insertInvitation({ session: sessionId, statusCode: 'expired' }));
    });

    it('活动级 pending 与场次级 pending 互不占位(sessionId 参与键)', async () => {
      await expectAccepted(insertInvitation({ session: null, statusCode: 'pending' }));
      await expectAccepted(insertInvitation({ session: sessionId, statusCode: 'pending' }));
    });
  });

  // ==========================================================================
  // ⑩ ActivityVisitor(§3.14)—— 刻意零 Member 外键
  // ==========================================================================

  describe('§3.14 ActivityVisitor', () => {
    const insertVisitor = (cols: { session?: string; invitedByMemberId?: string | null }) =>
      `INSERT INTO "ActivityVisitor"
        ("id","activityId","sessionId","name","organization","invitedByMemberId","note","attendanceCode","updatedAt")
       VALUES (${sqlText(uniq('vis'))},${sqlText(activityId)},
        ${sqlText(cols.session ?? sessionId)},'访客甲','某单位',
        ${sqlText(cols.invitedByMemberId ?? null)},'备注',${sqlText(uniq('vc'))},now())`;

    it('🔴 invitedByMemberId 指向**不存在**的 member 仍能入库 —— 该列刻意无外键(合同 §3.14)', async () => {
      // 合同原话:「与 Member、Participation、Ledger 无 relation;禁止通过访客创建贡献分」。
      // 一旦接上 Member 外键,访客就有了通往 Participation / Ledger 的图上路径,
      // 那条不变量就只剩文字。这条用例把"没有外键"钉成**可执行判据**:
      // 哪天有人顺手补上 FK,它会立刻变红。
      await expectAccepted(insertVisitor({ invitedByMemberId: 'THIS-MEMBER-ID-DOES-NOT-EXIST' }));
      await expectAccepted(insertVisitor({ invitedByMemberId: memberId }));
      await expectAccepted(insertVisitor({ invitedByMemberId: null }));
    });

    it('但活动/场次双锚点外键确实存在 —— 证明"零外键"是刻意的,不是整表没约束', async () => {
      await expectRejected(insertVisitor({ session: 'NO-SUCH-SESSION' }), {
        sqlState: '23503',
        constraint: 'ActivityVisitor_activityId_sessionId_fkey',
      });
    });

    it('访客表无任何指向 Member / Participation / Ledger 的外键(information_schema 直查)', async () => {
      // 上面那条是行为判据;这条是结构判据 —— 直接查 PG 的元数据,
      // 不给"外键存在但恰好没触发"留缝。
      const rows = await prisma.$queryRawUnsafe<{ foreign_table: string }[]>(`
        SELECT ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'ActivityVisitor' AND tc.constraint_type = 'FOREIGN KEY'
      `);
      const targets = [...new Set(rows.map((r) => r.foreign_table))].sort();
      expect(targets).toEqual(['ActivitySession', 'Activity'].sort());
      expect(targets).not.toContain('Member');
    });
  });
});
