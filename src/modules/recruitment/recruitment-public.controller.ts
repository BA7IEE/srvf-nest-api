import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
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
import {
  CERTIFICATE_IMAGES_MAX_PER_CATEGORY,
  ID_CARD_IMAGE_MAX_BYTES,
} from './recruitment.constants';
import {
  PublicRecruitmentPublicityItemDto,
  PublicRecruitmentPublicityResponseDto,
  RecruitmentApplicationProgressDto,
  RecruitmentCertificateUploadDto,
  RecruitmentCertificateUploadResultDto,
  RecruitmentOcrCardWarningsDto,
  RecruitmentOcrDetailDto,
  RecruitmentOcrFieldDto,
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
  RecruitmentWithdrawDto,
} from './recruitment.dto';
import {
  RecruitmentApplicationsService,
  type UploadedImageFile,
} from './recruitment-applications.service';
import { RecruitmentApplicationsQueryService } from './recruitment-applications-query.service';
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
  // OCR 鉴伪版充分利用:recognize 响应嵌套 DTO(显式注册,确保进 components.schemas)
  RecruitmentOcrDetailDto,
  RecruitmentOcrFieldDto,
  RecruitmentOcrCardWarningsDto,
  RecruitmentSendCodeResponseDto,
  RecruitmentVerifyCodeResponseDto,
  // 十项收口刀F:公开公示名单 DTO
  PublicRecruitmentPublicityItemDto,
  PublicRecruitmentPublicityResponseDto,
)
@Controller('open/v1/recruitment')
export class RecruitmentPublicController {
  constructor(
    private readonly service: RecruitmentApplicationsService,
    private readonly identity: RecruitmentIdentityService,
    // 十项收口刀F:公开公示名单复用 admin 预览同一取数内核(公示=实发)
    private readonly queryService: RecruitmentApplicationsQueryService,
  ) {}

