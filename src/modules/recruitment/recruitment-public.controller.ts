import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RecruitmentThrottle } from '../../common/decorators/recruitment-throttle.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ID_CARD_IMAGE_MAX_BYTES } from './recruitment.constants';
import {
  RecruitmentApplicationProgressDto,
  RecruitmentSubmitResultDto,
  RecruitmentOcrRecognizeResponseDto,
  RecruitmentQueryByPhoneDto,
  RecruitmentQueryDto,
  RecruitmentRebindPhoneDto,
  RecruitmentRebindWechatDto,
  RecruitmentSendCodeDto,
  RecruitmentSendCodeResponseDto,
  RecruitmentSubmitPayloadDto,
  RecruitmentTodoItemDto,
  RecruitmentVerifyCodeDto,
  RecruitmentVerifyCodeResponseDto,
} from './recruitment.dto';
import {
  RecruitmentApplicationsService,
  type UploadedImageFile,
} from './recruitment-applications.service';
import { RecruitmentIdentityService } from './recruitment-identity.service';

// 招新一期 T3(2026-06-18):公开报名 surface(评审稿 §3.2 端点 4-5)。
//
// **surface 首用**:`open/v1/*` = 无账号公开前缀(api-surface-policy §0「预留→首用」;
// AGENTS §9/§21)。@Public 跳过 JwtAuthGuard;@RecruitmentThrottle 第 9 throttler 'recruitment'
// 按 IP 限流(默认 10/3600)。报名 = multipart/form-data(分叉③:证件照走文件,payload 走 JSON 串)。
//
// **校验顺序冻结见 service §4**:免费校验(校验位/年龄/code2session/去重)→ 最后才调付费实名核验。
// 敏感字段(姓名/身份证号/手机)仅入库,**永不**进出参/日志明文。

// 公开 surface 无登录用户,审计 actor 置空;仅记 requestId/ip/ua(沿 D6 v1.1 §11.2)
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// multipart 的 payload 字段 = RecruitmentSubmitPayloadDto 的 JSON 串;手动 parse + class-validator
// 校验(全局 ValidationPipe 只认 application/json body,multipart 内嵌 JSON 需本地校验);失败 → 40000
async function parseSubmitPayload(
  payloadJson: string | undefined,
): Promise<RecruitmentSubmitPayloadDto> {
  if (typeof payloadJson !== 'string' || payloadJson.length === 0) {
    throw new BizException(BizCode.BAD_REQUEST);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    throw new BizException(BizCode.BAD_REQUEST);
  }
  const dto = plainToInstance(RecruitmentSubmitPayloadDto, raw);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    throw new BizException(BizCode.BAD_REQUEST);
  }
  return dto;
}

@ApiTags('Public - Recruitment')
@ApiExtraModels(
  RecruitmentSubmitResultDto,
  RecruitmentApplicationProgressDto,
  RecruitmentTodoItemDto,
  RecruitmentOcrRecognizeResponseDto,
  RecruitmentSendCodeResponseDto,
  RecruitmentVerifyCodeResponseDto,
)
@Controller('open/v1/recruitment')
export class RecruitmentPublicController {
  constructor(
    private readonly service: RecruitmentApplicationsService,
    private readonly identity: RecruitmentIdentityService,
  ) {}

