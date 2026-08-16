export type AttendanceQrCredentialStatus = 'active' | 'revoked' | 'expired';

export function isAttendanceQrAction(value: string): value is 'check_in' | 'check_out' {
  return value === 'check_in' || value === 'check_out';
}

export function isAttendanceQrUsable(
  statusCode: string,
  validFrom: Date,
  validUntil: Date,
  now: Date,
): boolean {
  return (
    statusCode === 'active' &&
    validFrom.getTime() <= now.getTime() &&
    now.getTime() <= validUntil.getTime()
  );
}

export function nextAttendanceQrCredentialVersion(currentMaxVersion: number | null): number {
  if (currentMaxVersion === null) return 1;
  if (!Number.isSafeInteger(currentMaxVersion) || currentMaxVersion < 1) {
    throw new Error('attendance QR credential version is corrupted');
  }
  return currentMaxVersion + 1;
}
