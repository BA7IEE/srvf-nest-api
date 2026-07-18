import { NestFactory } from '@nestjs/core';

import { parseStorageConsistencyWorkerArgs } from './storage-consistency-worker';

const RECOVERY_EVIDENCE = [
  '--operator-user-id=operator-1',
  '--reviewer-user-id=reviewer-1',
  '--reason-code=reviewed-recovery',
  '--evidence-ref=OPS-1234',
  '--verified-at=2026-07-19T08:00:00.000Z',
] as const;

const RELOCATE_COS = [
  '--relocate=operation-dead-1',
  ...RECOVERY_EVIDENCE,
  '--target-provider=COS',
  '--target-bucket=reviewed-bucket',
  '--target-region=ap-guangzhou',
] as const;

const ATTEST_ABSENT = ['--attest-absent=operation-dead-2', ...RECOVERY_EVIDENCE] as const;

describe('storage consistency worker CLI parser', () => {
  let createApplicationContext: jest.SpiedFunction<typeof NestFactory.createApplicationContext>;

  beforeEach(() => {
    createApplicationContext = jest.spyOn(NestFactory, 'createApplicationContext');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['purge + key', ['--purge-replays', '--key=attachments/test/object.jpg']],
    ['strict + kind', ['--strict-gate', '--kind=attachment_delete']],
    ['once + recovery evidence', ['--once', '--operator-user-id=operator-1']],
    ['relocate + selector', [...RELOCATE_COS, '--key=attachments/test/object.jpg']],
    ['attest + target locator', [...ATTEST_ABSENT, '--target-provider=LOCAL']],
    ['mutually exclusive modes', ['--once', '--purge-replays']],
    [
      'relocate missing required evidence',
      RELOCATE_COS.filter((arg) => !arg.startsWith('--verified-at=')),
    ],
  ])('rejects %s before Nest application context creation', (_label, tokens) => {
    expect(() => parseStorageConsistencyWorkerArgs(tokens)).toThrow();
    expect(createApplicationContext).not.toHaveBeenCalled();
  });

  it('parses legal daemon and once modes', () => {
    expect(parseStorageConsistencyWorkerArgs([])).toMatchObject({
      once: false,
      strictGate: false,
      purgeReplays: false,
      manualOnly: false,
    });
    expect(
      parseStorageConsistencyWorkerArgs([
        '--once',
        '--key=attachments/test/object.jpg',
        '--kind=attachment_delete',
        '--manual-only',
      ]),
    ).toMatchObject({
      once: true,
      objectKey: 'attachments/test/object.jpg',
      kind: 'attachment_delete',
      manualOnly: true,
    });
  });

  it('parses legal global gate and purge modes without selectors', () => {
    expect(parseStorageConsistencyWorkerArgs(['--strict-gate'])).toMatchObject({
      strictGate: true,
    });
    expect(parseStorageConsistencyWorkerArgs(['--purge-replays'])).toMatchObject({
      purgeReplays: true,
    });
  });

  it('parses legal relocate and attest-absent recovery modes', () => {
    expect(parseStorageConsistencyWorkerArgs(RELOCATE_COS)).toMatchObject({
      relocateOperationId: 'operation-dead-1',
      operatorUserId: 'operator-1',
      reviewerUserId: 'reviewer-1',
      reasonCode: 'reviewed-recovery',
      evidenceRef: 'OPS-1234',
      verifiedAt: new Date('2026-07-19T08:00:00.000Z'),
      targetProvider: 'COS',
      targetBucket: 'reviewed-bucket',
      targetRegion: 'ap-guangzhou',
    });
    expect(parseStorageConsistencyWorkerArgs(ATTEST_ABSENT)).toMatchObject({
      attestAbsentOperationId: 'operation-dead-2',
      operatorUserId: 'operator-1',
      reviewerUserId: 'reviewer-1',
      verifiedAt: new Date('2026-07-19T08:00:00.000Z'),
    });
  });
});
