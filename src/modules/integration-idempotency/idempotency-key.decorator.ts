import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? undefined : value;
  if (candidate === undefined || !IDEMPOTENCY_KEY_PATTERN.test(candidate)) {
    throw new BizException(BizCode.BAD_REQUEST);
  }
  return candidate;
}

/** Required on every Integration write route; never substituted with x-request-id. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return parseIdempotencyKey(request.headers['idempotency-key']);
  },
);
