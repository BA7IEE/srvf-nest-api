import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { JwtConfig } from '../../config/jwt.config';
import {
  ATTENDANCE_MEMBER_CREDENTIAL_TTL_MS,
  signAttendanceMemberCredential,
  verifyAttendanceMemberCredential,
  type AttendanceMemberCredentialPayload,
} from './attendance-member-credential-token';

type QrCodeEncoder = {
  toString(
    value: string,
    options: { type: 'svg'; errorCorrectionLevel: 'M'; margin: number },
  ): Promise<string>;
};

// qrcode is already the B5 binary-rendering dependency; this keeps the B6 self credential on the
// identical protected SVG path instead of exposing a JSON token surface.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qrCode = require('qrcode') as QrCodeEncoder;

@Injectable()
export class AttendanceMemberCredentialService {
  private readonly jwtSecret: string;

  constructor(config: ConfigService) {
    const jwt = config.get<JwtConfig>('jwt');
    if (!jwt) throw new Error('jwt.config 未加载');
    this.jwtSecret = jwt.secret;
  }

  async renderSvg(currentUser: CurrentUserPayload): Promise<string> {
    if (currentUser.memberId === null) throw new BizException(BizCode.FORBIDDEN);
    const issuedAt = new Date();
    const token = signAttendanceMemberCredential(
      {
        userId: currentUser.id,
        memberId: currentUser.memberId,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + ATTENDANCE_MEMBER_CREDENTIAL_TTL_MS),
      },
      this.jwtSecret,
    );
    return qrCode.toString(token, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  }

  verify(token: string): AttendanceMemberCredentialPayload {
    return verifyAttendanceMemberCredential(token, this.jwtSecret);
  }

  verifyAt(token: string, authoritativeDeviceTime: Date): AttendanceMemberCredentialPayload {
    return verifyAttendanceMemberCredential(token, this.jwtSecret, authoritativeDeviceTime);
  }
}
