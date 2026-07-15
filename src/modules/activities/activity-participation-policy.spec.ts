import { BizCode } from '../../common/exceptions/biz-code.constant';
import { ActivityParticipationPolicy } from './activity-participation-policy';

const NOW = new Date('2026-07-15T12:00:00.000Z');
const FUTURE = new Date('2026-07-16T12:00:00.000Z');
const PAST = new Date('2026-07-14T12:00:00.000Z');

describe('ActivityParticipationPolicy', () => {
  const policy = new ActivityParticipationPolicy();
  const published = {
    statusCode: 'published',
    isPublicRegistration: true,
    registrationDeadline: FUTURE,
    endAt: FUTURE,
  };

  it('canRegisterSelf: published + public + within time allows; invite-only rejects', () => {
    expect(policy.canRegisterSelf(published, NOW)).toEqual({ allowed: true });
    expect(policy.canRegisterSelf({ ...published, isPublicRegistration: false }, NOW)).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION,
    });
  });

  it('canRegisterByAdmin: invite-only still allows; draft rejects', () => {
    expect(policy.canRegisterByAdmin({ ...published, isPublicRegistration: false }, NOW)).toEqual({
      allowed: true,
    });
    expect(policy.canRegisterByAdmin({ ...published, statusCode: 'draft' }, NOW)).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    });
  });

  it('registration deadline/end gates and approve end gate use one policy', () => {
    expect(policy.canRegisterSelf({ ...published, registrationDeadline: PAST }, NOW)).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED,
    });
    expect(policy.canRegisterByAdmin({ ...published, endAt: PAST }, NOW)).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_ENDED_REGISTRATION_FORBIDDEN,
    });
    expect(policy.canApprove({ statusCode: 'published', endAt: PAST }, NOW)).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN,
    });
  });

  it('canSubmitAttendance: only published/completed allow', () => {
    expect(policy.canSubmitAttendance({ statusCode: 'published' })).toEqual({ allowed: true });
    expect(policy.canSubmitAttendance({ statusCode: 'completed' })).toEqual({ allowed: true });
    expect(policy.canSubmitAttendance({ statusCode: 'draft' })).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    });
    expect(policy.canSubmitAttendance({ statusCode: 'cancelled' })).toEqual({
      allowed: false,
      biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    });
  });
});
