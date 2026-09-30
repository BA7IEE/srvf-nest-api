import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { JwtStrategy, type JwtPayload } from './strategies/jwt.strategy';

/** Command identity only: business authorization must still run under the caller's locks. */
@Injectable()
export class AuthHumanCommandIdentityService {
  constructor(
    private readonly jwt: JwtService,
    private readonly strategy: JwtStrategy,
  ) {}

  async authenticate(accessToken: string): Promise<CurrentUserPayload> {
    try {
      if (!accessToken || accessToken !== accessToken.trim()) throw new Error('invalid credential');
      const payload = await this.jwt.verifyAsync<JwtPayload & { exp?: unknown; iat?: unknown }>(
        accessToken,
        { algorithms: ['HS256'], ignoreExpiration: false },
      );
      if (
        typeof payload.sub !== 'string' ||
        payload.sub.length === 0 ||
        typeof payload.username !== 'string' ||
        payload.username.length === 0 ||
        !Number.isSafeInteger(payload.exp) ||
        !Number.isSafeInteger(payload.iat)
      )
        throw new Error('invalid credential');
      // Reuse the existing per-call ACTIVE / not-deleted lookup, but only AFTER verification.
      return await this.strategy.validate({ sub: payload.sub, username: payload.username });
    } catch {
      // Never preserve JWT library errors, input credentials or user details in the public error.
      throw new BizException(BizCode.UNAUTHORIZED);
    }
  }
}
