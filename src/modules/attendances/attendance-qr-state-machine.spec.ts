import {
  isAttendanceQrAction,
  isAttendanceQrUsable,
  nextAttendanceQrCredentialVersion,
} from './attendance-qr-state-machine';

describe('attendance QR state machine', () => {
  it('accepts only the two frozen QR action codes and increments version monotonically', () => {
    expect(isAttendanceQrAction('check_in')).toBe(true);
    expect(isAttendanceQrAction('check_out')).toBe(true);
    expect(isAttendanceQrAction('staff_scan')).toBe(false);
    expect(nextAttendanceQrCredentialVersion(null)).toBe(1);
    expect(nextAttendanceQrCredentialVersion(7)).toBe(8);
  });

  it('mutation: active status alone is insufficient outside its inclusive session window', () => {
    const from = new Date('2099-12-15T08:00:00.000Z');
    const until = new Date('2099-12-15T08:30:00.000Z');
    expect(isAttendanceQrUsable('active', from, until, from)).toBe(true);
    expect(isAttendanceQrUsable('active', from, until, until)).toBe(true);
    expect(isAttendanceQrUsable('active', from, until, new Date(until.getTime() + 1))).toBe(false);
    expect(isAttendanceQrUsable('revoked', from, until, from)).toBe(false);
  });
});
