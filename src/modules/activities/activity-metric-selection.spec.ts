import {
  parseActivityMetricSelection,
  parseActivityMetricSelectionReceipt,
  metricSelectionColumns,
  readActivityMetricSelection,
} from './activity-metric-selection';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { OrganizationStatus, Role, UserStatus, type Prisma } from '@prisma/client';
import { BizException } from '../../common/exceptions/biz.exception';
import type { ActivityAccessService } from './activity-access.service';
import type { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityMetricSelectionAccess } from './activity-metric-selection-access';
const pointer = {
  id: 'set',
  code: 'metric_set',
  version: 1,
  schemaVersion: 1,
  definitionHash: 'a'.repeat(64),
};
describe('C1 D2b exact selection grammar', () => {
  it.each([
    { metricRequirementCode: 'not_required', metricSetPointer: null },
    { metricRequirementCode: 'required', metricSetPointer: pointer },
  ])('accepts explicit selection %#', (value) =>
    expect(parseActivityMetricSelection(value)).toEqual(value),
  );
  it.each([
    null,
    {},
    { metricRequirementCode: 'unconfigured', metricSetPointer: null },
    { metricRequirementCode: 'not_required' },
    { metricRequirementCode: 'not_required', metricSetPointer: pointer },
    { metricRequirementCode: 'required', metricSetPointer: null },
    { metricRequirementCode: 'not_required', metricSetPointer: null, operationKey: 'extra' },
    ...[0, -1, 1.5, 2147483648, '1'].map((version) => ({
      metricRequirementCode: 'required',
      metricSetPointer: { ...pointer, version },
    })),
    ...[null, '', 'A'.repeat(64)].map((definitionHash) => ({
      metricRequirementCode: 'required',
      metricSetPointer: { ...pointer, definitionHash },
    })),
  ])('rejects malformed or ambiguous selection %#', (value) =>
    expect(() => parseActivityMetricSelection(value)).toThrow(TypeError),
  );
  it('defaults only persisted old rows to unconfigured', () => {
    expect(
      readActivityMetricSelection(
        {
          metricRequirementCode: null,
          selectedMetricSetVersionId: null,
          selectedMetricSetDefinitionHash: null,
          metricSelectionRevision: 0,
        },
        null,
      ),
    ).toBeNull();
    expect(
      metricSelectionColumns({ metricRequirementCode: 'not_required', metricSetPointer: null }),
    ).toEqual({
      metricRequirementCode: 'not_required',
      selectedMetricSetVersionId: null,
      selectedMetricSetDefinitionHash: null,
      metricSelectionRevision: 1,
    });
  });
  it('rejects revision overflow, mismatched receipt targets and extra receipt fields', () => {
    const receipt = {
      activityId: 'activity',
      metricRequirementCode: 'not_required',
      metricSetPointer: null,
      metricSelectionRevision: 1,
    };
    expect(parseActivityMetricSelectionReceipt(receipt, 'activity')).toEqual(receipt);
    for (const value of [
      { ...receipt, metricSelectionRevision: 2147483648 },
      { ...receipt, activityId: 'other' },
      { ...receipt, secret: 'not-allowed' },
    ]) {
      try {
        parseActivityMetricSelectionReceipt(value, 'activity');
        throw new Error('accepted invalid receipt');
      } catch (error) {
        expect(error).toMatchObject({ biz: BizCode.ACTIVITY_METRIC_SELECTION_RECEIPT_INVALID });
      }
    }
  });
  it('rejects getters without executing them', () => {
    const getter = jest.fn();
    expect(() =>
      parseActivityMetricSelection(
        Object.defineProperty({ metricSetPointer: null }, 'metricRequirementCode', {
          enumerable: true,
          get: getter,
        }),
      ),
    ).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('C1 D2b A7 organization eligibility characterization', () => {
  const actor = {
    id: 'actor',
    username: 'actor',
    memberId: null,
    role: Role.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
  };
  function setup() {
    const organization = jest
      .fn<
        Promise<{ parentId: string | null; status: OrganizationStatus } | null>,
        [Prisma.OrganizationFindFirstArgs]
      >()
      .mockResolvedValue({ parentId: 'parent', status: OrganizationStatus.ACTIVE });
    const identity = jest.fn().mockResolvedValue(actor);
    const assertCanOrThrow = jest.fn().mockResolvedValue(undefined);
    const resolveInitiator = jest.fn().mockResolvedValue('requested');
    const tx = { user: { findFirst: identity }, organization: { findFirst: organization } };
    const client = tx as unknown as Prisma.TransactionClient;
    const access = new ActivityMetricSelectionAccess(
      undefined!,
      { assertCanOrThrow } as unknown as ActivityAccessService,
      { resolveInitiator } as unknown as ActivityInitiationPolicy,
    );
    const run = () => access.authorizeCreation(client, actor, 'admin', 'org', undefined, false);
    return { access, client, run, organization, identity, assertCanOrThrow, resolveInitiator };
  }
  it('keeps the A7 initiator empty and reads the organization after current identity and permission', async () => {
    const { run, organization, identity, assertCanOrThrow, resolveInitiator, client } = setup();
    await expect(run()).resolves.toEqual({ actor, initiatorMemberId: undefined });
    expect(resolveInitiator).not.toHaveBeenCalled();
    expect(organization).toHaveBeenCalledTimes(1);
    expect(organization).toHaveBeenCalledWith({
      where: { id: 'org', deletedAt: null },
      select: { status: true, parentId: true },
    });
    expect(assertCanOrThrow).toHaveBeenCalledWith(
      actor,
      'activity.create.record',
      undefined,
      client,
    );
    expect(identity.mock.invocationCallOrder[0]).toBeLessThan(
      assertCanOrThrow.mock.invocationCallOrder[0],
    );
    expect(assertCanOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      organization.mock.invocationCallOrder[0],
    );
  });
  it.each([
    [null, BizCode.ORGANIZATION_NOT_FOUND],
    [{ parentId: 'parent', status: OrganizationStatus.INACTIVE }, BizCode.ORGANIZATION_INACTIVE],
    [{ parentId: null, status: OrganizationStatus.INACTIVE }, BizCode.ORGANIZATION_INACTIVE],
    [
      { parentId: null, status: OrganizationStatus.ACTIVE },
      BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    ],
  ] as const)('preserves the rejection and inactive-before-root order %#', async (row, biz) => {
    const { run, organization } = setup();
    organization.mockResolvedValue(row);
    await expect(run()).rejects.toMatchObject({ biz });
  });
  it('rejects a missing current actor before permission or organization reads', async () => {
    const { run, identity, assertCanOrThrow, organization } = setup();
    identity.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ biz: BizCode.UNAUTHORIZED });
    expect(assertCanOrThrow).not.toHaveBeenCalled();
    expect(organization).not.toHaveBeenCalled();
  });
  it('rejects missing creation permission before the organization read', async () => {
    const { run, assertCanOrThrow, organization } = setup();
    assertCanOrThrow.mockRejectedValue(new BizException(BizCode.RBAC_FORBIDDEN));
    await expect(run()).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(organization).not.toHaveBeenCalled();
  });
  it('does not translate an unknown database failure into an eligibility error', async () => {
    const { run, organization } = setup();
    const failure = new Error('database unavailable');
    organization.mockRejectedValue(failure);
    await expect(run()).rejects.toBe(failure);
  });
  it('leaves the required-initiator branch on its original policy and caller transaction', async () => {
    const { access, client, resolveInitiator, organization } = setup();
    await expect(
      access.authorizeCreation(client, actor, 'admin', 'org', 'requested'),
    ).resolves.toEqual({
      actor,
      initiatorMemberId: 'requested',
    });
    expect(resolveInitiator).toHaveBeenCalledWith(actor, 'org', 'requested', client);
    expect(organization).not.toHaveBeenCalled();
  });
});
