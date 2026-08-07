import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { registrationFormDefinitionFromStoredFields } from './registration-form-definition';
import { RegistrationFormVersionService } from './registration-form-version.service';

const USER: CurrentUserPayload = {
  id: 'user-form-1',
  username: 'form-owner',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-form-1',
};
const META: AuditMeta = { requestId: 'form-unit', ip: null, ua: null };

function storedVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'form-version-1',
    activityId: 'activity-form-1',
    version: 1,
    statusCode: 'draft',
    workflowRevision: 7,
    schemaHash: null,
    fields: [
      {
        fieldCode: 'name',
        typeCode: 'short_text',
        label: '姓名',
        helpText: null,
        required: true,
        visibilityCode: 'self_only',
        exportable: false,
        sortOrder: 1,
        minValue: null,
        maxValue: null,
        minLength: 1,
        maxLength: 20,
        maxSelections: null,
        optionsJson: null,
      },
    ],
    ...overrides,
  };
}

function input(label = '姓名') {
  return {
    form: {
      fields: [
        {
          fieldCode: 'name',
          typeCode: 'short_text' as const,
          label,
          required: true,
          visibilityCode: 'self_only' as const,
          exportable: false,
          sortOrder: 1,
          minLength: 1,
          maxLength: 20,
        },
      ],
    },
  };
}

function harness(options: { existing?: Record<string, unknown> | null } = {}) {
  const existing = options.existing === undefined ? storedVersion() : options.existing;
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'activity-form-1' }]),
    activity: {
      findFirst: jest.fn().mockResolvedValue({ statusCode: 'draft', workflowRevision: 7 }),
    },
    registrationFormVersion: {
      findFirst: jest.fn().mockResolvedValue(existing),
      update: jest.fn().mockResolvedValue(storedVersion()),
      aggregate: jest.fn().mockResolvedValue({ _max: { version: 1 } }),
      create: jest.fn().mockResolvedValue(storedVersion({ id: 'form-version-2', version: 2 })),
    },
    registrationUploadSession: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    $transaction: jest.fn((callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new RegistrationFormVersionService(prisma as never, audit as never),
    tx,
    audit,
  };
}

