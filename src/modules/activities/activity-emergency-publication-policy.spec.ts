import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { assertEmergencyFormalPublicationAllowed } from './activity-emergency-publication-policy';

describe('B6 emergency formal publication policy', () => {
  it('leaves ordinary activities to their existing publication rules', () => {
    expect(() => assertEmergencyFormalPublicationAllowed(null)).not.toThrow();
  });
  it('rejects an emergency origin unconditionally, regardless of follow-up completion', () => {
    expect(() => assertEmergencyFormalPublicationAllowed({ id: 'emergency-1' })).toThrow(
      new BizException(BizCode.ACTIVITY_STATUS_INVALID),
    );
  });
});
