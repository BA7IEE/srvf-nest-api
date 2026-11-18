import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { LoginResponseDto } from './auth.dto';

const H5_REFRESH_COOKIE = '__Host-srvf_h5_refresh';
const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
};

export class H5SessionResponseDto {
  @ApiProperty({ description: 'Short-lived JWT access token for Authorization: Bearer' })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Access token lifetime as configured', example: '15m' })
  expiresIn!: string;
}

export function requireSameOriginH5(req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  const { host, origin, 'sec-fetch-site': fetchSite } = req.headers;
  // Use the preserved Host, not X-Forwarded-Host. Express only accepts proxy HTTPS
  // metadata from a trusted direct peer; that peer must overwrite X-Forwarded-Proto.
  if (
    !req.secure ||
    !host ||
    origin !== `https://${host}` ||
    (fetchSite !== undefined && fetchSite !== 'same-origin')
  ) {
    throw new BizException(BizCode.FORBIDDEN);
  }
}

export function h5ThrottleKey(handler: 'login' | 'refresh') {
  return (context: ExecutionContext, tracker: string, name: string): string => {
    const http = context.switchToHttp();
    requireSameOriginH5(http.getRequest<Request>(), http.getResponse<Response>());
    // Match the existing @nestjs/throttler key so a second transport does not
    // double the password or refresh attempt budget. Reject before incrementing.
    return createHash('sha256')
      .update(`${context.getClass().name}-${handler}-${name}-${tracker}`)
      .digest('hex');
  };
}

export function sendH5Session(res: Response, session: LoginResponseDto): H5SessionResponseDto {
  res.cookie(H5_REFRESH_COOKIE, session.refreshToken, {
    ...COOKIE_OPTIONS,
    expires: new Date(session.refreshExpiresAt),
  });
  return {
    accessToken: session.accessToken,
    tokenType: session.tokenType,
    expiresIn: session.expiresIn,
  };
}

export function readH5RefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  let value: string | null = null;
  for (const entry of header.split(';')) {
    const [name, ...parts] = entry.trim().split('=');
    if (name !== H5_REFRESH_COOKIE) continue;
    const raw = parts.join('=');
    // Only accept the generated base64url shape; reject ambiguous duplicates.
    if (value !== null || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    value = raw;
  }
  return value;
}

export function clearH5RefreshCookie(res: Response): void {
  res.clearCookie(H5_REFRESH_COOKIE, COOKIE_OPTIONS);
}
