import { createHash } from 'node:crypto';

export type AttendancePunchEventType =
  | 'check_in'
  | 'check_out'
  | 'early_departure_close'
  | 'void'
  | 'replace';

export type AttendancePunchSourceCode =
  | 'self_qr'
  | 'staff_scan'
  | 'proxy'
  | 'bulk'
  | 'import'
  | 'offline'
  | 'correction';

export interface AttendancePunchRequestHashInput {
  operatorUserId: string;
  memberId: string;
  participationIdentityId: string;
  activityId: string;
  sessionId: string;
  positionId: string | null;
  eventTypeCode: AttendancePunchEventType;
  sourceCode: AttendancePunchSourceCode;
  deviceId: string | null;
  occurredAt: Date;
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
  qrCredentialVersion: number | null;
  supersedesEventId: string | null;
  reason: string | null;
}

export interface ManagedOnlineAttendancePunchRequestHashInput {
  activityId: string;
  sessionId: string;
  actorUserId: string;
  participationIdentityId: string;
  actionCode: 'check_in' | 'check_out';
  sourceCode: 'staff_scan' | 'proxy' | 'bulk' | 'import';
  eventKey: string;
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
  reason: string | null;
  /**
   * 仅 B6 import 允许的已冻结 CSV 历史发生时间。工作人员实时入口绝不能把调用方时间
   * 混入摘要或写入事件；缺失 / 非法 import 时间由命令层 fail-closed。
   */
  occurredAt?: Date | null;
}

export function normalizeAttendancePunchReason(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length === 0 ? null : normalized;
}

function decimal(value: number | null, digits: number): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new Error('attendance punch location is not finite');
  return value.toFixed(digits);
}

export function createAttendancePunchRequestHash(input: AttendancePunchRequestHashInput): string {
  if (!Number.isFinite(input.occurredAt.getTime())) {
    throw new Error('attendance punch occurredAt is invalid');
  }
  const payload = JSON.stringify({
    v: 'attendance-punch-request/v1',
    operatorUserId: input.operatorUserId,
    memberId: input.memberId,
    participationIdentityId: input.participationIdentityId,
    activityId: input.activityId,
    sessionId: input.sessionId,
    positionId: input.positionId,
    eventTypeCode: input.eventTypeCode,
    sourceCode: input.sourceCode,
    deviceId: input.deviceId,
    occurredAt: input.occurredAt.toISOString(),
    location: {
      longitude: decimal(input.longitude, 7),
      latitude: decimal(input.latitude, 7),
      accuracy: decimal(input.accuracy, 2),
    },
    qrCredentialVersion: input.qrCredentialVersion,
    supersedesEventId: input.supersedesEventId,
    reason: normalizeAttendancePunchReason(input.reason),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * 第 6 批工作人员在线写入的合同化 hash。它与 B5 本人扫码的历史 hash 刻意分开：
 * B6 的重放锚点是客户端 eventKey，不把服务端发生时间混入同一请求的语义摘要。
 */
export function createManagedOnlineAttendancePunchRequestHash(
  input: ManagedOnlineAttendancePunchRequestHashInput,
): string {
  const importOccurredAt =
    input.sourceCode === 'import' ? canonicalImportOccurredAt(input.occurredAt) : undefined;
  const payload = JSON.stringify({
    v: 'attendance-managed-online-punch-request/v1',
    activityId: input.activityId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    participationIdentityId: input.participationIdentityId,
    actionCode: input.actionCode,
    sourceCode: input.sourceCode,
    eventKey: input.eventKey,
    reason: normalizeAttendancePunchReason(input.reason),
    location: {
      longitude: decimal(input.longitude, 7),
      latitude: decimal(input.latitude, 7),
      accuracy: decimal(input.accuracy, 2),
    },
    ...(importOccurredAt === undefined ? {} : { occurredAt: importOccurredAt }),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function canonicalImportOccurredAt(value: Date | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value.getTime())) {
    throw new Error('attendance import occurredAt is invalid');
  }
  return value.toISOString();
}
