import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppActivityRegistrationCommandDto } from '../dto/app/app-activity-registration-command.dto';
import {
  AppActivityRegistrationCommandParamsDto,
  AppActivityRegistrationCommandReceiptDto,
} from '../dto/app/create-app-activity-registration.dto';
import { RegistrationCommandService } from '../registration-command.service';

@ApiTags('Mobile - Activity Registrations')
@ApiBearerAuth()
@Controller('app/v1/activities')
export class AppActivityRegistrationsController {
  constructor(private readonly registrationCommand: RegistrationCommandService) {}

  @Post(':activityId/registrations')
  @ApiOperation({
    summary:
      '本人提交或审批前重提报名主链；请求含 operationKey、冻结表单答案与有序场次岗位志愿 [auth]',
  })
  @ApiWrappedCreatedResponse(AppActivityRegistrationCommandReceiptDto)
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
    BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
    BizCode.REGISTRATION_FORM_VERSION_INVALID,
    BizCode.REGISTRATION_FORM_ANSWER_INVALID,
    BizCode.ATTACHMENT_NOT_FOUND,
  )
  submit(
    @Param() params: AppActivityRegistrationCommandParamsDto,
    @Body() dto: AppActivityRegistrationCommandDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityRegistrationCommandReceiptDto> {
    return this.registrationCommand.submit(
      params.activityId,
      dto,
      currentUser,
      this.auditMeta(req),
    );
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
