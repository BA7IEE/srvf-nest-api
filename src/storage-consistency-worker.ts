import { NestFactory } from '@nestjs/core';

import { AttachmentStorageOrchestrator } from './modules/attachments/attachment-storage-orchestrator';
import { StorageConsistencyWorkerModule } from './modules/attachments/storage-consistency-worker.module';
import { StorageConsistencyWorker } from './modules/attachments/storage-consistency.worker';
import {
  STORAGE_OPERATION_KINDS,
  type StorageOperationKind,
} from './modules/storage/storage-consistency.types';
import { StorageObjectLedgerService } from './modules/storage/storage-object-ledger.service';
import type { StorageObjectLocator } from './modules/storage/storage.types';

interface WorkerCliArgs {
  once: boolean;
  strictGate: boolean;
  purgeReplays: boolean;
  objectKey?: string;
  kind?: StorageOperationKind;
  manualOnly: boolean;
  relocateOperationId?: string;
  attestAbsentOperationId?: string;
  operatorUserId?: string;
  reviewerUserId?: string;
  reasonCode?: string;
  evidenceRef?: string;
  verifiedAt?: Date;
  targetProvider?: 'COS' | 'LOCAL';
  targetBucket?: string;
  targetRegion?: string;
  targetLocalNamespace?: string;
}

async function bootstrap(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(StorageConsistencyWorkerModule);
  app.enableShutdownHooks();
  try {
    const ledger = app.get(StorageObjectLedgerService);
    const worker = app.get(StorageConsistencyWorker);
    const orchestrator = app.get(AttachmentStorageOrchestrator);

    if (args.strictGate) {
      await ledger.assertStrictStartGate();
      writeResult({ mode: 'strict-gate', passed: true });
      return;
    }
    if (args.purgeReplays) {
      const purgedReplaySnapshots = await ledger.purgeExpiredDeleteReplays();
      writeResult({ mode: 'purge-replays', purgedReplaySnapshots });
      return;
    }
    if (args.relocateOperationId) {
      const eventKey = await orchestrator.prepareManualRelocate({
        replayOperationId: args.relocateOperationId,
        operatorUserId: required(args.operatorUserId, 'operator-user-id'),
        reviewerUserId: required(args.reviewerUserId, 'reviewer-user-id'),
        reasonCode: required(args.reasonCode, 'reason-code'),
        evidenceRef: required(args.evidenceRef, 'evidence-ref'),
        verifiedAt: args.verifiedAt ?? new Date(),
        targetLocator: targetLocator(args),
      });
      await orchestrator.executeEventKey(eventKey);
      const operation = await ledger.findOperationByEventKey(eventKey);
      writeResult({ mode: 'manual-relocate', eventKey, status: operation?.status ?? 'unknown' });
      return;
    }
    if (args.attestAbsentOperationId) {
      const eventKey = await orchestrator.prepareManualAttestAbsent({
        replayOperationId: args.attestAbsentOperationId,
        operatorUserId: required(args.operatorUserId, 'operator-user-id'),
        reviewerUserId: required(args.reviewerUserId, 'reviewer-user-id'),
        reasonCode: required(args.reasonCode, 'reason-code'),
        evidenceRef: required(args.evidenceRef, 'evidence-ref'),
        verifiedAt: args.verifiedAt ?? new Date(),
      });
      await orchestrator.executeEventKey(eventKey);
      const operation = await ledger.findOperationByEventKey(eventKey);
      writeResult({
        mode: 'manual-attest-absent',
        eventKey,
        status: operation?.status ?? 'unknown',
      });
      return;
    }
    if (args.once) {
      const result = await worker.drainOnce({
        objectKey: args.objectKey,
        kind: args.kind,
        manualOnly: args.manualOnly,
      });
      writeResult({ mode: 'once', ...result });
      return;
    }
    if (args.objectKey || args.kind || args.manualOnly) {
      throw new Error('--key/--kind/--manual-only 只能与 --once 一起使用');
    }
    await worker.run();
  } finally {
    await app.close();
  }
}

function parseArgs(tokens: string[]): WorkerCliArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (const token of tokens) {
    if (!token.startsWith('--')) throw new Error('只接受 --name 或 --name=value 参数');
    const separator = token.indexOf('=');
    if (separator < 0) {
      switches.add(token.slice(2));
      continue;
    }
    const name = token.slice(2, separator);
    const value = token.slice(separator + 1);
    if (!value) throw new Error(`--${name} 不能为空`);
    values.set(name, value);
  }
  const allowedSwitches = new Set(['once', 'manual-only', 'strict-gate', 'purge-replays']);
  const allowedValues = new Set([
    'key',
    'kind',
    'relocate',
    'attest-absent',
    'operator-user-id',
    'reviewer-user-id',
    'reason-code',
    'evidence-ref',
    'verified-at',
    'target-provider',
    'target-bucket',
    'target-region',
    'target-local-namespace',
  ]);
  for (const name of switches) {
    if (!allowedSwitches.has(name)) throw new Error(`未知开关 --${name}`);
  }
  for (const name of values.keys()) {
    if (!allowedValues.has(name)) throw new Error(`未知参数 --${name}`);
  }

  const kindValue = values.get('kind');
  if (
    kindValue !== undefined &&
    !STORAGE_OPERATION_KINDS.includes(kindValue as StorageOperationKind)
  ) {
    throw new Error('--kind 不在允许集合中');
  }
  const provider = values.get('target-provider');
  if (provider !== undefined && provider !== 'COS' && provider !== 'LOCAL') {
    throw new Error('--target-provider 必须是 COS 或 LOCAL');
  }
  const verifiedAtRaw = values.get('verified-at');
  const verifiedAt = verifiedAtRaw ? new Date(verifiedAtRaw) : undefined;
  if (verifiedAt && Number.isNaN(verifiedAt.getTime())) throw new Error('--verified-at 无效');

  const args: WorkerCliArgs = {
    once: switches.has('once'),
    strictGate: switches.has('strict-gate'),
    purgeReplays: switches.has('purge-replays'),
    objectKey: values.get('key'),
    kind: kindValue as StorageOperationKind | undefined,
    manualOnly: switches.has('manual-only'),
    relocateOperationId: values.get('relocate'),
    attestAbsentOperationId: values.get('attest-absent'),
    operatorUserId: values.get('operator-user-id'),
    reviewerUserId: values.get('reviewer-user-id'),
    reasonCode: values.get('reason-code'),
    evidenceRef: values.get('evidence-ref'),
    verifiedAt,
    targetProvider: provider,
    targetBucket: values.get('target-bucket'),
    targetRegion: values.get('target-region'),
    targetLocalNamespace: values.get('target-local-namespace'),
  };
  const selectedModes = [
    args.once,
    args.strictGate,
    args.purgeReplays,
    Boolean(args.relocateOperationId),
    Boolean(args.attestAbsentOperationId),
  ].filter(Boolean).length;
  if (selectedModes > 1) throw new Error('worker mode 参数互斥');
  return args;
}

function targetLocator(args: WorkerCliArgs): StorageObjectLocator {
  const providerType = required(args.targetProvider, 'target-provider');
  if (providerType === 'COS') {
    return {
      providerType,
      bucket: required(args.targetBucket, 'target-bucket'),
      region: required(args.targetRegion, 'target-region'),
      localNamespace: null,
    };
  }
  return {
    providerType,
    bucket: null,
    region: null,
    localNamespace: required(args.targetLocalNamespace, 'target-local-namespace'),
  };
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`缺少 --${name}`);
  return value;
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

void bootstrap();
