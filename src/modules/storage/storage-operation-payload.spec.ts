import { Role } from '@prisma/client';

import {
  STORAGE_OPERATION_PAYLOAD_VERSION,
  StorageConsistencyInvariantError,
} from './storage-consistency.types';
import { parseStorageOperationPayload } from './storage-operation-payload';

describe('parseStorageOperationPayload', () => {
  const deletePayload = {
    response: null,
    audit: {
      actorUserId: 'user_0001',
      actorRoleSnap: Role.ADMIN,
      scope: 'other',
      deletedByPath: 'admin',
      requestId: 'request-1',
      ip: null,
      ua: null,
    },
  } as const;

  it('rejects a string that is not a generated Prisma Role value', () => {
    // Mutation killed: `typeof actorRoleSnap === string` followed by `as Role`.
    expect(() =>
      parseStorageOperationPayload('attachment_delete', STORAGE_OPERATION_PAYLOAD_VERSION, {
        ...deletePayload,
        audit: { ...deletePayload.audit, actorRoleSnap: 'ROOT_OPERATOR' },
      }),
    ).toThrow(StorageConsistencyInvariantError);
  });

  it('accepts each generated Prisma Role value', () => {
    for (const actorRoleSnap of Object.values(Role)) {
      expect(
        parseStorageOperationPayload('attachment_delete', STORAGE_OPERATION_PAYLOAD_VERSION, {
          ...deletePayload,
          audit: { ...deletePayload.audit, actorRoleSnap },
        }),
      ).toMatchObject({ audit: { actorRoleSnap } });
    }
  });

  it('requires two distinct people for manual evidence', () => {
    const payload = {
      operatorUserId: 'operator_1',
      reviewerUserId: 'operator_1',
      reasonCode: 'provider_recovery',
      evidenceRef: 'OPS-1234',
      verifiedAt: '2026-07-19T00:00:00.000Z',
    };

    expect(() =>
      parseStorageOperationPayload(
        'manual_attest_absent',
        STORAGE_OPERATION_PAYLOAD_VERSION,
        payload,
      ),
    ).toThrow(/operator and reviewer must be different/);
  });

  it('requires an internal ticket id for manual evidence', () => {
    expect(() =>
      parseStorageOperationPayload('manual_attest_absent', STORAGE_OPERATION_PAYLOAD_VERSION, {
        operatorUserId: 'operator_1',
        reviewerUserId: 'reviewer_1',
        reasonCode: 'provider_recovery',
        evidenceRef: 'https://external.example/evidence',
        verifiedAt: '2026-07-19T00:00:00.000Z',
      }),
    ).toThrow(/internal ticket id/);
  });
});
