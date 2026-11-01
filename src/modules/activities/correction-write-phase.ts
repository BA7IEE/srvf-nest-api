import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export type CorrectionWritePhase = 'prepare' | 'commit';

interface PhaseReceipt {
  applicationId: string;
  phase: string;
  batchId: string;
  state: string;
  protocolVersion: number;
}

function assertPhaseReceipt(
  rows: PhaseReceipt[],
  applicationId: string,
  phase: CorrectionWritePhase,
  state: 'OPEN' | 'SEALED',
): void {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0] === null ||
    typeof rows[0] !== 'object' ||
    rows[0].applicationId !== applicationId ||
    rows[0].phase !== phase ||
    rows[0].state !== state ||
    rows[0].protocolVersion !== 1 ||
    typeof rows[0].batchId !== 'string' ||
    rows[0].batchId.length === 0
  ) {
    throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
  }
}

/** Database-owned protocol. No timeout, authorization flag or cached validation
 * result can be supplied by the caller. Missing SQL functions fail normally;
 * there is deliberately no fallback to an unguarded write path.
 */
export async function beginCorrectionWritePhase(
  tx: Prisma.TransactionClient,
  applicationId: string,
  phase: CorrectionWritePhase,
): Promise<void> {
  const rows = await tx.$queryRaw<PhaseReceipt[]>`
    SELECT * FROM public.r5_correction_begin_phase(${applicationId}::text, ${phase}::text)
  `;
  assertPhaseReceipt(rows, applicationId, phase, 'OPEN');
}

/** Sealing closes writes. It does not certify validity: deferred database
 * constraints still perform fresh complete checks before the transaction commits.
 */
export async function sealCorrectionWritePhase(
  tx: Prisma.TransactionClient,
  applicationId: string,
  phase: CorrectionWritePhase,
): Promise<void> {
  const rows = await tx.$queryRaw<PhaseReceipt[]>`
    SELECT * FROM public.r5_correction_seal_phase(${applicationId}::text, ${phase}::text)
  `;
  assertPhaseReceipt(rows, applicationId, phase, 'SEALED');
}

/** PROPOSED ISOLATED EXPERIMENT ONLY. The matching database implementation and
 * permission package must pass the finite safety/semantic suite before use.
 * There is no application flag or fallback that grants the private writer role.
 */
export async function materializeCorrectionWritePhase(
  tx: Prisma.TransactionClient,
  applicationId: string,
  actorUserId: string,
  expectedBatchId: string,
  expectedSegmentCount: number,
): Promise<number> {
  if (
    !applicationId ||
    !actorUserId ||
    !expectedBatchId ||
    !Number.isSafeInteger(expectedSegmentCount) ||
    expectedSegmentCount < 1
  ) {
    throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
  }
  const rows = await tx.$queryRaw<
    {
      application_id: string;
      batch_id: string;
      source_count: number;
      segment_count: number;
      allocation_count: number;
      slice_count: number;
      evidence_count: number;
      receipt_count: number;
      binding_count: number;
      state: string;
    }[]
  >`
    SELECT * FROM public.r5_correction_materialize_phase(
      ${applicationId}::text, ${actorUserId}::text
    )
  `.catch(rethrowMaterializationError);
  if (!Array.isArray(rows)) {
    throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.application_id !== applicationId ||
    row.state !== 'MATERIALIZED' ||
    row.batch_id !== expectedBatchId ||
    !Number.isSafeInteger(row.source_count) ||
    row.source_count < 1 ||
    row.segment_count !== expectedSegmentCount ||
    row.source_count < row.segment_count ||
    row.allocation_count !== row.segment_count ||
    row.receipt_count !== row.segment_count ||
    row.binding_count !== row.source_count ||
    !Number.isSafeInteger(row.slice_count) ||
    row.slice_count < 0 ||
    !Number.isSafeInteger(row.evidence_count) ||
    row.evidence_count < 0
  ) {
    throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
  }
  return row.segment_count;
}

function rethrowMaterializationError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
    if (error.meta?.code === 'P5B01') {
      throw new BizException(BizCode.CORRECTION_BASE_VERSION_CHANGED);
    }
    if (error.meta?.code === 'P5C01') {
      throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
    }
  }
  throw error;
}
