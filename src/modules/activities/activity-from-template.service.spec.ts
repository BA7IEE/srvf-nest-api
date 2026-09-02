import { createHash } from 'node:crypto';

import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { computeActivityTemplateDefinitionHash } from './activity-template-definition';
import type { ActivityAccessService } from './activity-access.service';
import type { ActivityAllocationModeService } from './activity-allocation-mode.service';
import type { ActivityAuditRecorder } from './activity-audit-recorder';
import {
  ActivityFromTemplateService,
  type CreateActivityFromTemplateCommand,
} from './activity-from-template.service';
import type { ActivityImageSigningService } from './activity-image-signing.service';
import type { ActivityInitiationPolicy } from './activity-initiation-policy';
import { canonicalize } from './settlement-content-hash';

const META: AuditMeta = { requestId: 'a6-unit-req', ip: '127.0.0.1', ua: 'jest' };
const USER: CurrentUserPayload = {
  id: 'user-a6-1',
  username: 'a6-admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const COMMAND: CreateActivityFromTemplateCommand = {
  templateVersionId: 'template-a6-0001',
  title: '模板创建的活动',
  organizationId: 'organization-a6-0001',
  startAt: '2099-09-01T08:00:00.000Z',
  endAt: '2099-09-01T12:00:00.000Z',
  location: '集合点',
  registrationDeadline: '2099-09-01T07:30:00.000Z',
  operationKey: 'a6-operation-key-0001',
};

function definition() {
  return {
    activity: {
      allocationModeCode: 'first_come',
      description: '模板默认说明',
      capacity: 30,
      genderRequirementCode: 'all',
      registrationNotes: '请准时到场',
      isPublicRegistration: false,
      requiresInsurance: true,
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      defaultLocationRequired: false,
      defaultCheckInRadiusMeters: null,
      archiveWaitingDays: 7,
    },
    sessions: [
      {
        code: 'morning',
        name: '上午场',
        startOffsetMinutes: 0,
        endOffsetMinutes: 120,
        locationText: '集合点 A',
        capacity: 20,
        checkInOpenOffsetMinutes: 0,
        checkInCloseOffsetMinutes: 30,
        checkOutOpenOffsetMinutes: -30,
        checkOutCloseOffsetMinutes: 0,
        locationRequired: false,
        lateGraceMinutes: 10,
        earlyLeaveThresholdMinutes: 10,
        sortOrder: 2,
        positions: [
          {
            code: 'support',
            name: '现场保障',
            attendanceRoleCode: 'support',
            capacity: 5,
            startOffsetMinutes: 0,
            endOffsetMinutes: 120,
            genderRequirementCode: 'all',
            locationRequired: null,
            description: '负责现场保障',
            equipmentNotes: '手套',
            sortOrder: 3,
          },
        ],
      },
    ],
  };
}

function definitionHash(definitionJson: Record<string, unknown> = definition()): string {
  return computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition: definitionJson });
}

