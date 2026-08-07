import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import {
  AppRegistrationUploadAttachmentDto,
  AppRegistrationUploadSessionActivityParamsDto,
  AppRegistrationUploadSessionCreatedDto,
  AppRegistrationUploadSessionFileParamsDto,
} from '../dto/app/app-registration-upload-session.dto';
import { RegistrationUploadSessionService } from '../registration-upload-session.service';

type MultipartUploadFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

@ApiTags('Mobile - Activity Registration Upload Sessions')
@ApiBearerAuth()
@Controller('app/v1/activities')
export class AppRegistrationUploadSessionsController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly sessions: RegistrationUploadSessionService,
  ) {}

  @Post(':activityId/registration-upload-sessions')
  @ApiOperation({
    summary:
      'App 创建一次性报名附件上传会话；原始 token 仅本次返回，不签发 Provider upload URL [auth]',
  })
  @ApiWrappedCreatedResponse(AppRegistrationUploadSessionCreatedDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION,
    BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    BizCode.ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED,
    BizCode.ACTIVITY_ENDED_REGISTRATION_FORBIDDEN,
    BizCode.ATTACHMENT_NOT_FOUND,
  )
  async create(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppRegistrationUploadSessionActivityParamsDto,
  ): Promise<AppRegistrationUploadSessionCreatedDto> {
    return this.sessions.create(params.activityId, user, await this.resolveMemberId(user));
  }

  @Post(':activityId/registration-upload-sessions/:sessionId/files')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['token', 'file'],
      properties: {
        token: { type: 'string', description: '创建会话响应中仅返回一次的原始 token' },
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG/PNG/WebP/PDF，单文件不超过 10 MiB；后端中转，不返回 signed URL',
        },
      },
    },
  })
  @ApiOperation({
    summary:
      'App 后端中转上传一次性报名附件；token/session/route/member/form/expiry 不匹配统一 13001 [auth]',
  })
  @ApiWrappedOkResponse(AppRegistrationUploadAttachmentDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_NOT_FOUND,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH,
    BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED,
    BizCode.ATTACHMENT_PII_DETECTED,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
  )
  async upload(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppRegistrationUploadSessionFileParamsDto,
    @Body('token') token: string | undefined,
    @UploadedFile() file: MultipartUploadFile | undefined,
    @Req() req: Request,
  ): Promise<AppRegistrationUploadAttachmentDto> {
    if (!file || typeof token !== 'string') throw new BizException(BizCode.BAD_REQUEST);
    return this.sessions.upload({
      activityId: params.activityId,
      sessionId: params.sessionId,
      token,
      file: {
        originalName: file.originalname,
        mime: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      },
      user,
      memberId: await this.resolveMemberId(user),
      auditMeta: this.auditMeta(req),
    });
  }

  private async resolveMemberId(user: CurrentUserPayload): Promise<string> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
    return access.member.id;
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
