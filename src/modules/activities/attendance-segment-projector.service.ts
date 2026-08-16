import { Injectable } from '@nestjs/common';

import {
  rebuildServiceSegments,
  type ProjectorPunchEvent,
  type SegmentProjection,
  type SessionThresholds,
} from './settlement-segment-projector';

// Public, dependency-free façade for the established v1.1 projector. Attendances may consume this
// public ActivitiesModule contract, but may not deep-import the projector implementation.
@Injectable()
export class AttendanceSegmentProjectorService {
  rebuild(events: ProjectorPunchEvent[], thresholds: SessionThresholds): SegmentProjection {
    return rebuildServiceSegments(events, thresholds);
  }
}
