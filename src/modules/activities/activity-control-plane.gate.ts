import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import appConfig from '../../config/app.config';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AppActivityControlPlaneStatusDto } from './dto/app/app-managed-activity-control-plane.dto';

/** Only the B6 draft creation control plane. Never decides permissions or publication. */
@Injectable()
export class ActivityControlPlaneGate {
  constructor(@Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>) {}

  status(): AppActivityControlPlaneStatusDto {
    switch (this.config.activityOsControlPlane.mode) {
      case 'shadow':
        return { mode: 'shadow', creationAvailability: 'pilot' };
      case 'active':
        return { mode: 'active', creationAvailability: 'enabled' };
      default:
        return { mode: 'off', creationAvailability: 'unavailable' };
    }
  }

  assertCreationAvailable(): void {
    if (this.status().creationAvailability === 'unavailable') {
      throw new BizException(BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE);
    }
  }
}
