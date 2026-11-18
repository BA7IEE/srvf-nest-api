import { toMemberLabelFields } from '../../common/identity/member-label.util';
import type { SettlementReviewResultRow } from './settlement-review-query.service';
import type { AdminSettlementFrozenResultDto } from './dto/admin/admin-settlement-read.dto';

export function presentSettlementReviewResult(
  row: SettlementReviewResultRow,
): Omit<
  AdminSettlementFrozenResultDto,
  | 'timeResultState'
  | 'timeBuckets'
  | 'contributionResultState'
  | 'nativeCalculatedContributionPoints'
  | 'nativeRecognizedContributionPoints'
> {
  return {
    id: row.id,
    participationIdentityId: row.participationIdentityId,
    revision: row.revision,
    resultCode: row.resultCode,
    lateFlag: row.lateFlag,
    earlyLeaveFlag: row.earlyLeaveFlag,
    recognizedServiceHours: row.recognizedServiceHours.toFixed(2),
    calculatedServiceHours: row.calculatedServiceHours.toFixed(2),
    recognizedContributionPoints: row.recognizedContributionPoints.toFixed(2),
    calculatedContributionPoints: row.calculatedContributionPoints.toFixed(2),
    hasAdjustment: row.adjustmentReason !== null,
    member: { id: row.identity.member.id, ...toMemberLabelFields(row.identity.member) },
    session: row.identity.session,
  };
}
