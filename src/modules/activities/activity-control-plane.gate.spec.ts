import type { ConfigType } from '@nestjs/config';
import type appConfig from '../../config/app.config';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityControlPlaneGate } from './activity-control-plane.gate';

it('reads the current assembled mode on every call and never retains prior availability', () => {
  const config = { activityOsControlPlane: { mode: 'off' } } as ConfigType<typeof appConfig>;
  const gate = new ActivityControlPlaneGate(config);
  expect(gate.status()).toEqual({ mode: 'off', creationAvailability: 'unavailable' });
  expect(() => gate.assertCreationAvailable()).toThrow(
    new BizException(BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE),
  );
  config.activityOsControlPlane.mode = 'shadow';
  expect(gate.status()).toEqual({ mode: 'shadow', creationAvailability: 'pilot' });
  expect(() => gate.assertCreationAvailable()).not.toThrow();
  config.activityOsControlPlane.mode = 'active';
  expect(gate.status()).toEqual({ mode: 'active', creationAvailability: 'enabled' });
  expect(() => gate.assertCreationAvailable()).not.toThrow();
  config.activityOsControlPlane.mode = 'off';
  expect(() => gate.assertCreationAvailable()).toThrow(
    new BizException(BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE),
  );
});