function requestHash(
  command: CreateActivityFromTemplateCommand,
  templateHash: string,
  actorUserId = USER.id,
): string {
  return createHash('sha256')
    .update(
      canonicalize({
        action: 'activity.create.from_template',
        actorUserId,
        operationKey: command.operationKey,
        templateVersionId: command.templateVersionId,
        definitionHash: templateHash,
        title: command.title,
        organizationId: command.organizationId,
        startAt: new Date(command.startAt).toISOString(),
        endAt: new Date(command.endAt).toISOString(),
        location: command.location,
        registrationDeadline: new Date(command.registrationDeadline ?? '').toISOString(),
        initiatorMemberId: command.initiatorMemberId ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'activity-a6-0001',
    title: COMMAND.title,
    activityTypeCode: 'rescue',
    allocationModeCode: 'first_come',
    organizationId: COMMAND.organizationId,
    initiatorMemberId: null,
    workflowRevision: 0,
    startAt: new Date(COMMAND.startAt),
    endAt: new Date(COMMAND.endAt),
    location: COMMAND.location,
    description: '模板默认说明',
    capacity: 30,
    genderRequirementCode: 'all',
    registrationDeadline: new Date(COMMAND.registrationDeadline ?? ''),
    registrationNotes: '请准时到场',
    statusCode: 'draft',
    publishedBy: null,
    publishedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    terminatedAt: null,
    terminatedByUserId: null,
    terminationReason: null,
    cancelOperationKey: null,
    cancelRequestHash: null,
    terminateOperationKey: null,
    terminateRequestHash: null,
    archivedAt: null,
    archivedByUserId: null,
    archivedFromStatusCode: null,
    archiveReasonCode: null,
    archiveOperationKey: null,
    archiveRequestHash: null,
    unarchivedAt: null,
    unarchivedByUserId: null,
    unarchiveOperationKey: null,
    unarchiveRequestHash: null,
    isPublicRegistration: false,
    requiresInsurance: true,
    registrationModeCode: 'open_apply',
    visibilityCode: 'internal',
    defaultCheckInRadiusMeters: null,
    defaultLocationRequired: false,
    archiveWaitingDays: 7,
    registrationSchema: null,
    coverImageKey: null,
    coverAttachmentId: null,
    galleryImageKeys: [],
    galleryAttachmentIds: [],
    content: null,
    locationLongitude: null,
    locationLatitude: null,
    createdAt: new Date('2099-01-01T00:00:00.000Z'),
    updatedAt: new Date('2099-01-01T00:00:00.000Z'),
    activityPositions: [],
    ...overrides,
  };
}

function templateRow(overrides: Record<string, unknown> = {}) {
  const definitionJson = definition();
  return {
    id: COMMAND.templateVersionId,
    familyId: 'template-family-a6-0001',
    activityTypeCode: 'rescue',
    statusCode: 'active',
    schemaVersion: 1,
    definitionJson,
    definitionHash: definitionHash(definitionJson),
    effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
    effectiveTo: null,
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeSubject(
  options: {
    readonly template?: Record<string, unknown>;
    readonly replay?: Record<string, unknown> | null;
    readonly createError?: Error;
  } = {},
) {
  const template = templateRow(options.template);
  const created = activityRow();
  let activityCreateInput: unknown;
  let sessionCreateInput: unknown;
  let positionCreateInput: unknown;
  const tx = {
    activity: {
      findUnique: jest.fn().mockResolvedValue(options.replay ?? null),
      create: jest.fn().mockImplementation((input: unknown) => {
        activityCreateInput = input;
        if (options.createError) return Promise.reject(options.createError);
        return Promise.resolve(created);
      }),
    },
    activityTemplate: { findUnique: jest.fn().mockResolvedValue(template) },
    activitySession: {
      create: jest.fn().mockImplementation((input: unknown) => {
        sessionCreateInput = input;
        return Promise.resolve({ id: 'session-a6-0001' });
      }),
    },
    activitySessionPosition: {
      create: jest.fn().mockImplementation((input: unknown) => {
        positionCreateInput = input;
        return Promise.resolve({ id: 'position-a6-0001' });
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: COMMAND.templateVersionId }]),
  };
  const prisma = {
    $transaction: jest.fn((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const access = {
    assertCanOrThrow: jest.fn().mockResolvedValue(undefined),
    assertStartEndValid: jest.fn(),
    assertRegistrationDeadlineValid: jest.fn(),
    assertDictItemValid: jest.fn().mockResolvedValue(undefined),
    assertOrganizationValidAndNonRoot: jest.fn().mockResolvedValue(undefined),
  };
  const allocationModes = { assertValidMode: jest.fn() };
  const initiationPolicy = { resolveInitiator: jest.fn().mockResolvedValue('member-a6-0001') };
  const audit = { logCreateFromTemplate: jest.fn().mockResolvedValue(undefined) };
  const images = {
    signImages: jest.fn().mockResolvedValue({ coverImageUrl: null, galleryImageUrls: [] }),
  };
  const service = new ActivityFromTemplateService(
    prisma as unknown as PrismaService,
    access as unknown as ActivityAccessService,
    allocationModes as unknown as ActivityAllocationModeService,
    initiationPolicy as unknown as ActivityInitiationPolicy,
    audit as unknown as ActivityAuditRecorder,
    images as unknown as ActivityImageSigningService,
    { activityResponsibilityWorkflow: { enabled: false } } as never,
  );
  return {
    service,
    tx,
    prisma,
    access,
    allocationModes,
    initiationPolicy,
    audit,
    images,
    created,
    template,
    activityCreateInput: () => activityCreateInput,
    sessionCreateInput: () => sessionCreateInput,
    positionCreateInput: () => positionCreateInput,
  };
}

describe('ActivityFromTemplateService', () => {
  it('在一条 transaction 内物化 Activity / Session / Position，并写专用安全审计', async () => {
    const subject = makeSubject();

    const result = await subject.service.createFromTemplate(COMMAND, USER, META);

    expect(result).toMatchObject({ id: 'activity-a6-0001', statusCode: 'draft' });
    expect(subject.access.assertCanOrThrow).toHaveBeenCalledWith(USER, 'activity.create.record');
    expect(subject.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const activityCreateInput = subject.activityCreateInput();
    if (!isRecord(activityCreateInput) || !isRecord(activityCreateInput.data)) {
      throw new Error('A6 activity create mock did not receive a data record');
    }
    expect(activityCreateInput.data).toMatchObject({
      selectedTemplateVersionId: COMMAND.templateVersionId,
      createFromTemplateOperationKey: COMMAND.operationKey,
      activityTypeCode: 'rescue',
      allocationModeCode: 'first_come',
      statusCode: 'draft',
    });
    expect(activityCreateInput.data).not.toHaveProperty('registrationSchema');
    expect(activityCreateInput.data).not.toHaveProperty('content');
    const sessionCreateInput = subject.sessionCreateInput();
    if (!isRecord(sessionCreateInput) || !isRecord(sessionCreateInput.data)) {
      throw new Error('A6 session create mock did not receive a data record');
    }
    expect(sessionCreateInput.data).toMatchObject({
      activityId: 'activity-a6-0001',
      code: 'morning',
      locationPolicySourceCode: 'template',
      locationRequired: false,
      longitude: null,
      latitude: null,
    });
    const positionCreateInput = subject.positionCreateInput();
    if (!isRecord(positionCreateInput) || !isRecord(positionCreateInput.data)) {
      throw new Error('A6 session-position create mock did not receive a data record');
    }
    expect(positionCreateInput.data).toMatchObject({
      sessionId: 'session-a6-0001',
      code: 'support',
      leaderMemberId: null,
    });
    expect(subject.audit.logCreateFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateVersionId: COMMAND.templateVersionId,
        definitionHash: subject.template.definitionHash,
        nextStatusCode: 'draft',
      }),
    );
  });

  it('同 key、同请求直接回放，不检查模板当前状态也不重复写审计', async () => {
    const templateHash = definitionHash();
    const replay = {
      ...activityRow(),
      createFromTemplateRequestHash: requestHash(COMMAND, templateHash),
      selectedTemplateVersion: { definitionHash: templateHash },
    };
    const subject = makeSubject({
      replay,
      template: { statusCode: 'retired' },
    });

    const result = await subject.service.createFromTemplate(COMMAND, USER, META);

    expect(result.id).toBe('activity-a6-0001');
    expect(subject.tx.activityTemplate.findUnique).not.toHaveBeenCalled();
    expect(subject.tx.$queryRaw).not.toHaveBeenCalled();
    expect(subject.tx.activity.create).not.toHaveBeenCalled();
    expect(subject.tx.activitySession.create).not.toHaveBeenCalled();
    expect(subject.audit.logCreateFromTemplate).not.toHaveBeenCalled();
  });

  it('同 key 绑定不同规范化输入时拒绝，而不是返回旧 Activity', async () => {
    const templateHash = definitionHash();
    const replay = {
      ...activityRow(),
      createFromTemplateRequestHash: requestHash(COMMAND, templateHash),
      selectedTemplateVersion: { definitionHash: templateHash },
    };
    const subject = makeSubject({ replay });

    await expect(
      subject.service.createFromTemplate({ ...COMMAND, title: '另一个标题' }, USER, META),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT });
    expect(subject.tx.activity.create).not.toHaveBeenCalled();
  });

  it('active 但 hash 不匹配的 Version 统一拒绝，且零 Activity 写入', async () => {
    const subject = makeSubject({ template: { definitionHash: 'b'.repeat(64) } });

    await expect(subject.service.createFromTemplate(COMMAND, USER, META)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE,
    });
    expect(subject.tx.activity.create).not.toHaveBeenCalled();
    expect(subject.audit.logCreateFromTemplate).not.toHaveBeenCalled();
  });

  it('operationKey 并发 P2002 后重新读取锚点，哈希一致则收敛为同一结果', async () => {
    const templateHash = definitionHash();
    const replay = {
      ...activityRow(),
      createFromTemplateRequestHash: requestHash(COMMAND, templateHash),
      selectedTemplateVersion: { definitionHash: templateHash },
    };
    const conflict = new Prisma.PrismaClientKnownRequestError('duplicate operation key', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'activity_create_from_template_operation_key_key' },
    });
    const subject = makeSubject({ createError: conflict });
    subject.tx.activity.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(replay);

    const result = await subject.service.createFromTemplate(COMMAND, USER, META);

    expect(result.id).toBe('activity-a6-0001');
    expect(subject.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(subject.audit.logCreateFromTemplate).not.toHaveBeenCalled();
  });

  it('不接受越过 Definition V1 的 true 定位请求，避免无坐标场次落库', async () => {
    const invalidDefinition = definition();
    invalidDefinition.sessions[0].locationRequired = true;
    const subject = makeSubject({
      template: {
        definitionJson: invalidDefinition,
        definitionHash: definitionHash(invalidDefinition),
      },
    });

    await expect(subject.service.createFromTemplate(COMMAND, USER, META)).rejects.toBeInstanceOf(
      BizException,
    );
    expect(subject.tx.activity.create).not.toHaveBeenCalled();
  });
});
