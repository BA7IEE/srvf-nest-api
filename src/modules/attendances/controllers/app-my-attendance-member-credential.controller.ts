import { Controller, Header, Post, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Readable } from 'node:stream';

import { CurrentUser, type CurrentUserPayload } from '../../../common/decorators/current-user.decorator';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AttendanceMemberCredentialService } from '../attendance-member-credential.service';

@ApiTags('Mobile - My Attendance Member Credential')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyAttendanceMemberCredentialController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly credentials: AttendanceMemberCredentialService,
  ) {}

  @Post('attendance-member-credential/render')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '生成本人短时可信成员凭证 SVG；不返回 JSON token [auth]' })
  @ApiProduces('image/svg+xml')
  @ApiResponse({
    status: 201,
    description: '不可缓存的 SVG 二维码二进制内容，不使用 JSON envelope',
    content: { 'image/svg+xml': { schema: { type: 'string', format: 'binary' } } },
  })
  async render(
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
    const svg = await this.credentials.renderSvg(user);
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return new StreamableFile(Readable.from(svg));
  }
}
