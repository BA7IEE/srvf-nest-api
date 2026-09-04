import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

/** Pure policy. Incident/safety governance has not authorized any emergency -> formal transition. */
export function assertEmergencyFormalPublicationAllowed(
  emergencyOrigin: { id: string } | null,
): void {
  if (emergencyOrigin !== null) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
}
