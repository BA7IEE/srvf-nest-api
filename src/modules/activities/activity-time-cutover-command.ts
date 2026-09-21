import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ActivityTimeCutoverReceipt, Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { RbacService } from '../permissions/rbac.service';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { canonicalize } from './settlement-content-hash';

export const ACTIVITY_TIME_CUTOVER_RECEIPT_ID = 'activity-time-v1';
export const ACTIVITY_TIME_CUTOVER_FORMAT_VERSION = 1;
export const ACTIVITY_TIME_CUTOVER_PERMISSION = 'activity.settlement-final-review.record';

export interface ActivityTimeCutoverRequest {
  operationKey: string;
  deployedMainSha: string;
  evidenceBundleHash: string;
}

export interface NormalizedActivityTimeCutoverRequest extends ActivityTimeCutoverRequest {
  actorUserId: string;
  requestHash: string;
}

export interface ActivityTimeCutoverReceiptResult {
  id: typeof ACTIVITY_TIME_CUTOVER_RECEIPT_ID;
  operationKey: string;
  deployedMainSha: string;
  evidenceBundleHash: string;
  actorUserId: string;
  cutoverAt: string;
  formatVersion: typeof ACTIVITY_TIME_CUTOVER_FORMAT_VERSION;
  contentHash: string;
  replayed: boolean;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    [...value].length > maximum ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
      );
    })
  ) {
    throw new TypeError('cutover text is invalid');
  }
  return value;
}

function lowercaseHash(value: unknown, length: 40 | 64): string {
  const hash = boundedText(value, length);
  if (hash.length !== length || !/^[a-f0-9]+$/u.test(hash)) {
    throw new TypeError('cutover hash is invalid');
  }
  return hash;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

export function activityTimeCutoverRequestHash(input: {
  actorUserId: string;
  operationKey: string;
  deployedMainSha: string;
  evidenceBundleHash: string;
}): string {
  return sha256(
    canonicalize({
      domain: 'activity-time-cutover-request-v1',
      schemaVersion: 1,
      actorUserId: input.actorUserId,
      operationKey: input.operationKey,
      deployedMainSha: input.deployedMainSha,
      evidenceBundleHash: input.evidenceBundleHash,
    }),
  );
}

export function normalizeActivityTimeCutoverRequest(
  actorUserId: string,
  input: ActivityTimeCutoverRequest,
): NormalizedActivityTimeCutoverRequest {
  try {
    const normalized = {
      actorUserId: boundedText(actorUserId, 64),
      operationKey: boundedText(input.operationKey, 128),
      deployedMainSha: lowercaseHash(input.deployedMainSha, 40),
      evidenceBundleHash: lowercaseHash(input.evidenceBundleHash, 64),
    };
    return { ...normalized, requestHash: activityTimeCutoverRequestHash(normalized) };
  } catch (error) {
    if (error instanceof TypeError) {
      throw new BizException(BizCode.ACTIVITY_TIME_CUTOVER_INVALID);
    }
    throw error;
  }
}

export function activityTimeCutoverReceiptPayload(receipt: {
  id: string;
  operationKey: string;
  requestHash: string;
  deployedMainSha: string;
  evidenceBundleHash: string;
  actorUserId: string;
  cutoverAt: Date | string;
  formatVersion: number;
}): string {
  const cutoverAt =
    receipt.cutoverAt instanceof Date
      ? receipt.cutoverAt.toISOString()
      : new Date(receipt.cutoverAt).toISOString();
  return [
    'activity-time-cutover-receipt-v1',
    lengthPrefixed(receipt.id),
    lengthPrefixed(receipt.operationKey),
    lengthPrefixed(receipt.requestHash),
    lengthPrefixed(receipt.deployedMainSha),
    lengthPrefixed(receipt.evidenceBundleHash),
    lengthPrefixed(receipt.actorUserId),
    lengthPrefixed(cutoverAt),
    lengthPrefixed(String(receipt.formatVersion)),
  ].join('|');
}

export function activityTimeCutoverReceiptHash(
  receipt: Parameters<typeof activityTimeCutoverReceiptPayload>[0],
): string {
  return sha256(activityTimeCutoverReceiptPayload(receipt));
}

export function verifyActivityTimeCutoverReceipt(
  receipt: ActivityTimeCutoverReceipt,
): ActivityTimeCutoverReceiptResult {
  try {
    if (
      receipt.id !== ACTIVITY_TIME_CUTOVER_RECEIPT_ID ||
      receipt.formatVersion !== ACTIVITY_TIME_CUTOVER_FORMAT_VERSION ||
      lowercaseHash(receipt.requestHash, 64) !== receipt.requestHash ||
      lowercaseHash(receipt.deployedMainSha, 40) !== receipt.deployedMainSha ||
      lowercaseHash(receipt.evidenceBundleHash, 64) !== receipt.evidenceBundleHash ||
      lowercaseHash(receipt.contentHash, 64) !== receipt.contentHash ||
      activityTimeCutoverReceiptHash(receipt) !== receipt.contentHash
    ) {
      throw new TypeError('cutover receipt integrity mismatch');
    }
    return {
      id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
      operationKey: boundedText(receipt.operationKey, 128),
      deployedMainSha: receipt.deployedMainSha,
      evidenceBundleHash: receipt.evidenceBundleHash,
      actorUserId: boundedText(receipt.actorUserId, 64),
      cutoverAt: receipt.cutoverAt.toISOString(),
      formatVersion: ACTIVITY_TIME_CUTOVER_FORMAT_VERSION,
      contentHash: receipt.contentHash,
      replayed: false,
    };
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new BizException(BizCode.ACTIVITY_TIME_CUTOVER_RECEIPT_INVALID);
    }
    throw error;
  }
}

@Injectable()
export class ActivityTimeCutoverCommand {
  constructor(private readonly rbac: RbacService) {}

  async lockAndAuthorize(
    tx: Prisma.TransactionClient,
    currentUser: CurrentUserPayload,
  ): Promise<CurrentUserPayload> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "User" WHERE id = ${currentUser.id} FOR UPDATE
    `;
    if (locked.length !== 1) throw new BizException(BizCode.UNAUTHORIZED);

    const actor = await loadActiveUserIdentityInTx(tx, currentUser.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    const explicit = await this.rbac.getUserPermissionCodes(actor.id, undefined, tx);
    if (
      !explicit.has(ACTIVITY_TIME_CUTOVER_PERMISSION) ||
      !(await this.rbac.can(actor, ACTIVITY_TIME_CUTOVER_PERMISSION, undefined, tx))
    ) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
    return actor;
  }
}
