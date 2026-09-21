import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { canonicalize } from './settlement-content-hash';
import type {
  ParticipationTimeSourceCategory,
  ParticipationTimeTruthItem,
  ParticipationTimeTruthSet,
} from './participation-time-truth-query.service';

export const PARTICIPATION_TIME_PROOF_VERSION = 1;
export const PARTICIPATION_TIME_PROOF_PROVENANCE = 'database_cutover_root_binding_v1';

export interface ParticipationTimeProofResponse {
  proofVersion: 1;
  cutoverReceiptId: string;
  cutoverAt: string;
  asOf: string;
  memberId: string;
  dateFrom: string;
  dateTo: string;
  legacyRecognizedSeconds: number;
  volunteerServiceSeconds: number;
  trainingSeconds: number;
  organizationSeconds: number;
  nonCreditableSeconds: number;
  eligibleServiceSeconds: number;
  proofSetHash: string;
  isPubliclyVerifiable: false;
  provenance: typeof PARTICIPATION_TIME_PROOF_PROVENANCE;
  items: ParticipationTimeTruthItem[];
  total: number;
  page: number;
  pageSize: number;
}

function sumCategory(
  items: readonly ParticipationTimeTruthItem[],
  category: ParticipationTimeSourceCategory,
): number {
  const total = items
    .filter((item) => item.sourceCategoryCode === category)
    .reduce((sum, item) => sum + item.recognizedSeconds, 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('invalid proof total');
  return total;
}

@Injectable()
export class ParticipationTimeProofPresenter {
  present(input: {
    memberId: string;
    dateFrom: string;
    dateTo: string;
    page: number;
    pageSize: number;
    truth: ParticipationTimeTruthSet;
  }): ParticipationTimeProofResponse {
    const legacyRecognizedSeconds = sumCategory(input.truth.items, 'legacy_recognized_service');
    const volunteerServiceSeconds = sumCategory(input.truth.items, 'volunteer_service');
    const trainingSeconds = sumCategory(input.truth.items, 'training');
    const organizationSeconds = sumCategory(input.truth.items, 'organization');
    const nonCreditableSeconds = sumCategory(input.truth.items, 'non_creditable');
    const eligibleServiceSeconds = legacyRecognizedSeconds + volunteerServiceSeconds;
    if (!Number.isSafeInteger(eligibleServiceSeconds))
      throw new RangeError('invalid eligible total');
    const totals = {
      legacyRecognizedSeconds,
      volunteerServiceSeconds,
      trainingSeconds,
      organizationSeconds,
      nonCreditableSeconds,
      eligibleServiceSeconds,
    };
    const proofSetHash = createHash('sha256')
      .update(
        canonicalize({
          domain: 'participation-time-proof-set-v1',
          proofVersion: PARTICIPATION_TIME_PROOF_VERSION,
          cutoverReceiptId: input.truth.receipt.id,
          cutoverAt: input.truth.receipt.cutoverAt,
          memberId: input.memberId,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          ...totals,
          isPubliclyVerifiable: false,
          provenance: PARTICIPATION_TIME_PROOF_PROVENANCE,
          items: input.truth.items.map((item) => ({ ...item })),
        }),
        'utf8',
      )
      .digest('hex');
    const offset = (input.page - 1) * input.pageSize;
    return {
      proofVersion: PARTICIPATION_TIME_PROOF_VERSION,
      cutoverReceiptId: input.truth.receipt.id,
      cutoverAt: input.truth.receipt.cutoverAt,
      asOf: input.truth.asOf,
      memberId: input.memberId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      ...totals,
      proofSetHash,
      isPubliclyVerifiable: false,
      provenance: PARTICIPATION_TIME_PROOF_PROVENANCE,
      items: input.truth.items.slice(offset, offset + input.pageSize),
      total: input.truth.items.length,
      page: input.page,
      pageSize: input.pageSize,
    };
  }
}