  // ============ 十项收口刀F:公开公示名单(view-publicity 悬空动作收口)============
  @Public()
  @RecruitmentThrottle()
  @Get('publicity')
  @ApiOperation({
    summary:
      '公开公示名单(无账号;当前公示中轮次的姓名+拟发编号,与后台预览/实发同源推算;无公示中名单返回 cycleYear=null + 空 items;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(PublicRecruitmentPublicityResponseDto)
  publicity(): Promise<PublicRecruitmentPublicityResponseDto> {
    return this.queryService.publicPublicityList();
  }

  @Public()
  @RecruitmentThrottle()
  @Post('applications')
  // 证件照大小闸下沉到 multer 解析层:超 5MB 在落盘/入内存阶段即 413 拒,
  // 不再先全量 buffer 进内存才在 service 校验(F-1 防内存 DoS;系统性审查 §4)。
  // 签名图文件位 signatureImage 必填(FileFields 双具名位;每文件仍 5MB 上限,总数 ≤2)。
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'idCardImage', maxCount: 1 },
        { name: 'signatureImage', maxCount: 1 },
      ],
      { limits: { fileSize: ID_CARD_IMAGE_MAX_BYTES, files: 2 } },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['payload', 'idCardImage', 'signatureImage'],
      properties: {
        payload: {
          type: 'string',
          description:
            'RecruitmentSubmitPayloadDto 的 JSON 串(realName/idCardNumber/…;身份链 wechatCode〔小程序〕或 phoneVerificationToken〔H5,verify-code 所发〕至少二选一;⚠️ F5 起必含 privacyConsentAccepted=true)',
        },
        idCardImage: { type: 'string', format: 'binary', description: '证件照(jpeg/png ≤5MB)' },
        signatureImage: {
          type: 'string',
          format: 'binary',
          description: '申请人签名图(必填;jpeg/png ≤5MB;发号后随档案长期留存)',
        },
      },
    },
  })
  @ApiOperation({
    summary:
      '公开报名提交(无账号;multipart:payload JSON 串 + idCardImage 文件 + 必填 signatureImage 签名图〔发号后随档案长期留存〕;⚠️ 契约收紧:signatureImage 与 payload.privacyConsentAccepted=true 均必填,缺省/false → 40000;身份链 wechatCode〔小程序〕或 phoneVerificationToken〔H5 验码令牌〕至少二选一,S4a;免费校验通过后才调付费 OCR;大陆证件 OCR 匹配+防伪+清晰→发临时编号,否则/其余证件→人工待核;OCR 改造后提交端对 OCR 永不硬报错,通道未配/上游失败均转人工;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentSubmitResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.RECRUITMENT_CYCLE_NOT_OPEN,
    BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL,
    BizCode.RECRUITMENT_AGE_OUT_OF_RANGE,
    BizCode.RECRUITMENT_DUPLICATE_APPLICATION,
    // 招新可用性收口 F1:同轮活跃报名 openid/phone 去重(付费 OCR 前命中即拒;温和文案引导查进度)
    BizCode.RECRUITMENT_DUPLICATE_OPENID_ACTIVE,
    BizCode.RECRUITMENT_DUPLICATE_PHONE_ACTIVE,
    BizCode.RECRUITMENT_ID_CARD_IMAGE_REQUIRED,
    // F3(#399):紧急联系人 relation 字典码校验(报名侧;与 promote 一致)
    BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID,
    // S4a:H5 phoneVerificationToken 无效/过期/已用(分叉前 fail-fast)
    BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID,
    // F1 成本线:付费 OCR 按 IP 北京自然日封顶(与 recognize 共享计数;HTTP 429 语义)
    BizCode.RECRUITMENT_OCR_DAILY_LIMIT,
    // OCR 改造:提交端不再外抛 27030/27031(转 manual_review,分叉③);仅识别端点浮现
    BizCode.TOO_MANY_REQUESTS,
  )
  async submit(
    @Body('payload') payloadJson: string | undefined,
    @UploadedFiles()
    files: { idCardImage?: UploadedImageFile[]; signatureImage?: UploadedImageFile[] } | undefined,
    @Req() req: Request,
  ): Promise<RecruitmentSubmitResultDto> {
    const dto = await parseSubmitPayload(payloadJson);
    return this.service.submit(
      dto,
      files?.idCardImage?.[0],
      files?.signatureImage?.[0],
      buildAuditMeta(req),
      new Date(),
    );
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
    // F1 成本线:付费 OCR 按 IP 北京自然日封顶(与 submit 共享计数;HTTP 429 语义;识别契约不加身份参数)
    BizCode.RECRUITMENT_OCR_DAILY_LIMIT,
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
      '公开查询本人报名进度(凭新 wx.login code 换 openid;返回本人最近一条进度模型:业务态 stage + 字典文案 + 门槛 todoList 真投影 + 临时编号 + 轮次通知;F4:发号后〔报名行 openid 已清〕经账号 openid 锚 fall-through 返 stage=volunteer 引导态〔已转志愿者/待入队,memberNo 恒 null〕;无匹配→28002;throttler recruitment) [public]',
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
      'H5 报名前手机发码(无账号;SmsPurpose=RECRUITMENT_BIND;F4:放行=有开放轮 或 手机命中未清除报名记录〔闭轮自助查询/换绑链恢复〕,闭轮陌生手机返防枚举泛化 200 不发码零留痕;手机维度 60s 间隔/10 条日限〔跨 purpose 合计〕+ throttler recruitment 双层兜底) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentSendCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    // F4:28030 不再可达(闭轮改「命中报名放行 / 陌生手机防枚举泛化 200」)
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
      'H5 报名前验码 → 发短时一次性身份令牌(无账号;验码成功落会话行 + 返 phoneVerificationToken〔30min 内随报名提交出示,明文仅一次性返回〕;码错/过期/超次统一 24010;F4:轮次锚=开放轮 或 手机命中未清除报名记录所在轮〔闭轮+无命中→防枚举统一 24010〕;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentVerifyCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    // F4:28030 不再可达(闭轮无命中防枚举统一 24010)
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
      '公开查询本人报名进度②(手机+验证码;无账号;验码消费一码 → 手机定位最近一条报名进度模型,与微信 code 查询同出参/同派生口径;F4:发号后〔报名行 phone 已清〕经账号 phone / 档案手机锚 fall-through 返 stage=volunteer 引导态;码错→24010 / 无匹配→28002;throttler recruitment) [public]',
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

  // 招新可用性收口 F7(评审稿 §2.9 R6):证书图上传(双通道凭证;每类 ≤3 张重传覆盖)。
  @Public()
  @RecruitmentThrottle()
  @Post('applications/certificates')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FilesInterceptor('images', CERTIFICATE_IMAGES_MAX_PER_CATEGORY, {
      limits: { fileSize: ID_CARD_IMAGE_MAX_BYTES, files: CERTIFICATE_IMAGES_MAX_PER_CATEGORY },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['category', 'images'],
      properties: {
        category: {
          type: 'string',
          enum: ['first_aid', 'bsafe'],
          description: '证书类别(cert_type 既有码;每类 ≤3 张,重传整类覆盖)',
        },
        wechatCode: {
          type: 'string',
          description: '通道①:微信 wx.login code(与 phone+code 二选一)',
        },
        phone: { type: 'string', description: '通道②:手机号(配合 code)' },
        code: { type: 'string', description: '通道②:短信验证码(消费一码)' },
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: '证书图(1~3 张;jpeg/png 每张 ≤5MB)',
        },
      },
    },
  })
  @ApiOperation({
    summary:
      '公开上传证书图(无账号;凭证双通道二选一:wechatCode 或 phone+code;category ∈ first_aid/bsafe〔cert_type 既有码〕;每类 ≤3 张重传整类覆盖〔旧图即删〕;终态行 → 28041;发号时按类别自动建 pending Certificate 长期档案〔R6〕,审核动作仍 = 既有标门槛;审计 certificate-upload;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentCertificateUploadResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_CODE_INVALID,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    BizCode.TOO_MANY_REQUESTS,
  )
  uploadCertificates(
    @Body() dto: RecruitmentCertificateUploadDto,
    @UploadedFiles() images: UploadedImageFile[] | undefined,
    @Req() req: Request,
  ): Promise<RecruitmentCertificateUploadResultDto> {
    return this.identity.uploadCertificateImages(dto, images ?? [], buildAuditMeta(req));
  }

  // 招新可用性收口 F6(评审稿 §3 R4):自助撤销(凭证双通道镜像 query / query-by-phone)。
  @Public()
  @RecruitmentThrottle()
  @Post('applications/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '自助撤销报名(无账号;凭证双通道二选一:wechatCode〔code2session 定位〕或 phone+code〔验码消费一码〕;非终态皆可撤 → withdrawn 终态,撤销后同轮同证件号/同微信/同手机可重报;已发号/未通过/已撤销 → 28052;返更新后进度模型 stage=withdrawn;审计 withdraw;throttler recruitment) [public]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationProgressDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_CODE_INVALID,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.RECRUITMENT_APPLICATION_NOT_WITHDRAWABLE,
    BizCode.TOO_MANY_REQUESTS,
  )
  withdraw(
    @Body() dto: RecruitmentWithdrawDto,
    @Req() req: Request,
  ): Promise<RecruitmentApplicationProgressDto> {
    return this.identity.withdraw(dto, buildAuditMeta(req));
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
