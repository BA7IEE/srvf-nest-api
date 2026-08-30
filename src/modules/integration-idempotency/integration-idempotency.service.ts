import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { parseIdempotencyKey } from './idempotency-key.decorator';

declare const integrationOperationBrand: unique symbol;
export type IntegrationOperation = string & {
  readonly [integrationOperationBrand]: true;
};

export function defineIntegrationOperation<const Value extends string>(
  value: string extends Value ? never : Value,
): IntegrationOperation {
  if (!/^[a-z0-9][a-z0-9.-]{2,127}$/.test(value)) {
    throw new Error('Integration operation must be a server-owned lowercase constant');
  }
  return value as unknown as IntegrationOperation;
}

export type IntegrationCommandPrincipal =
  | {
      servicePrincipalId: string;
      credentialId: string;
      delegationGrantId?: null;
      subjectUserId?: null;
    }
  | {
      servicePrincipalId: string;
      credentialId: string;
      delegationGrantId: string;
      subjectUserId: string;
    };

export interface IntegrationCommandResult<T extends Prisma.InputJsonValue> {
  response: T;
  resourceType?: string | null;
  resourceId?: string | null;
}

export interface IntegrationIdempotencyResult<T extends Prisma.InputJsonValue> {
  response: T;
  replayed: boolean;
}

type PrismaTx = Prisma.TransactionClient;

/**
 * Serializes one `(servicePrincipalId, operation, idempotencyKey)` inside the
 * same PostgreSQL transaction that owns the future domain command and receipt.
 */
@Injectable()
export class IntegrationIdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async execute<T extends Prisma.InputJsonValue>(input: {
    principal: IntegrationCommandPrincipal;
    operation: IntegrationOperation;
    idempotencyKey: string;
    request: Prisma.InputJsonValue;
    command: (tx: PrismaTx) => Promise<IntegrationCommandResult<T>>;
  }): Promise<IntegrationIdempotencyResult<T>> {
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const requestHash = hashRequest(input.principal, input.request);
    const lockKey = JSON.stringify([
      input.principal.servicePrincipalId,
      input.operation,
      idempotencyKey,
    ]);

    return this.prisma.$transaction(async (tx) => {
      // The explicit ::text cast is intentional: it fixes PostgreSQL overload
      // resolution and matches the repository's established advisory-lock form.
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`,
      );

      const existing = await tx.integrationCommandReceipt.findUnique({
        where: {
          servicePrincipalId_operation_idempotencyKey: {
            servicePrincipalId: input.principal.servicePrincipalId,
            operation: input.operation,
            idempotencyKey,
          },
        },
        select: { requestHash: true, responseSnapshot: true },
      });
      if (existing !== null) {
        if (existing.requestHash !== requestHash) {
          throw new BizException(BizCode.IDEMPOTENCY_KEY_CONFLICT);
        }
        if (existing.responseSnapshot === null) {
          throw new Error('Integration receipt is missing its replay snapshot');
        }
        assertSafeSnapshot(existing.responseSnapshot);
        return { response: existing.responseSnapshot as T, replayed: true };
      }

      const result = await input.command(tx);
      assertSafeSnapshot(result.response);
      await tx.integrationCommandReceipt.create({
        data: {
          servicePrincipalId: input.principal.servicePrincipalId,
          credentialId: input.principal.credentialId,
          delegationGrantId: input.principal.delegationGrantId ?? null,
          subjectUserId: input.principal.subjectUserId ?? null,
          operation: input.operation,
          idempotencyKey,
          requestHash,
          resourceType: result.resourceType ?? null,
          resourceId: result.resourceId ?? null,
          responseSnapshot: result.response,
        },
      });
      return { response: result.response, replayed: false };
    });
  }
}

function hashRequest(
  principal: IntegrationCommandPrincipal,
  request: Prisma.InputJsonValue,
): string {
  // Grant/subject are part of request semantics; credential deliberately is
  // not, so rotating a credential does not create a second idempotency domain.
  const canonical = canonicalJson({
    delegationGrantId: principal.delegationGrantId ?? null,
    subjectUserId: principal.subjectUserId ?? null,
    request,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Integration request contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      // Default code-unit ordering is deterministic across process locales.
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Integration request is not JSON-serializable');
}

const SENSITIVE_SNAPSHOT_KEY =
  /(authorization|password|token|secret|credentialsecret|signed.?url|idcard|identitycard|phone|mobile|subjectuser|username|userid|member|realname|fullname|nickname|email|address|openid|unionid|passport|birthdate|nationality)/i;

function assertSafeSnapshot(value: unknown, path = 'responseSnapshot'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeSnapshot(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') throw new Error(`${path} is not JSON-serializable`);
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_SNAPSHOT_KEY.test(key)) {
      throw new Error(`${path} contains a forbidden sensitive field`);
    }
    assertSafeSnapshot(item, `${path}.${key}`);
  }
}