describe('RegistrationFormVersionService', () => {
  it('makes a same canonical draft PUT a true no-op: no version write and no audit', async () => {
    const { service, tx, audit } = harness();

    await expect(service.putManaged('activity-form-1', input(), USER, META)).resolves.toEqual({
      version: 1,
      fields: expect.any(Array),
    });

    expect(tx.registrationFormVersion.update).not.toHaveBeenCalled();
    expect(tx.registrationFormVersion.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('retires a prior draft, allocates max(version)+1 under the root lock, and audits the real change', async () => {
    const { service, tx, audit } = harness();

    await service.putManaged('activity-form-1', input('新的题目'), USER, META);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.registrationFormVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'form-version-1' },
        data: expect.objectContaining({ statusCode: 'retired' }),
      }),
    );
    expect(tx.registrationFormVersion.aggregate).toHaveBeenCalledWith({
      where: { activityId: 'activity-form-1' },
      _max: { version: true },
    });
    expect(tx.registrationFormVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 2, statusCode: 'draft', schemaHash: null }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'draft-registration-form-update',
        formVersionId: 'form-version-2',
        tx,
      }),
    );
  });

  it('on a replacement approval, revokes old active sessions before retiring the old form and creating the next active version', async () => {
    const active = storedVersion({
      id: 'form-active-1',
      statusCode: 'active',
      schemaHash: 'a'.repeat(64),
      version: 4,
    });
    const { service, tx } = harness({ existing: active });
    tx.registrationFormVersion.findFirst.mockResolvedValue(active);
    tx.registrationFormVersion.aggregate.mockResolvedValue({ _max: { version: 4 } });
    tx.registrationFormVersion.create.mockResolvedValue(
      storedVersion({
        id: 'form-active-2',
        statusCode: 'active',
        schemaHash: 'b'.repeat(64),
        version: 5,
      }),
    );

    const result = await service.applyPublishedTarget(tx as never, {
      activityId: 'activity-form-1',
      requestType: 'change',
      target: {
        definition: {
          fields: [
            {
              ...storedVersion().fields[0],
              label: '审批替换',
              minValue: null,
              maxValue: null,
              options: null,
            },
          ],
        } as never,
        schemaHash: 'b'.repeat(64),
      },
      nextWorkflowRevision: 8,
      at: new Date('2099-01-01T00:00:00.000Z'),
    });

    expect(tx.registrationUploadSession.updateMany).toHaveBeenCalledWith({
      where: { formVersionId: 'form-active-1', statusCode: 'active' },
      data: { statusCode: 'revoked' },
    });
    expect(tx.registrationFormVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'form-active-1' },
        data: expect.objectContaining({ statusCode: 'retired' }),
      }),
    );
    expect(tx.registrationFormVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 5,
          statusCode: 'active',
          workflowRevision: 8,
          schemaHash: 'b'.repeat(64),
        }),
      }),
    );
    expect(result).toEqual({ formVersionId: 'form-active-2', version: 5, schemaHash: 'b'.repeat(64) });
  });

  it('activates the matching latest draft on initial approval with that approval workflow revision', async () => {
    const draft = storedVersion({ id: 'form-draft-1', version: 3, statusCode: 'draft' });
    const target = registrationFormDefinitionFromStoredFields(draft.fields as never);
    const { service, tx } = harness({ existing: null });
    tx.registrationFormVersion.findFirst.mockImplementation(async ({ where }: { where: { statusCode: string } }) =>
      where.statusCode === 'active' ? null : draft,
    );
    tx.registrationFormVersion.update.mockResolvedValue({
      id: draft.id,
      version: draft.version,
      schemaHash: target.schemaHash,
    });

    await expect(
      service.applyPublishedTarget(tx as never, {
        activityId: 'activity-form-1',
        requestType: 'initial',
        target: { definition: target.definition, schemaHash: target.schemaHash },
        nextWorkflowRevision: 8,
        at: new Date('2099-01-01T00:00:00.000Z'),
      }),
    ).resolves.toEqual({
      formVersionId: 'form-draft-1',
      version: 3,
      schemaHash: target.schemaHash,
    });

    expect(tx.registrationFormVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'form-draft-1' },
        data: expect.objectContaining({
          statusCode: 'active',
          workflowRevision: 8,
          schemaHash: target.schemaHash,
        }),
      }),
    );
    expect(tx.registrationFormVersion.create).not.toHaveBeenCalled();
    expect(tx.registrationUploadSession.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a same canonical active Form version and retires/revokes an explicit null target', async () => {
    const base = storedVersion({ id: 'form-active-1', version: 4, statusCode: 'active' });
    const target = registrationFormDefinitionFromStoredFields(base.fields as never);
    const active = { ...base, schemaHash: target.schemaHash };
    const { service, tx } = harness({ existing: active });
    tx.registrationFormVersion.findFirst.mockResolvedValue(active);

    await expect(
      service.applyPublishedTarget(tx as never, {
        activityId: 'activity-form-1',
        requestType: 'change',
        target: { definition: target.definition, schemaHash: target.schemaHash },
        nextWorkflowRevision: 8,
        at: new Date('2099-01-01T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ formVersionId: 'form-active-1', version: 4, schemaHash: target.schemaHash });
    expect(tx.registrationFormVersion.create).not.toHaveBeenCalled();
    expect(tx.registrationUploadSession.updateMany).not.toHaveBeenCalled();

    await expect(
      service.applyPublishedTarget(tx as never, {
        activityId: 'activity-form-1',
        requestType: 'change',
        target: null,
        nextWorkflowRevision: 9,
        at: new Date('2099-01-02T00:00:00.000Z'),
      }),
    ).resolves.toBeNull();
    expect(tx.registrationUploadSession.updateMany).toHaveBeenCalledWith({
      where: { formVersionId: 'form-active-1', statusCode: 'active' },
      data: { statusCode: 'revoked' },
    });
    expect(tx.registrationFormVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'form-active-1' },
        data: expect.objectContaining({ statusCode: 'retired' }),
      }),
    );
  });

  it('clones the source definition into target draft v1 with no active hash or source upload-session identity', async () => {
    const source = storedVersion({ activityId: 'source-activity', version: 8, statusCode: 'active' });
    const { service, tx } = harness({ existing: source });
    tx.registrationFormVersion.findFirst.mockResolvedValue(source);

    await service.cloneFromSource(
      tx as never,
      'source-activity',
      'published',
      'target-activity',
    );

    expect(tx.registrationFormVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activityId: 'source-activity', statusCode: 'active' },
      }),
    );
    expect(tx.registrationFormVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activityId: 'target-activity',
          version: 1,
          statusCode: 'draft',
          workflowRevision: 0,
          schemaHash: null,
        }),
      }),
    );
    expect(tx.registrationUploadSession.updateMany).not.toHaveBeenCalled();
  });
});
