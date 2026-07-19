import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('D-INSURANCE resetDb regression', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createFixture(label: string): Promise<{
    selfEvidenceId: string;
    teamEvidenceId: string;
  }> {
    const reviewer = await prisma.user.create({
      data: {
        username: `insurance-reset-${label}`,
        passwordHash: '$2a$10$insurance-reset-regression-reviewer',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    const member = await prisma.member.create({
      data: {
        memberNo: `insurance-reset-${label}`,
        displayName: 'Insurance Reset Member',
      },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: `Insurance Reset Organization ${label}`,
        nodeTypeCode: 'insurance-reset',
      },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Insurance Reset Activity ${label}`,
        activityTypeCode: 'insurance-reset',
        organizationId: organization.id,
        startAt: new Date('2027-01-10T00:00:00.000Z'),
        endAt: new Date('2027-01-10T08:00:00.000Z'),
        location: 'insurance-reset',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: {
        activityId: activity.id,
        memberId: member.id,
        statusCode: 'pass',
      },
      select: { id: true },
    });
    const cycle = await prisma.teamJoinCycle.create({
      data: {
        year: 2027,
        name: `Insurance Reset Cycle ${label}`,
        statusCode: 'closed',
      },
      select: { id: true },
    });
    const joinApplication = await prisma.teamJoinApplication.create({
      data: {
        cycleId: cycle.id,
        memberId: member.id,
        statusCode: 'approved',
        targetOrganizationIds: [],
      },
      select: { id: true },
    });
    const memberInsurance = await prisma.memberInsurance.create({
      data: {
        memberId: member.id,
        insurerName: 'insurance-reset-self',
        policyNumber: `insurance-reset-self-${label}`,
        coverageStart: new Date('2027-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2027-12-31T00:00:00.000Z'),
        reviewStatusCode: 'verified',
        version: 1,
        reviewedByUserId: reviewer.id,
        reviewedAt: new Date('2027-01-02T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const teamPolicy = await prisma.teamInsurancePolicy.create({
      data: {
        insurerName: 'insurance-reset-team',
        policyNumber: `insurance-reset-team-${label}`,
        coverageStart: new Date('2027-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2027-12-31T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const teamCoverage = await prisma.teamInsuranceCoverage.create({
      data: { policyId: teamPolicy.id, memberId: member.id },
      select: { id: true },
    });

    const selfEvidence = await prisma.insuranceEligibilityEvidence.create({
      data: {
        sourceKind: 'member_insurance',
        memberInsuranceId: memberInsurance.id,
        ownerKind: 'activity_registration',
        activityRegistrationId: registration.id,
        sourceRevision: 1,
        sourceReviewedByUserId: reviewer.id,
        sourceReviewedAt: new Date('2027-01-02T00:00:00.000Z'),
        requiredFrom: new Date('2027-01-10T00:00:00.000Z'),
        requiredThrough: new Date('2027-01-10T00:00:00.000Z'),
        sourceCoverageStart: new Date('2027-01-01T00:00:00.000Z'),
        sourceCoverageEnd: new Date('2027-12-31T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const teamEvidence = await prisma.insuranceEligibilityEvidence.create({
      data: {
        sourceKind: 'team_insurance_coverage',
        teamInsuranceCoverageId: teamCoverage.id,
        ownerKind: 'team_join_application',
        teamJoinApplicationId: joinApplication.id,
        requiredFrom: new Date('2027-01-10T00:00:00.000Z'),
        requiredThrough: new Date('2027-01-10T00:00:00.000Z'),
        sourceCoverageStart: new Date('2027-01-01T00:00:00.000Z'),
        sourceCoverageEnd: new Date('2027-12-31T00:00:00.000Z'),
      },
      select: { id: true },
    });

    return { selfEvidenceId: selfEvidence.id, teamEvidenceId: teamEvidence.id };
  }

  it('explicitly lists evidence before every source/owner table in resetDb TRUNCATE SQL', async () => {
    const resetSource = await readFile(
      path.resolve(process.cwd(), 'test/setup/reset-db.ts'),
      'utf8',
    );
    const truncateMatch = resetSource.match(/'TRUNCATE TABLE ([^']+) RESTART IDENTITY CASCADE'/);
    if (!truncateMatch?.[1]) {
      throw new Error('resetDb explicit TRUNCATE table list disappeared');
    }

    const explicitTableList = truncateMatch[1];
    const evidencePosition = explicitTableList.indexOf('"insurance_eligibility_evidences"');
    expect(evidencePosition).toBeGreaterThanOrEqual(0);

    const dependencies = [
      '"member_insurances"',
      '"team_insurance_coverages"',
      '"ActivityRegistration"',
      '"team_join_applications"',
      '"User"',
    ];
    for (const dependency of dependencies) {
      const dependencyPosition = explicitTableList.indexOf(dependency);
      expect(dependencyPosition).toBeGreaterThan(evidencePosition);
    }
  });

  it('clears evidence before all source/owner tables and permits rebuilding the same fixture', async () => {
    const first = await createFixture('stable');
    expect(first.selfEvidenceId).toBeTruthy();
    expect(first.teamEvidenceId).toBeTruthy();
    await expect(prisma.insuranceEligibilityEvidence.count()).resolves.toBe(2);

    await resetDb(app);

    const counts = await Promise.all([
      prisma.insuranceEligibilityEvidence.count(),
      prisma.activityRegistration.count(),
      prisma.teamJoinApplication.count(),
      prisma.memberInsurance.count(),
      prisma.teamInsuranceCoverage.count(),
      prisma.teamInsurancePolicy.count(),
      prisma.user.count(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);

    // Reuse the same username/memberNo/business combinations. Any FK/unique residue kills this step.
    const second = await createFixture('stable');
    expect(second.selfEvidenceId).toBeTruthy();
    expect(second.teamEvidenceId).toBeTruthy();
    await expect(prisma.insuranceEligibilityEvidence.count()).resolves.toBe(2);
  });
});
