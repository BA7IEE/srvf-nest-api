const assert = require('node:assert/strict'),
  { PrismaClient } = require('@prisma/client'),
  bcrypt = require('bcryptjs');
const {
  ActivityResponsibilityGrantProjector,
} = require('/app/dist/modules/activities/activity-responsibility-grant-projector');
const {
  AttendanceSegmentProjectorService,
} = require('/app/dist/modules/activities/attendance-segment-projector.service');
const catalog = require('/catalog.json');
const db = new PrismaClient();
(async () => {
  const result = await db.$transaction(
    async (tx) => {
      const [g] =
        await tx.$queryRaw`SELECT current_database() AS db,system_identifier::text AS cid FROM pg_control_system()`;
      assert.deepEqual(g, { db: process.env.TRIAL_DB, cid: process.env.TRIAL_CID });
      assert.equal(await tx.user.count(), 0);
      const org = await tx.organization.create({
        data: { name: 'T63 synthetic', nodeTypeCode: 'team' },
      });
      await tx.organizationClosure.create({
        data: { ancestorId: org.id, descendantId: org.id, depth: 0 },
      });
      const people = {},
        roles = {};
      for (const key of ['owner', 'first', 'final', 'member', 'other']) {
        const username = 't63_' + key;
        const m = await tx.member.create({
          data: {
            memberNo: username,
            realName: username,
            memberSinceDate: new Date('2020-01-01'),
            memberOriginCode: 'manual',
            gradeCode: 'level-1',
          },
        });
        const u = await tx.user.create({
          data: {
            username,
            passwordHash: await bcrypt.hash(process.env['PASS_' + key.toUpperCase()], 8),
            memberId: m.id,
          },
        });
        assert.equal(u.role, 'USER');
        people[key] = u;
        await tx.memberOrganizationMembership.create({
          data: { memberId: m.id, organizationId: org.id },
        });
      }
      const startAt = new Date(Date.now() - 4 * 3600000),
        endAt = new Date(+startAt + 39 * 60000);
      const a = await tx.activity.create({
        data: {
          title: 'T63 isolated activity',
          activityTypeCode: 'training',
          organizationId: org.id,
          startAt,
          endAt,
          location: 'fixture',
          statusCode: 'published',
        },
      });
      const s = await tx.activitySession.create({
        data: {
          activityId: a.id,
          code: 'fixture',
          name: 'fixture',
          startAt,
          endAt,
          locationText: 'fixture',
          checkInOpenAt: new Date(+startAt - 60000),
          checkInCloseAt: new Date(+startAt + 60000),
          checkOutOpenAt: new Date(+endAt - 60000),
          checkOutCloseAt: new Date(+endAt + 60000),
          locationRequired: false,
          locationPolicySourceCode: 'session',
          statusCode: 'scheduled',
        },
      });
      for (const spec of catalog.roles) {
        const role = await tx.rbacRole.upsert({
          where: { code: spec.code },
          create: { code: spec.code, displayName: spec.code },
          update: {},
        });
        roles[spec.code] = role.id;
        for (const code of spec.permissionCodes) {
          const def = catalog.defs.find((p) => p.code === code);
          assert(def, code);
          const p = await tx.permission.upsert({ where: { code }, create: def, update: {} });
          await tx.rolePermission.upsert({
            where: { roleId_permissionId: { roleId: role.id, permissionId: p.id } },
            create: { roleId: role.id, permissionId: p.id },
            update: {},
          });
        }
      }
      const owner = people.owner;
      const assignment = await tx.activityResponsibilityAssignment.create({
        data: {
          activityId: a.id,
          memberId: owner.memberId,
          responsibilityType: 'owner',
          status: 'active',
          source: 'publish',
          assignedByUserId: owner.id,
          canManageRegistrations: true,
          canManageAttendance: true,
        },
      });
      await new ActivityResponsibilityGrantProjector().projectOwner({
        tx,
        assignmentId: assignment.id,
        activityId: a.id,
        memberId: owner.memberId,
        actorUserId: owner.id,
        now: new Date(),
      });
      for (const [key, code] of [
        ['first', 'attendance-first-reviewer'],
        ['final', 'attendance-final-reviewer'],
      ])
        await tx.roleBinding.create({
          data: {
            principalType: 'USER',
            principalId: people[key].id,
            roleId: roles[code],
            scopeType: 'ORGANIZATION',
            scopeOrgId: org.id,
          },
        });
      const memberId = people.member.memberId;
      const reg = await tx.activityRegistration.create({
        data: { activityId: a.id, memberId, statusCode: 'pass' },
      });
      const i = await tx.activityParticipationIdentity.create({
        data: {
          activityId: a.id,
          sessionId: s.id,
          memberId,
          registrationId: reg.id,
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
      });
      const events = [];
      for (const [type, at] of [
        ['check_in', startAt],
        ['check_out', endAt],
      ])
        events.push(
          await tx.attendancePunchEvent.create({
            data: {
              activityId: a.id,
              sessionId: s.id,
              memberId,
              participationIdentityId: i.id,
              eventTypeCode: type,
              sourceCode: 'staff_scan',
              occurredAt: at,
              receivedAt: at,
              operatorUserId: owner.id,
              eventKey: 't63-' + type,
              requestHash: 't63-' + type,
              evidenceRevision: 0,
            },
          }),
        );
      const [v] = new AttendanceSegmentProjectorService().rebuild(events, {
        sessionStartAt: startAt,
        sessionEndAt: endAt,
        lateGraceMinutes: 0,
        earlyLeaveThresholdMinutes: 0,
      }).segments;
      await tx.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: i.id,
          segmentKey: v.segmentKey,
          revision: 1,
          sourceCheckInEventId: v.sourceCheckInEventId,
          sourceCloseEventId: v.sourceCloseEventId,
          resultCode: v.resultCode,
          statusCode: 'draft',
          checkInAt: v.checkInAt,
          checkOutAt: v.checkOutAt,
          serviceHours: v.serviceHours,
          lateFlag: v.lateFlag,
          earlyLeaveFlag: v.earlyLeaveFlag,
          exceptionFlagsJson: v.exceptionFlags,
        },
      });
      await tx.contributionRule.create({
        data: {
          activityTypeCode: 'training',
          attendanceRoleCode: 'member',
          pointsBelow: 1.5,
          status: 'ACTIVE',
        },
      });
      assert.equal(
        await tx.roleBinding.count({
          where: {
            principalId: {
              in: [
                people.member.id,
                people.other.id,
                people.member.memberId,
                people.other.memberId,
              ],
            },
          },
        }),
        0,
      );
      assert.equal(await tx.attendanceSettlementRun.count(), 0);
      assert.equal(await tx.participationLedgerEntry.count(), 0);
      return {
        activity: a.id,
        session: s.id,
        actors: Object.fromEntries(
          Object.entries(people).map(([k, u]) => [k, { id: u.id, member: u.memberId }]),
        ),
        ordinaryRoleBindings: 0,
        initialLedgerRows: 0,
        punchMinutes: 39,
      };
    },
    { timeout: 30000 },
  );
  console.log(JSON.stringify(result));
})()
  .catch((e) => {
    console.error(e.code, e.meta?.target, e.message.split('\n').slice(-2).join(' ').slice(0, 300));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
