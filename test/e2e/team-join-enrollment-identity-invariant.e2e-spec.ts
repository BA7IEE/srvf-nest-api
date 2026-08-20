import type { INestApplication } from '@nestjs/common';
import {
  MemberStatus,
  MembershipStatus,
  MembershipType,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { MemberDepartmentsService } from '../../src/modules/member-departments/member-departments.service';
import { MembershipsService } from '../../src/modules/member-departments/memberships.service';
import { MembersService } from '../../src/modules/members/members.service';
import { AppMeTeamJoinService } from '../../src/modules/team-join/team-join-applications.app.service';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// M2(并发复审 P1):「未入队志愿者」是一条 live 入队申请**唯一**的走通前提 ——
// final join 的步骤 6 拿 `isUnenrolledVolunteer` 把关。除 final join 之外的任何写方把它翻掉,
// 那条申请就成了 frozen 行:evaluate 还能把它推到 approved(管理台显示「待入队」),
// 而 final join 从此永远 28210,再没有现存通路让它离开 live 状态。
//
// 拍板(2026-08-01)取「拒绝」:不自动终结、不静默放行,返 28211 把选择权交回管理员。
//
// ⚠️ 本 spec 的第一组用例**不需要并发** —— 修复前串行跑一遍就能造出 frozen 行,
// 这正是评审说「不是并发 bug,是不变量根本没人守」的意思。第二组才是并发位:
// 它拦的是「闸读到没有 live 申请」与「submit 建行」之间的那条缝。

const META: AuditMeta = {
  requestId: 'team-join-enrollment-identity-invariant',
  ip: '127.0.0.1',
  ua: 'jest/team-join-enrollment-identity-invariant',
};
const LOCK_WAIT_TIMEOUT_MS = 1_200;
const CASE_TIMEOUT_MS = 60_000;
const CYCLE_YEAR = 2026;
const VOL_ORG_CODE = 'VOL';
const LIVE_APPLICATION_STATUSES = ['joining', 'pending_evaluation', 'approved'];

interface Volunteer {
  memberId: string;
  volMembershipId: string;
  user: CurrentUserPayload;
}

describe('入队身份不变量:唯一 transition(M2)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let membersA: MembersService;
  let memberDepartmentsA: MemberDepartmentsService;
  let membershipsA: MembershipsService;
  let appMeA: AppMeTeamJoinService;
  let membersB: MembersService;
  let admin: CurrentUserPayload;
  let volOrgId: string;
  let otherOrgId: string;
  let cycleId: string;
  let seq = 0;

  async function countAnyLockWaiters(): Promise<number> {
    const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    return row?.n ?? 0;
  }

  function holdAuditLogInserts(): {
    ready: Promise<void>;
    release: () => void;
    done: Promise<void>;
  } {
    let signalReady!: () => void;
    let doRelease!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      doRelease = resolve;
    });
    const done = prismaA.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "audit_logs" IN SHARE MODE');
        signalReady();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ready, release: () => doRelease(), done };
  }

  /** 新口径「未入队志愿者」:gradeCode='volunteer' + 恰好一条 active PRIMARY 且 org.code='VOL'。 */
  async function createVolunteer(): Promise<Volunteer> {
    seq += 1;
    const member = await prismaA.member.create({
      data: {
        memberNo: `M2I${String(seq).padStart(3, '0')}`,
        ...memberIdentityData(`不变量${seq}`),
        status: MemberStatus.ACTIVE,
        gradeCode: 'volunteer',
      },
      select: { id: true },
    });
    const membership = await prismaA.memberOrganizationMembership.create({
      data: {
        memberId: member.id,
        organizationId: volOrgId,
        membershipType: MembershipType.PRIMARY,
        status: MembershipStatus.ACTIVE,
        startedAt: new Date(Date.now() - 86_400_000),
      },
      select: { id: true },
    });
    const user = await prismaA.user.create({
      data: {
        username: `m2i-volunteer-${seq}`,
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: member.id,
      },
      select: { id: true, username: true },
    });
    return {
      memberId: member.id,
      volMembershipId: membership.id,
      user: {
        id: user.id,
        username: user.username,
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: member.id,
      },
    };
  }

  async function giveLiveApplication(memberId: string, statusCode = 'joining'): Promise<string> {
    const row = await prismaA.teamJoinApplication.create({
      data: { cycleId, memberId, statusCode, targetOrganizationIds: [] },
      select: { id: true },
    });
    return row.id;
  }

  /** 断言:该写方被 28211 拒,且**什么都没写**(身份与申请都原封不动)。 */
  async function expectBlocked(
    volunteer: Volunteer,
    applicationId: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    await expect(run()).rejects.toMatchObject({
      biz: BizCode.TEAM_JOIN_MEMBER_HAS_LIVE_APPLICATION,
    });
    const member = await prismaA.member.findUniqueOrThrow({
      where: { id: volunteer.memberId },
      select: { gradeCode: true, status: true },
    });
    expect(member.gradeCode).toBe('volunteer');
    expect(member.status).toBe(MemberStatus.ACTIVE);
    const activePrimary = await prismaA.memberOrganizationMembership.findMany({
      where: {
        memberId: volunteer.memberId,
        membershipType: MembershipType.PRIMARY,
        status: MembershipStatus.ACTIVE,
        deletedAt: null,
        endedAt: null,
      },
      select: { id: true, organizationId: true },
    });
    expect(activePrimary).toEqual([{ id: volunteer.volMembershipId, organizationId: volOrgId }]);
    expect(
      (
        await prismaA.teamJoinApplication.findUniqueOrThrow({
          where: { id: applicationId },
          select: { statusCode: true },
        })
      ).statusCode,
    ).toBe('joining');
  }

  /** §DoD 全库不变量:live 申请的持有者必须仍是「未入队志愿者」。 */
  async function assertEveryLiveApplicationStillReachable(): Promise<void> {
    const rows = await prismaA.$queryRaw<Array<{ id: string; memberId: string }>>(Prisma.sql`
      SELECT app."id", app."memberId"
      FROM "team_join_applications" app
      JOIN "Member" m ON m."id" = app."memberId"
      WHERE app."deletedAt" IS NULL
        AND app."statusCode" = ANY(${LIVE_APPLICATION_STATUSES})
        AND (
          m."status" <> 'ACTIVE'
          OR m."deletedAt" IS NOT NULL
          OR NOT (
            (
              m."gradeCode" = 'volunteer'
              AND (
                SELECT count(*) FROM "member_organization_memberships" mm
                JOIN "Organization" o ON o."id" = mm."organizationId"
                WHERE mm."memberId" = m."id" AND mm."membershipType" = 'PRIMARY'
                  AND mm."status" = 'ACTIVE' AND mm."deletedAt" IS NULL AND mm."endedAt" IS NULL
                  AND o."code" = ${VOL_ORG_CODE}
              ) = 1
              AND (
                SELECT count(*) FROM "member_organization_memberships" mm
                WHERE mm."memberId" = m."id" AND mm."membershipType" = 'PRIMARY'
                  AND mm."status" = 'ACTIVE' AND mm."deletedAt" IS NULL AND mm."endedAt" IS NULL
              ) = 1
            )
            OR (
              m."gradeCode" IS NULL
              AND (
                SELECT count(*) FROM "member_organization_memberships" mm
                WHERE mm."memberId" = m."id" AND mm."membershipType" = 'PRIMARY'
                  AND mm."status" = 'ACTIVE' AND mm."deletedAt" IS NULL AND mm."endedAt" IS NULL
              ) = 0
            )
          )
        )
    `);
    expect(rows).toEqual([]);
  }

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    membersA = appA.get(MembersService);
    memberDepartmentsA = appA.get(MemberDepartmentsService);
    membershipsA = appA.get(MembershipsService);
    appMeA = appA.get(AppMeTeamJoinService);
    membersB = appB.get(MembersService);

    const adminRow = await prismaA.user.create({
      data: {
        username: 'm2i-super-admin',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    admin = {
      id: adminRow.id,
      username: adminRow.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    volOrgId = (
      await prismaA.organization.create({
        data: {
          name: '志愿者归口',
          code: VOL_ORG_CODE,
          nodeTypeCode: 'm2i-node',
          status: 'ACTIVE',
        },
        select: { id: true },
      })
    ).id;
    otherOrgId = (
      await prismaA.organization.create({
        data: { name: 'M2I 业务部门', nodeTypeCode: 'm2i-node', status: 'ACTIVE' },
        select: { id: true },
      })
    ).id;
    cycleId = (
      await prismaA.teamJoinCycle.create({
        data: { year: CYCLE_YEAR, name: 'M2I 轮', statusCode: 'open', openedAt: new Date() },
        select: { id: true },
      })
    ).id;
    // members.update(gradeCode) 需要 member_grade 字典项(resetDb 已 truncate)。
    const gradeType = await prismaA.dictType.create({
      data: { code: 'member_grade', label: '队员级别' },
      select: { id: true },
    });
    await prismaA.dictItem.createMany({
      data: [
        { typeId: gradeType.id, code: 'level-1', label: '级别 1' },
        { typeId: gradeType.id, code: 'level-2', label: '级别 2' },
        { typeId: gradeType.id, code: 'volunteer', label: '志愿者' },
      ],
    });
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  // ── ① 串行路径:七个写方逐个被拒(修复前它们全都成功,并各造一条 frozen 行)──────
  it(
    '① members.update(gradeCode) 被拒 —— 评审点名的最短路径',
    async () => {
      const volunteer = await createVolunteer();
      const applicationId = await giveLiveApplication(volunteer.memberId);
      await expectBlocked(volunteer, applicationId, () =>
        membersA.update(volunteer.memberId, { gradeCode: 'level-1' }, admin),
      );
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '① member-departments.set(换 PRIMARY 部门)被拒',
    async () => {
      const volunteer = await createVolunteer();
      const applicationId = await giveLiveApplication(volunteer.memberId);
      await expectBlocked(volunteer, applicationId, () =>
        memberDepartmentsA.set(admin, volunteer.memberId, { organizationId: otherOrgId }, META),
      );
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '① member-departments.remove(清 PRIMARY 部门)被拒',
    async () => {
      const volunteer = await createVolunteer();
      const applicationId = await giveLiveApplication(volunteer.memberId);
      await expectBlocked(volunteer, applicationId, () =>
        memberDepartmentsA.remove(admin, volunteer.memberId, META),
      );
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '① memberships.create(PRIMARY)被拒;SECONDARY 放行(不过度拦截)',
    async () => {
      const volunteer = await createVolunteer();
      const applicationId = await giveLiveApplication(volunteer.memberId);
      await expectBlocked(volunteer, applicationId, () =>
        membershipsA.create(
          admin,
          volunteer.memberId,
          { organizationId: otherOrgId, membershipType: MembershipType.PRIMARY },
          META,
        ),
      );
      // 反向:非 PRIMARY 进不了 isUnenrolledVolunteer 的 activeDepts,不该被这道闸拦。
      const secondary = await membershipsA.create(
        admin,
        volunteer.memberId,
        { organizationId: otherOrgId, membershipType: MembershipType.SECONDARY },
        META,
      );
      expect(secondary.membershipType).toBe(MembershipType.SECONDARY);
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '① memberships.update(改 membershipType)被拒',
    async () => {
      const volunteer = await createVolunteer();
      const applicationId = await giveLiveApplication(volunteer.memberId);
      await expectBlocked(volunteer, applicationId, () =>
        membershipsA.update(admin, volunteer.memberId, volunteer.volMembershipId, {
          membershipType: MembershipType.SECONDARY,
        }),
      );
      // 反向:只改 reason 不动 membershipType ⇒ 改不动那条判定 ⇒ 放行。
      const patched = await membershipsA.update(
        admin,
        volunteer.memberId,
        volunteer.volMembershipId,
        { reason: 'M2 反向对照' },
      );
      expect(patched.membershipType).toBe(MembershipType.PRIMARY);
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '① memberships.end(结束 VOL 任期)被拒',
    async () => {
      const volunteer = await createVolunteer();
      const applicationId = await giveLiveApplication(volunteer.memberId);
      await expectBlocked(volunteer, applicationId, () =>
        membershipsA.end(admin, volunteer.memberId, volunteer.volMembershipId, META),
      );
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '① memberships.transfer(PRIMARY 迁出 VOL)被拒',
    async () => {
      const volunteer = await createVolunteer();
      const applicationId = await giveLiveApplication(volunteer.memberId);
      await expectBlocked(volunteer, applicationId, () =>
        membershipsA.transfer(
          admin,
          {
            memberId: volunteer.memberId,
            fromOrganizationId: volOrgId,
            toOrganizationId: otherOrgId,
            membershipType: MembershipType.PRIMARY,
          },
          META,
        ),
      );
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '① members.updateStatus(INACTIVE / 离队)被拒 —— 离队会结束全部 ACTIVE 归属',
    async () => {
      const volunteer = await createVolunteer();
      const applicationId = await giveLiveApplication(volunteer.memberId);
      await expectBlocked(volunteer, applicationId, () =>
        membersA.updateStatus(volunteer.memberId, { status: MemberStatus.INACTIVE }, admin, META),
      );
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );

  // ── ② 反向:没有 live 申请时,同样这些写方必须照常成功(闸不得变成全局禁令)────────
  it(
    '② 无 live 申请 ⇒ 七个写方照常放行(闸只在不变量真的会破时才响)',
    async () => {
      const noApp = await createVolunteer();
      await membersA.update(noApp.memberId, { gradeCode: 'level-1' }, admin);
      await memberDepartmentsA.set(admin, noApp.memberId, { organizationId: otherOrgId }, META);
      await memberDepartmentsA.remove(admin, noApp.memberId, META);
      const created = await membershipsA.create(
        admin,
        noApp.memberId,
        { organizationId: volOrgId, membershipType: MembershipType.PRIMARY },
        META,
      );
      await membershipsA.update(admin, noApp.memberId, created.id, {
        membershipType: MembershipType.SECONDARY,
      });
      await membershipsA.end(admin, noApp.memberId, created.id, META);

      // transfer 需要一条现存 ACTIVE PRIMARY;补一条再迁。
      const forTransfer = await membershipsA.create(
        admin,
        noApp.memberId,
        { organizationId: volOrgId, membershipType: MembershipType.PRIMARY },
        META,
      );
      expect(forTransfer.membershipType).toBe(MembershipType.PRIMARY);
      const transferred = await membershipsA.transfer(
        admin,
        {
          memberId: noApp.memberId,
          fromOrganizationId: volOrgId,
          toOrganizationId: otherOrgId,
          membershipType: MembershipType.PRIMARY,
        },
        META,
      );
      expect(transferred.organizationId).toBe(otherOrgId);

      await membersA.updateStatus(noApp.memberId, { status: MemberStatus.INACTIVE }, admin, META);
      expect(
        (
          await prismaA.member.findUniqueOrThrow({
            where: { id: noApp.memberId },
            select: { status: true },
          })
        ).status,
      ).toBe(MemberStatus.INACTIVE);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '② 已入队队员(level-1 + 业务部门)不受闸影响 —— 他已经不是「未入队志愿者」',
    async () => {
      seq += 1;
      const enrolled = await prismaA.member.create({
        data: {
          memberNo: `M2E${String(seq).padStart(3, '0')}`,
          ...memberIdentityData(`已入队${seq}`),
          status: MemberStatus.ACTIVE,
          gradeCode: 'level-1',
        },
        select: { id: true },
      });
      await prismaA.memberOrganizationMembership.create({
        data: {
          memberId: enrolled.id,
          organizationId: otherOrgId,
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
          startedAt: new Date(Date.now() - 86_400_000),
        },
      });
      // 即使名下真有一条 live 申请(历史脏数据),闸也不该拦 —— 判定的第一关是身份。
      const dirtyApplicationId = await giveLiveApplication(enrolled.id);
      await membersA.update(enrolled.id, { gradeCode: 'level-2' }, admin);
      expect(
        (
          await prismaA.member.findUniqueOrThrow({
            where: { id: enrolled.id },
            select: { gradeCode: true },
          })
        ).gradeCode,
      ).toBe('level-2');
      // 这条脏数据是本用例**刻意**造的(证明闸不看申请、先看身份),用完就清 ——
      // 否则后续用例的全库不变量巡检会把它当成真实违规报出来。
      await prismaA.teamJoinApplication.delete({ where: { id: dirtyApplicationId } });
    },
    CASE_TIMEOUT_MS,
  );

  // ── ③ 并发位:闸的「读申请」与写方的「写身份」之间那条缝 ─────────────────────────
  it(
    '③ submit 正在建申请时并发 members.update(gradeCode)—— 必须串行并最终被拒',
    async () => {
      const volunteer = await createVolunteer();
      // 关掉别的 open 轮不必要:本 spec 只有一个 cycle,submit 用它。
      const barrier = holdAuditLogInserts();
      await barrier.ready;

      // submit 取 member 键 → 复核身份 → 建行 → 写 audit(卡在这里,行已建、尚未提交)。
      const submitting = appMeA.submit(
        { targetOrganizationIds: [otherOrgId] },
        volunteer.user,
        META,
        new Date(),
      );
      submitting.catch(() => undefined);
      {
        const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline && (await countAnyLockWaiters()) < 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      const updating = membersB.update(volunteer.memberId, { gradeCode: 'level-1' }, admin);
      updating.catch(() => undefined);
      let waiters = 0;
      try {
        // 修复前:update 不取 member 键,读到「零 live 申请」后径直改级别 ——
        // 提交后这个人已是 level-1,而 submit 刚建的那条 joining 申请再也走不通。
        const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline && waiters < 2) {
          waiters = await countAnyLockWaiters();
          if (waiters < 2) await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        barrier.release();
        await barrier.done;
      }
      const [submitResult, updateResult] = await Promise.allSettled([submitting, updating]);
      expect(submitResult.status).toBe('fulfilled');
      expect(updateResult.status).toBe('rejected');
      const reason = updateResult.status === 'rejected' ? updateResult.reason : undefined;
      expect(reason).toBeInstanceOf(BizException);
      expect((reason as BizException).biz).toBe(BizCode.TEAM_JOIN_MEMBER_HAS_LIVE_APPLICATION);
      expect(
        (
          await prismaA.member.findUniqueOrThrow({
            where: { id: volunteer.memberId },
            select: { gradeCode: true },
          })
        ).gradeCode,
      ).toBe('volunteer');
      await assertEveryLiveApplicationStillReachable();
    },
    CASE_TIMEOUT_MS,
  );
});