  @Public()
  @RecruitmentThrottle()
  @Post('applications')
  // 证件照大小闸下沉到 multer 解析层:超 5MB 在落盘/入内存阶段即 413 拒,
  // 不再先全量 buffer 进内存才在 service 校验(F-1 防内存 DoS;系统性审查 §4)。
  @UseInterceptors(
    FileInterceptor('idCardImage', { limits: { fileSize: ID_CARD_IMAGE_MAX_BYTES, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['payload', 'idCardImage'],
      properties: {
        payload: {
          type: 'string',
          description:
            'RecruitmentSubmitPayloadDto 的 JSON 串(realName/idCardNumber/…;身份链 wechatCode〔小程序〕或 phoneVerificationToken〔H5,verify-code 所发〕至少二选一)',
        },
        idCardImage: { type: 'string', format: 'binary', description: '证件照(jpeg/png ≤5MB)' },
      },
    },
  })
  @ApiOperation({
    summary:
      '公开报名提交(无账号;multipart:payload JSON 串 + idCardImage 文件;身份链 wechatCode〔小程序〕或 phoneVerificationToken〔H5 验码令牌〕至少二选一,S4a;免费校验通过后才调付费 OCR;大陆证件 OCR 匹配+防伪+清晰→发临时编号,否则/其余证件→人工待核;OCR 改造后提交端对 OCR 永不硬报错,通道未配/上游失败均转人工;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentSubmitResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.RECRUITMENT_CYCLE_NOT_OPEN,
    BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL,
    BizCode.RECRUITMENT_AGE_OUT_OF_RANGE,
    BizCode.RECRUITMENT_DUPLICATE_APPLICATION,
    BizCode.RECRUITMENT_ID_CARD_IMAGE_REQUIRED,
    // F3(#399):紧急联系人 relation 字典码校验(报名侧;与 promote 一致)
    BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID,
    // S4a:H5 phoneVerificationToken 无效/过期/已用(分叉前 fail-fast)
    BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID,
    // OCR 改造:提交端不再外抛 27030/27031(转 manual_review,分叉③);仅识别端点浮现
    BizCode.TOO_MANY_REQUESTS,
  )
  async submit(
    @Body('payload') payloadJson: string | undefined,
    @UploadedFile() image: UploadedImageFile | undefined,
    @Req() req: Request,
  ): Promise<RecruitmentSubmitResultDto> {
    const dto = await parseSubmitPayload(payloadJson);
    return this.service.submit(dto, image, buildAuditMeta(req), new Date());
  }

  @Public()
  @RecruitmentThrottle()
  @Post('applications/recognize')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('idCardImage', { limits: { fileSize: ID_CARD_IMAGE_MAX_BYTES, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['documentTypeCode', 'idCardImage'],
      properties: {
        documentTypeCode: {
          type: 'string',
          description:
            '证件类型(mainland_id/passport/hk_macau_permit 走 OCR;其余返 ocrSupported:false)',
        },
        idCardImage: { type: 'string', format: 'binary', description: '证件照(jpeg/png ≤5MB)' },
      },
    },
  })
  @ApiOperation({
    summary:
      '公开证件 OCR 识别预填(无账号;multipart:documentTypeCode + idCardImage;OCR 回填姓名/证件号供申请人确认/修正;无状态不落库;非 OCR 类型→ocrSupported:false;不清晰→clarityOk:false;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentOcrRecognizeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.RECRUITMENT_CYCLE_NOT_OPEN,
    BizCode.RECRUITMENT_ID_CARD_IMAGE_REQUIRED,
    // 识别端点浮现 OCR 通道错误供前端提示(提交端则转人工不外抛,分叉③)
    BizCode.REALNAME_CHANNEL_NOT_CONFIGURED,
    BizCode.REALNAME_API_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  recognize(
    @Body('documentTypeCode') documentTypeCode: string | undefined,
    @UploadedFile() image: UploadedImageFile | undefined,
    @Req() req: Request,
  ): Promise<RecruitmentOcrRecognizeResponseDto> {
    if (typeof documentTypeCode !== 'string' || documentTypeCode.length === 0) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return this.service.recognize(documentTypeCode, image, buildAuditMeta(req));
  }

  @Public()
  @RecruitmentThrottle()
  @Post('applications/query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '公开查询本人报名进度(凭新 wx.login code 换 openid;返回本人最近一条进度模型:业务态 stage + 字典文案 + 门槛 todoList 真投影 + 临时编号 + 轮次通知;无匹配→28002;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationProgressDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.TOO_MANY_REQUESTS,
  )
  query(@Body() dto: RecruitmentQueryDto): Promise<RecruitmentApplicationProgressDto> {
    return this.service.query(dto.wechatCode);
  }

  // ============ 招新四期 S4a:H5 + 手机身份链(评审稿 §3;无账号 pre-auth 自助)============

  @Public()
  @RecruitmentThrottle()
  @Post('identity/send-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'H5 报名前手机发码(无账号;SmsPurpose=RECRUITMENT_BIND;无 open 轮→28030;手机维度 60s 间隔/10 条日限〔跨 purpose 合计〕+ throttler recruitment 双层兜底) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentSendCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.RECRUITMENT_CYCLE_NOT_OPEN,
    BizCode.SMS_SEND_INTERVAL_LIMIT,
    BizCode.SMS_PHONE_DAILY_LIMIT,
    BizCode.SMS_CHANNEL_NOT_CONFIGURED,
    BizCode.SMS_SEND_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  sendCode(
    @Body() dto: RecruitmentSendCodeDto,
    @Req() req: Request,
  ): Promise<RecruitmentSendCodeResponseDto> {
    return this.identity.sendCode(dto.phone, req.ip ?? null);
  }

  @Public()
  @RecruitmentThrottle()
  @Post('identity/verify-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'H5 报名前验码 → 发短时一次性身份令牌(无账号;验码成功落会话行 + 返 phoneVerificationToken〔30min 内随报名提交出示,明文仅一次性返回〕;码错/过期/超次统一 24010;无 open 轮→28030;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentVerifyCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.RECRUITMENT_CYCLE_NOT_OPEN,
    BizCode.SMS_CODE_INVALID,
    BizCode.TOO_MANY_REQUESTS,
  )
  verifyCode(@Body() dto: RecruitmentVerifyCodeDto): Promise<RecruitmentVerifyCodeResponseDto> {
    return this.identity.verifyCode(dto, new Date());
  }

  @Public()
  @RecruitmentThrottle()
  @Post('applications/query-by-phone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '公开查询本人报名进度②(手机+验证码;无账号;验码消费一码 → 手机定位最近一条报名进度模型,与微信 code 查询同出参/同派生口径;码错→24010 / 无匹配→28002;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationProgressDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_CODE_INVALID,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.TOO_MANY_REQUESTS,
  )
  queryByPhone(
    @Body() dto: RecruitmentQueryByPhoneDto,
  ): Promise<RecruitmentApplicationProgressDto> {
    return this.identity.queryByPhone(dto.phone, dto.code);
  }

  @Public()
  @RecruitmentThrottle()
  @Post('applications/rebind-wechat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '自助换微信换绑(无账号;当前手机验码校验本人 → code2session 新微信 → 更 application.openid;返更新后进度模型;码错→24010 / 无报名→28002 / 新微信已绑本轮他人报名→28051;审计 rebind-wechat;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationProgressDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_CODE_INVALID,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.RECRUITMENT_WECHAT_ALREADY_BOUND,
    BizCode.TOO_MANY_REQUESTS,
  )
  rebindWechat(
    @Body() dto: RecruitmentRebindWechatDto,
    @Req() req: Request,
  ): Promise<RecruitmentApplicationProgressDto> {
    return this.identity.rebindWechat(dto, buildAuditMeta(req));
  }

  @Public()
  @RecruitmentThrottle()
  @Post('applications/rebind-phone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '自助换手机换绑(无账号;双验:当前手机验码校验本人 + 新手机验码;更 application.phone + 换绑历史追加;返更新后进度模型;码错→24010 / 无报名→28002 / 新旧手机相同→40000;审计 rebind-phone;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationProgressDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_CODE_INVALID,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.TOO_MANY_REQUESTS,
  )
  rebindPhone(
    @Body() dto: RecruitmentRebindPhoneDto,
    @Req() req: Request,
  ): Promise<RecruitmentApplicationProgressDto> {
    return this.identity.rebindPhone(dto, buildAuditMeta(req), new Date());
  }
}
