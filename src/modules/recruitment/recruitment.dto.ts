import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import {
  EMERGENCY_CONTACTS_MIN,
  RISK_LEVEL_HIGH,
  RISK_LEVEL_NORMAL,
  RISK_LEVEL_SYSTEM,
  THRESHOLD_CODES,
} from './recruitment.constants';

// 招新一期(招新前段)T3(2026-06-18):recruitment DTO 集合(评审稿 §3.2)。
//
// 公开报名 = multipart/form-data:`payload`(本文件 RecruitmentSubmitPayloadDto 的 JSON 串)+ `idCardImage`(文件);
// controller JSON.parse(payload) → plainToInstance + validate;敏感字段(身份证号/手机/姓名)仅入库不回显明文。
// 出参对外(公开 query)= self-scope 最小集;admin 出参含 PII(掩码策略见 service / §6)。

// 大陆手机号(沿 sms MAINLAND_PHONE 范式)
const MAINLAND_PHONE = /^1[3-9]\d{9}$/;
const NAME_MAX = 50;
const ADDR_MAX = 200;
const CODE_MAX = 64;

// ============ 公开报名提交(payload JSON)============

export class EmergencyContactInputDto {
  @ApiProperty({ description: '紧急联系人姓名' })
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  name!: string;

  @ApiProperty({ description: '与本人关系(字典 emergency_relation)' })
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  relation!: string;

  @ApiProperty({ description: '联系电话(大陆手机号)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '紧急联系人手机号格式不正确' })
  phone!: string;
}

export class RecruitmentSubmitPayloadDto {
  @ApiPropertyOptional({
    description:
      '微信 wx.login code(小程序链 code2session 换 openid;与 phoneVerificationToken 至少二选一)',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  wechatCode?: string;

  @ApiPropertyOptional({
    description:
      'H5 手机身份链令牌(verify-code 端点验码后所发,绑手机+轮次,一次性;与 wechatCode 至少二选一,H5 链必填)',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  phoneVerificationToken?: string;

  @ApiProperty({ description: '真实姓名(实名核验二要素;高敏感)' })
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  realName!: string;

  @ApiProperty({
    description:
      '证件号(大陆身份证 18 位 / 外籍证件号;高敏感;大陆证件校验位 + 年龄在 service 校验)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  idCardNumber!: string;

  @ApiProperty({ description: '证件类型(mainland_id 走核验;其余走人工待核)' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  documentTypeCode!: string;

  @ApiProperty({ description: '手机号(仅通知用途,非身份证据;大陆手机号)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '手机号格式不正确' })
  phone!: string;

  @ApiProperty({ description: '详细住址(高敏感;留存清)' })
  @IsString()
  @MinLength(1)
  @MaxLength(ADDR_MAX)
  detailedAddress!: string;

  @ApiProperty({ description: '城市到区(脱敏留存;前端区县选择器提供)' })
  @IsString()
  @MinLength(1)
  @MaxLength(CODE_MAX)
  cityDistrict!: string;

  @ApiProperty({ description: '来源渠道(脱敏留存)' })
  @IsString()
  @MinLength(1)
  @MaxLength(CODE_MAX)
  sourceChannel!: string;

  @ApiProperty({
    description: `紧急联系人(≥${EMERGENCY_CONTACTS_MIN};高敏感;留存清)`,
    type: [EmergencyContactInputDto],
  })
  @IsArray()
  @ArrayMinSize(EMERGENCY_CONTACTS_MIN, {
    message: `紧急联系人至少需要 ${EMERGENCY_CONTACTS_MIN} 位`,
  })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => EmergencyContactInputDto)
  emergencyContacts!: EmergencyContactInputDto[];

  @ApiPropertyOptional({ description: '其余报名字段(Q7 精简后冻结,本期最小;高敏感;留存清)' })
  @IsOptional()
  @IsObject()
  profileExtra?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'OCR 不一致三选一之③:申请人确认 OCR 识别有误、坚持以填写为准(S4b §2.1;true 时不一致仍落普通人工复核,不再要求重拍/改填)',
  })
  @IsOptional()
  @IsBoolean()
  applicantConfirmedOcrWrong?: boolean;
}

// ============ 公开 OCR 识别预填(OCR 改造 2026-06-22;评审稿 §3.2 端点 4b / §4)============
// multipart:`documentTypeCode`(表单字段)+ `idCardImage`(文件)→ OCR 识别结果供前端回填。
// **无状态**(不落图、不发 token,分叉①A);申请人确认/修正后再走提交端点(权威判定)。

// ============ OCR 鉴伪版充分利用(2026-06-29;评审稿 recruitment-ocr-anti-forgery-enrichment-review.md §4.2)============
// 仅身份证鉴伪版有意义的顾问式回显:字段级(每栏 reflect/incomplete)+ 卡片级告警 + 证件类型。
// **不改判定**(recognized/clarityOk/antiForgeryWarnings 既有语义不动);供前端精准提示「哪个字段反光/不完整」。

export class RecruitmentOcrFieldDto {
  @ApiPropertyOptional({ description: 'OCR 识别值(申请人本人 PII;不入日志)', nullable: true })
  content!: string | null;
  @ApiProperty({ description: '该字段反光(IsReflect/IsKeyReflect)' })
  reflect!: boolean;
  @ApiProperty({ description: '该字段不完整/被遮挡(IsInComplete/IsKeyInComplete)' })
  incomplete!: boolean;
}

export class RecruitmentOcrCardWarningsDto {
  @ApiProperty({ description: '疑似复印件' }) copy!: boolean;
  @ApiProperty({ description: '疑似翻拍(屏幕)' }) reshoot!: boolean;
  @ApiProperty({ description: '疑似 PS 篡改' }) ps!: boolean;
  @ApiProperty({ description: '边框不完整' }) border!: boolean;
  @ApiProperty({ description: '遮挡' }) occlusion!: boolean;
  @ApiProperty({ description: '模糊' }) blur!: boolean;
}

export class RecruitmentOcrDetailDto {
  @ApiPropertyOptional({ type: RecruitmentOcrFieldDto, nullable: true })
  sex!: RecruitmentOcrFieldDto | null;
  @ApiPropertyOptional({ type: RecruitmentOcrFieldDto, nullable: true })
  nation!: RecruitmentOcrFieldDto | null;
  @ApiPropertyOptional({ type: RecruitmentOcrFieldDto, nullable: true })
  birth!: RecruitmentOcrFieldDto | null;
  @ApiPropertyOptional({ type: RecruitmentOcrFieldDto, nullable: true })
  address!: RecruitmentOcrFieldDto | null;
  @ApiPropertyOptional({ type: RecruitmentOcrFieldDto, nullable: true })
  authority!: RecruitmentOcrFieldDto | null;
  @ApiPropertyOptional({ type: RecruitmentOcrFieldDto, nullable: true })
  validDate!: RecruitmentOcrFieldDto | null;
  @ApiPropertyOptional({ description: 'OCR 识别出的证件类型(顶层 Type)', nullable: true })
  documentType!: string | null;
  @ApiPropertyOptional({ type: RecruitmentOcrCardWarningsDto, nullable: true })
  cardWarnings!: RecruitmentOcrCardWarningsDto | null;
}

export class RecruitmentOcrRecognizeResponseDto {
  @ApiProperty({
    description: '该证件类型本期是否走 OCR(身份证/护照/回乡证 true;其余 false→前端手填)',
  })
  ocrSupported!: boolean;

  @ApiProperty({ description: '证件照是否清晰可读(false=请重拍;非错误,可继续提交转人工)' })
  clarityOk!: boolean;

  @ApiPropertyOptional({
    description: 'OCR 识别出的姓名 / 证件号(供前端回填;申请人本人 PII,不入日志)',
    nullable: true,
  })
  recognized!: { realName: string | null; idCardNumber: string | null } | null;

  @ApiProperty({
    description: '图像防伪/质量告警归一码(空=无告警;仅身份证有意义;有告警仍可提交→转人工)',
    type: [String],
  })
  antiForgeryWarnings!: string[];

  @ApiPropertyOptional({
    description: '证件类别(仅回乡证:须来往内地;往来港澳会在提交侧记 category_mismatch)',
    nullable: true,
  })
  documentCategory!: string | null;

  @ApiPropertyOptional({ description: '前端提示文案(如不清晰/不支持时)', nullable: true })
  hint!: string | null;

  @ApiPropertyOptional({
    description:
      '鉴伪版扩展回显(仅身份证;顾问式不改判定):字段级 性别/民族/出生/住址/签发机关/有效期(每栏 reflect/incomplete)+ 证件类型 + 卡片级质量/防伪告警。**裁剪图 base64 绝不在此返回**(仅 submit 入库)。',
    type: RecruitmentOcrDetailDto,
    nullable: true,
  })
  ocrDetail!: RecruitmentOcrDetailDto | null;
}

// ============ 公开查询(凭新 wx.login code)============

export class RecruitmentQueryDto {
  @ApiProperty({ description: '微信 wx.login code(换 openid 查本人当前轮报名)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  wechatCode!: string;
}

// ============ 招新四期 S4a:H5 + 手机身份链(评审稿 §3;无账号 pre-auth 自助)============
// 复用 src/modules/sms 基建(SmsPurpose.RECRUITMENT_BIND)。发码/验码 → 短时一次性 token,
// 凭 token 走 H5 报名提交;查询②直接「手机+验证码」;自助换微信/换手机换绑。

const SMS_CODE_6 = /^\d{6}$/;

export class RecruitmentSendCodeDto {
  @ApiProperty({ description: '手机号(大陆手机号;H5 报名前身份验证)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '手机号格式不正确' })
  phone!: string;
}

export class RecruitmentSendCodeResponseDto {
  @ApiProperty({ description: '验证码有效期(秒)' })
  expiresInSeconds!: number;
}

export class RecruitmentVerifyCodeDto {
  @ApiProperty({ description: '手机号(大陆手机号)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '手机号格式不正确' })
  phone!: string;

  @ApiProperty({ description: '短信验证码(6 位数字)' })
  @IsString()
  @Matches(SMS_CODE_6, { message: '验证码格式不正确' })
  code!: string;
}

export class RecruitmentVerifyCodeResponseDto {
  @ApiProperty({
    description: 'H5 手机身份链令牌(一次性;30 分钟内随报名提交出示;明文仅此一次返回)',
  })
  phoneVerificationToken!: string;

  @ApiProperty({ description: '令牌过期时刻' })
  expiresAt!: Date;
}

export class RecruitmentQueryByPhoneDto {
  @ApiProperty({ description: '手机号(大陆手机号;查本人当前轮报名)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '手机号格式不正确' })
  phone!: string;

  @ApiProperty({ description: '短信验证码(6 位数字;一次查询消费一码)' })
  @IsString()
  @Matches(SMS_CODE_6, { message: '验证码格式不正确' })
  code!: string;
}

export class RecruitmentRebindWechatDto {
  @ApiProperty({ description: '当前已绑手机号(校验本人;须先验码)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '手机号格式不正确' })
  phone!: string;

  @ApiProperty({ description: '当前手机短信验证码(6 位数字)' })
  @IsString()
  @Matches(SMS_CODE_6, { message: '验证码格式不正确' })
  code!: string;

  @ApiProperty({ description: '新微信 wx.login code(换绑目标 openid)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  newWechatCode!: string;
}

export class RecruitmentRebindPhoneDto {
  @ApiProperty({ description: '当前已绑手机号(校验本人;须先验码)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '手机号格式不正确' })
  phone!: string;

  @ApiProperty({ description: '当前手机短信验证码(6 位数字)' })
  @IsString()
  @Matches(SMS_CODE_6, { message: '验证码格式不正确' })
  code!: string;

  @ApiProperty({ description: '新手机号(大陆手机号;须与当前不同)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '新手机号格式不正确' })
  newPhone!: string;

  @ApiProperty({ description: '新手机短信验证码(6 位数字)' })
  @IsString()
  @Matches(SMS_CODE_6, { message: '验证码格式不正确' })
  newPhoneCode!: string;

  @ApiPropertyOptional({ description: '换绑原因(自由短串;缺省记 self-rebind)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// 公开提交结果(招新闭环优化 S4b OCR 六分流;评审稿 §2.1):提交端点 submit 出参。
// outcome 区分「落报名记录」(submitted:verified/manual_review)与「不落记录的中性延迟引导」
// (retake 重拍 / confirm 三选一待核对 / retry 上游首次重试)。**绝不暴露 riskLevel/forgery 分级**
// (高风险疑似造假不对申请人提示;goal 三③隐私口径)——申请人侧仅见中性 stage/hint。
// 公开本人查询(query)出参另为进度模型 RecruitmentApplicationProgressDto。
export class RecruitmentSubmitResultDto {
  @ApiProperty({
    description:
      '提交处置:submitted(已落报名记录)/ retake(请重拍,不落记录)/ confirm(识别与填写不一致,请三选一,不落记录)/ retry(核验繁忙,请重试,不落记录)',
  })
  outcome!: string;

  @ApiPropertyOptional({
    description: '报名状态(verified/manual_review;仅 outcome=submitted 有值,否则 null)',
    nullable: true,
  })
  statusCode!: string | null;

  @ApiPropertyOptional({ description: '临时编号 T{year}{seq}(仅 verified 有值)', nullable: true })
  tempNo!: string | null;

  @ApiPropertyOptional({
    description: '业务态(retake=待重拍 / confirm=待核对;submitted/retry 为 null;中性,不含风险分级)',
    nullable: true,
  })
  stage!: string | null;

  @ApiPropertyOptional({
    description: '业务态文案(recruitment_stage 字典 label;中性)',
    nullable: true,
  })
  stageText!: string | null;

  @ApiPropertyOptional({
    description: '下一步动作码(retake / confirm-ocr;前端据此渲染按钮)',
    nullable: true,
  })
  nextAction!: string | null;

  @ApiPropertyOptional({ description: '中性引导文案(重拍 / 核对 / 重试)', nullable: true })
  hint!: string | null;

  @ApiPropertyOptional({
    description:
      'OCR 识别值(仅 outcome=confirm 三选一时返,供申请人选「①用 OCR 回填」;申请人本人 PII)',
    nullable: true,
  })
  recognized!: { realName: string | null; idCardNumber: string | null } | null;

  @ApiProperty({ description: '轮次名' })
  cycleName!: string;

  @ApiPropertyOptional({ description: '见面会信息(后填)', nullable: true })
  meetingInfo!: string | null;

  @ApiPropertyOptional({ description: 'QQ 群(后填)', nullable: true })
  qqGroup!: string | null;

  @ApiPropertyOptional({ description: '通知模板/各节点文案(后填)', nullable: true })
  notifyTemplate!: Record<string, unknown> | null;
}

// ============ 公开本人进度模型(招新闭环优化 S1;评审稿 §6.1 / §4 状态业务化)============
// 把机器态 statusCode 派生为业务态 stage + 字典文案 stageText + 动作码 nextAction + 门槛 todoList 真投影,
// 作为「公开本人查询」的出参(submit 端点返 RecruitmentSubmitResultDto)。文案归属见
// recruitment-progress-presenter.ts(stageText 来自 recruitment_stage 字典,§4.1「后端不存展示文案明文」)。

export class RecruitmentTodoItemDto {
  @ApiProperty({ description: '门槛 code(patrol1/patrol2/training/redCross/bsafe)' })
  code!: string;

  @ApiProperty({ description: '门槛展示名' })
  name!: string;

  @ApiProperty({ description: '是否完成(thresholdMarks 真投影,非写死)' })
  done!: boolean;
}

export class RecruitmentApplicationProgressDto {
  @ApiProperty({ description: '业务态枚举(评审稿 §4.2;statusCode 派生,机器态不外露)' })
  stage!: string;

  @ApiProperty({ description: '业务态文案(recruitment_stage 字典 label;后台可维护)' })
  stageText!: string;

  @ApiProperty({ description: '一句话当前状态说明(S1 同 stageText)' })
  statusText!: string;

  @ApiPropertyOptional({
    description: '下一步动作码(前端据此渲染按钮文案;终态为 null)',
    nullable: true,
  })
  nextAction!: string | null;

  @ApiPropertyOptional({ description: '临时编号 T{year}{seq}(verified 后有值)', nullable: true })
  tempNo!: string | null;

  @ApiPropertyOptional({
    description:
      '永久编号(promoted 后;**公开查询恒 null**——发号即清 openid 不可达,经登录态 app 侧另见)',
    nullable: true,
  })
  memberNo!: string | null;

  @ApiProperty({ description: '身份文案(报名申请人/招新候选人/志愿者/正式队员)' })
  identityText!: string;

  @ApiProperty({
    type: [RecruitmentTodoItemDto],
    description: '门槛清单(5 项;done 来自实际标记数据)',
  })
  todoList!: RecruitmentTodoItemDto[];

  @ApiPropertyOptional({ description: '见面会信息(轮次配置)', nullable: true })
  meetingInfo!: string | null;

  @ApiPropertyOptional({ description: 'QQ 群(轮次配置)', nullable: true })
  qqGroup!: string | null;

  @ApiPropertyOptional({ description: '通知配置/各节点文案(轮次 notifyTemplate)', nullable: true })
  notice!: Record<string, unknown> | null;
}

// ============ admin 轮次 ============

export class CreateRecruitmentCycleDto {
  @ApiProperty({ description: '招新年份(临时编号 T{year} 的 year)' })
  @IsInt()
  @Min(2000)
  year!: number;

  @ApiProperty({ description: '轮次名(如「2026 年度招新」)' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: '容量上限(可临时增容;缺省不限)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;
}

export class UpdateRecruitmentCycleDto {
  @ApiPropertyOptional({ description: '状态(open / closed;开新 open 轮要求当前无 open 轮)' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  statusCode?: string;

  @ApiPropertyOptional({ description: '容量上限(可临时增容)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({ description: '见面会信息(后填)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingInfo?: string;

  @ApiPropertyOptional({ description: 'QQ 群(后填)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  qqGroup?: string;

  @ApiPropertyOptional({ description: '通知模板(各节点文案;后填)' })
  @IsOptional()
  @IsObject()
  notifyTemplate?: Record<string, unknown>;
}

export class RecruitmentCycleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() year!: number;
  @ApiProperty() name!: string;
  @ApiProperty() statusCode!: string;
  @ApiPropertyOptional({ nullable: true }) capacity!: number | null;
  @ApiProperty({ description: '已发临时编号数(tempNoSeq)' }) issuedCount!: number;
  @ApiPropertyOptional({ nullable: true }) meetingInfo!: string | null;
  @ApiPropertyOptional({ nullable: true }) qqGroup!: string | null;
  @ApiPropertyOptional({ nullable: true }) notifyTemplate!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true }) openedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) closedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

// ============ admin 报名 ============

// admin 报名列表 query(分页 + 可选 cycleId / statusCode / riskLevel〔S4b 人工队列三栏 §2.4〕过滤)。
// 过滤参数必须进 DTO 白名单:全局 ValidationPipe(whitelist + forbidNonWhitelisted)校验整个 query 对象,
// loose @Query('x') 旁路不进白名单 → 发送过滤参时 400「property cycleId should not exist」(前端报名审核 tab 过滤失效)。
export class RecruitmentApplicationListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按招新轮过滤' })
  @IsOptional()
  @IsString()
  @MaxLength(CODE_MAX)
  cycleId?: string;

  @ApiPropertyOptional({
    description:
      '按机器态 statusCode 过滤(pending_verification/verified/manual_review/rejected 等)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  statusCode?: string;

  @ApiPropertyOptional({
    description: '按复核风险级过滤(S4b 后台人工队列三栏分流;normal/high/system)',
    enum: [RISK_LEVEL_NORMAL, RISK_LEVEL_HIGH, RISK_LEVEL_SYSTEM],
  })
  @IsOptional()
  @IsIn([RISK_LEVEL_NORMAL, RISK_LEVEL_HIGH, RISK_LEVEL_SYSTEM])
  riskLevel?: string;
}

// admin 报名出参(含 PII;身份证号/手机详情可全显,沿 certificates 可见性;列表掩码由 service 控制)
export class RecruitmentApplicationAdminDto {
  @ApiProperty() id!: string;
  @ApiProperty() cycleId!: string;
  @ApiProperty() statusCode!: string;
  @ApiPropertyOptional({ nullable: true }) tempNo!: string | null;
  @ApiPropertyOptional({ nullable: true }) realName!: string | null;
  @ApiPropertyOptional({ description: '身份证号(列表掩码,详情可全显)', nullable: true })
  idCardNumber!: string | null;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiProperty() documentTypeCode!: string;
  @ApiProperty() isForeigner!: boolean;
  @ApiPropertyOptional({ nullable: true }) genderCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) ageGroup!: string | null;
  @ApiPropertyOptional({ nullable: true }) cityDistrict!: string | null;
  @ApiPropertyOptional({ nullable: true }) verifyOutcome!: string | null;
  // ===== 招新闭环优化 S4b(OCR 六分流;§2.4 后台人工队列三栏 + 分组筛选)=====
  @ApiPropertyOptional({
    description: '复核风险级(normal/high/system;人工队列三栏分流;可按此过滤列表)',
    nullable: true,
  })
  riskLevel!: string | null;
  @ApiPropertyOptional({
    description:
      '后台人工原因分类(ocr_mismatch_confirmed/forgery_suspected/system_ocr_error/special_document;可分组筛选)',
    nullable: true,
  })
  manualReviewReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) eliminationStage!: string | null;
  @ApiProperty({ description: '是否有证件照(取图走 :id/id-card-image-url)' })
  hasIdCardImage!: boolean;
  // ===== OCR 鉴伪版充分利用(2026-06-29;敏感分级 S3:masked〔无 read.sensitive〕→ null)=====
  // OCR 顾问式存档值(非权威);住址为高敏感 PII,四列统一随 read.sensitive 门控(脱敏级 → null)。
  @ApiPropertyOptional({ description: 'OCR 住址(高敏感;无 read.sensitive → null)', nullable: true })
  ocrAddress!: string | null;
  @ApiPropertyOptional({ description: 'OCR 民族(无 read.sensitive → null)', nullable: true })
  ocrNation!: string | null;
  @ApiPropertyOptional({ description: 'OCR 签发机关(无 read.sensitive → null)', nullable: true })
  ocrAuthority!: string | null;
  @ApiPropertyOptional({ description: 'OCR 有效期(无 read.sensitive → null)', nullable: true })
  ocrValidDate!: string | null;
  @ApiProperty({
    description: '是否有主体框裁剪图(身份证鉴伪版;取图走 :id/id-card-image-url 的 cropImageUrl)',
  })
  hasIdCardCropImage!: boolean;
  @ApiProperty({ description: '是否有头像裁剪图(身份证鉴伪版;取图走 portraitImageUrl)' })
  hasIdCardPortraitImage!: boolean;
  // ===== 招新二期(后段)字段 =====
  @ApiPropertyOptional({
    description:
      '门槛标记 { patrol1:{at,by}, ... }(M-3;5 项 patrol1/patrol2/training/redCross/bsafe)',
    nullable: true,
  })
  thresholdMarks!: Record<string, { at: string; by: string }> | null;
  @ApiProperty({ description: '门槛是否全完成(派生;5 项标记齐 = true)' })
  thresholdsComplete!: boolean;
  @ApiPropertyOptional({ description: '综合评定备注', nullable: true })
  evaluationNote!: string | null;
  @ApiPropertyOptional({
    description: '永久编号(promoted 后;promote 出的 Member.memberNo)',
    nullable: true,
  })
  promotedMemberId!: string | null;
  @ApiProperty({ description: '一键发号不含、需 admin 手动建档(M-1:外籍/缺派生字段)' })
  needsManualBuild!: boolean;
  @ApiProperty() createdAt!: Date;
}

// ============ 招新二期:门槛标记 / 综合评定(admin)============

// 标/清单个门槛(幂等;仅 verified/pending_evaluation 态可标,评审稿 E-R2-2)
export class MarkThresholdDto {
  @ApiProperty({
    description: '门槛 code',
    enum: THRESHOLD_CODES as unknown as string[],
  })
  @IsString()
  @IsIn(THRESHOLD_CODES, { message: '门槛 code 非法' })
  thresholdCode!: string;

  @ApiProperty({ description: 'true=标记完成;false=清除标记(补课纠错)' })
  @IsBoolean()
  completed!: boolean;
}

// ============ 招新可用性收口 F2:admin 改资料(评审稿 recruitment-usability-closeout-review.md §3 R1)============
// 白名单字段集(全可选,至少一项):
// - 非身份字段(恒可改,promoted/已脱敏行除外):detailedAddress / cityDistrict / sourceChannel /
//   emergencyContacts(逐项 relation 字典校验,镜像 submit)/ profileExtra;
// - 身份字段(条件闸:仅 manual_review 或外籍记录;verified 大陆 → 28045):realName / idCardNumber /
//   birthDate / genderCode。大陆记录 birthDate/genderCode **恒由证件号派生**(直接传 → 40000);
//   大陆改 idCardNumber → 校验位 + 年龄复检 + 重派生 + 同轮去重(镜像 submit 语义)。
// **不含** phone / openid(各有自助换绑通道 rebind-phone/rebind-wechat,双验 + 换绑历史;admin 直改会
// 绕过验证链破坏 H5 身份锚,评审稿 R3 取舍)。
export class UpdateRecruitmentApplicationDto {
  @ApiPropertyOptional({ description: '真实姓名(身份字段;仅 manual_review 或外籍记录可改)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  realName?: string;

  @ApiPropertyOptional({
    description:
      '证件号(身份字段;大陆记录改号 → 校验位/年龄复检 + birthDate/genderCode 重派生 + 同轮去重)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  idCardNumber?: string;

  @ApiPropertyOptional({
    description: '出生日期(ISO 日期;**仅外籍记录**可直改——大陆恒由证件号派生,传了 → 40000)',
  })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional({
    description: '性别(male/female;**仅外籍记录**可直改——大陆恒由证件号派生,传了 → 40000)',
    enum: ['male', 'female'],
  })
  @IsOptional()
  @IsIn(['male', 'female'])
  genderCode?: string;

  @ApiPropertyOptional({ description: '详细住址(非身份字段,恒可改)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ADDR_MAX)
  detailedAddress?: string;

  @ApiPropertyOptional({ description: '城市到区(非身份字段)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CODE_MAX)
  cityDistrict?: string;

  @ApiPropertyOptional({ description: '来源渠道(非身份字段)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CODE_MAX)
  sourceChannel?: string;

  @ApiPropertyOptional({
    description: `紧急联系人(整组替换;≥${EMERGENCY_CONTACTS_MIN};relation 逐项字典校验)`,
    type: [EmergencyContactInputDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(EMERGENCY_CONTACTS_MIN, {
    message: `紧急联系人至少需要 ${EMERGENCY_CONTACTS_MIN} 位`,
  })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => EmergencyContactInputDto)
  emergencyContacts?: EmergencyContactInputDto[];

  @ApiPropertyOptional({ description: '其余报名字段(整对象替换;非身份字段)' })
  @IsOptional()
  @IsObject()
  profileExtra?: Record<string, unknown>;
}

// 综合评定 / 淘汰(单一人工闸,评审稿 D-R2-3 / 流程冻结 §4)
export class EvaluateRecruitmentApplicationDto {
  @ApiProperty({
    description:
      'true=综合评定通过(pending_evaluation→公示);false=不通过/淘汰(→未通过;verified 态 false=门槛超期淘汰)',
  })
  @IsBoolean()
  approved!: boolean;

  @ApiPropertyOptional({ description: '综合评定备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ============ 招新二期:公示名单(D-R2-4;姓名 + 拟发编号,拼音序,零敏感)============

export class PublicityListItemDto {
  @ApiProperty() applicationId!: string;
  @ApiPropertyOptional({ description: '公示姓名(拼音序)', nullable: true })
  realName!: string | null;
  @ApiPropertyOptional({
    description: '拟发永久编号 {YY}{NNN}(仅可发号项;外籍/不可发号为 null)',
    nullable: true,
  })
  proposedMemberNo!: string | null;
  @ApiProperty({ description: '是否外籍' })
  isForeigner!: boolean;
  @ApiProperty({ description: 'true=一键发号不含、需 admin 手动建档(M-1 边界,发号前可见)' })
  needsManualBuild!: boolean;
}

export class PublicityListResponseDto {
  @ApiProperty() cycleId!: string;
  @ApiProperty() cycleYear!: number;
  @ApiProperty({ type: [PublicityListItemDto], description: '公示中报名(拼音序)' })
  items!: PublicityListItemDto[];
  @ApiProperty({ description: '可一键发号数(大陆可派生)' })
  promotableCount!: number;
  @ApiProperty({ description: '需手动建档数(外籍等;一键发号不含)' })
  manualBuildCount!: number;
}

// ============ 招新二期:一键发号结果(D-R2-5;promote 出参)============

export class PromotedItemDto {
  @ApiProperty() applicationId!: string;
  @ApiProperty({ description: '新建 Member id' }) memberId!: string;
  @ApiProperty({ description: '永久编号 {YY}{NNN}' }) memberNo!: string;
  @ApiPropertyOptional({ nullable: true }) realName!: string | null;
}

export class PromoteSkippedItemDto {
  @ApiProperty() applicationId!: string;
  @ApiPropertyOptional({ nullable: true }) realName!: string | null;
  @ApiProperty({
    description:
      '跳过原因:foreign-manual-build / openid-already-bound / missing-derived-field / ...(需 admin 手动建档)',
  })
  reason!: string;
}

export class PromoteResultDto {
  @ApiProperty() cycleId!: string;
  @ApiProperty({ description: '本批已发号建档数' }) promotedCount!: number;
  @ApiProperty({ description: '本批跳过数(外籍等;需 admin 手动建档)' }) skippedCount!: number;
  @ApiProperty({ type: [PromotedItemDto], description: '已发号(拼音序)' })
  promoted!: PromotedItemDto[];
  @ApiProperty({ type: [PromoteSkippedItemDto], description: '跳过项(一键发号不含,需手动建档)' })
  skipped!: PromoteSkippedItemDto[];
}

// 人工 resolve(分叉④A):通过 → 发临时编号;不通过 → rejected
export class ResolveRecruitmentApplicationDto {
  @ApiProperty({ description: 'true=人工核验通过(发临时编号);false=不通过(rejected)' })
  @IsBoolean()
  approved!: boolean;

  @ApiPropertyOptional({ description: '人工核验备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;
}

export class IdCardImageUrlResponseDto {
  @ApiProperty({ description: '证件照原图短 TTL signed-URL(L3;不入日志/snapshot)' })
  url!: string;

  @ApiProperty({ description: 'URL 过期时刻(三图同 TTL)' })
  expiresAt!: Date;

  // OCR 鉴伪版充分利用(2026-06-29):主体框 / 头像裁剪图 signed-URL(身份证鉴伪版才有;未入库 → null)。
  @ApiPropertyOptional({
    description: '主体框裁剪图 signed-URL(CardImage;仅身份证鉴伪版且已入库;否则 null)',
    nullable: true,
  })
  cropImageUrl!: string | null;

  @ApiPropertyOptional({
    description: '头像裁剪图 signed-URL(PortraitImage;仅身份证鉴伪版且已入库;否则 null)',
    nullable: true,
  })
  portraitImageUrl!: string | null;
}

// ============ 招新闭环优化 S2:招新工作台 stats(评审稿 §7.1 五组;纯读聚合,零敏感明文)============
// 各业务态计数与 S1 deriveRecruitmentStage 同源(单一 stage 口径,零第二套判定;评审稿 §7.1 line 365
// 「待处理事项即各 stage 计数」)。物理隔离独立 class(禁继承 / Pick / Omit;沿 api-surface-policy §2.1)。
// 「待人工」normal/high/system 三栏:S4b 已落 `riskLevel` 字段,**改用真 riskLevel 单一口径**(去 S2 的
// verifyOutcome 代理;system=riskLevel.system / high=riskLevel.high / normal=manualTotal 减出)。

export class RecruitmentStatsTodayDto {
  @ApiProperty({ description: '今日新报名(createdAt 北京日界当日)' })
  newApplications!: number;
  @ApiProperty({ description: '今日发临时号(verifiedAt 北京日界当日)' })
  tempNoIssued!: number;
  @ApiProperty({ description: '今日人工处理数(reviewedAt 北京日界当日;人工 resolve 时刻)' })
  manualProcessed!: number;
}

export class RecruitmentStatsPendingDto {
  @ApiProperty({ description: '待人工总数(stage=manual + manual_high;= manual_review 态)' })
  manualTotal!: number;
  @ApiProperty({
    description:
      '待人工·普通(riskLevel=normal:mismatch 确认错 / 特殊证件;= manualTotal − high − system)',
  })
  manualNormal!: number;
  @ApiProperty({ description: '待人工·高风险(真 riskLevel=high:防伪/疑似篡改复核)' })
  manualHigh!: number;
  @ApiProperty({ description: '待人工·系统异常(真 riskLevel=system:OCR 上游连续失败)' })
  manualSystem!: number;
  @ApiProperty({ description: '待综合评定(stage=evaluation;= pending_evaluation 态)' })
  pendingEvaluation!: number;
  @ApiProperty({ description: '待发号(stage=publicity;= publicity 态)' })
  pendingIssuance!: number;
}

export class RecruitmentStatsThresholdItemDto {
  @ApiProperty({ description: '门槛 code(patrol1/patrol2/training/redCross/bsafe)' })
  code!: string;
  @ApiProperty({ description: '门槛展示名' })
  name!: string;
  @ApiProperty({ description: '本轮完成该门槛人数(thresholdMarks 真投影,标记存在即完成)' })
  completedCount!: number;
}

export class RecruitmentStatsThresholdDto {
  @ApiProperty({ description: '门槛跟踪中人数(stage=threshold;verified 且门槛未齐)' })
  tracking!: number;
  @ApiProperty({ type: [RecruitmentStatsThresholdItemDto], description: '5 项各自完成人数分布' })
  byThreshold!: RecruitmentStatsThresholdItemDto[];
}

export class RecruitmentStatsEvaluationDto {
  @ApiProperty({ description: '待评定(stage=evaluation;= pending_evaluation 态)' })
  pending!: number;
  @ApiProperty({ description: '已通过进公示(stage=publicity;= publicity 态)' })
  passed!: number;
  @ApiProperty({ description: '评定淘汰(rejected 且 eliminationStage=evaluation)' })
  eliminated!: number;
}

export class RecruitmentStatsIssuanceDto {
  @ApiProperty({ description: '公示中(stage=publicity;= publicity 态)' })
  inPublicity!: number;
  @ApiProperty({
    description:
      '可一键发号数(复用 decidePromotionIssuance 预判;与 publicity-list promotableCount 同源)',
  })
  oneClickIssuable!: number;
  @ApiProperty({
    description: '需手动建档数(decidePromotionIssuance 跳过项;外籍/缺派生字段/openid 占用)',
  })
  needManualBuild!: number;
  @ApiProperty({ description: '已发号(stage=volunteer;= promoted 态)' })
  promoted!: number;
}

export class RecruitmentCycleStatsDto {
  @ApiProperty() cycleId!: string;
  @ApiProperty() cycleYear!: number;
  @ApiProperty({ type: RecruitmentStatsTodayDto, description: '今日数据' })
  today!: RecruitmentStatsTodayDto;
  @ApiProperty({ type: RecruitmentStatsPendingDto, description: '待处理事项' })
  pending!: RecruitmentStatsPendingDto;
  @ApiProperty({ type: RecruitmentStatsThresholdDto, description: '门槛进度' })
  threshold!: RecruitmentStatsThresholdDto;
  @ApiProperty({ type: RecruitmentStatsEvaluationDto, description: '综合评定' })
  evaluation!: RecruitmentStatsEvaluationDto;
  @ApiProperty({ type: RecruitmentStatsIssuanceDto, description: '公示发号' })
  issuance!: RecruitmentStatsIssuanceDto;
}

// ============ 招新闭环优化 S6:批量操作(评审稿 §8;纯加端点,零 schema / 零新 RBAC 码)============
// 三类:批量标门槛(复用单行 markThreshold)/ 批量导出 CSV(脱敏复用 S3 toAdminDto)/ 一键发号前预检
//(复用 decidePromotionIssuance,结构性保证「预检=实发」)。批量通知不做(挂 §9 / GAP-005,随 S7)。
// 物理隔离独立 class(禁继承 / Pick / Omit;沿 api-surface-policy §2.1)。

// 批量标门槛单个匹配项(§8.1 匹配键;优先级 tempNo > 姓名+手机 > 手机)。
export class BatchMarkThresholdMatchDto {
  @ApiPropertyOptional({ description: '临时编号 T{year}{seq}(最精确匹配键;优先)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  tempNo?: string;

  @ApiPropertyOptional({
    description: '手机号(配合 realName = 姓名+手机;单用须本轮唯一命中,否则 ambiguous)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: '真实姓名(须配合 phone;姓名单键不作为匹配键)' })
  @IsOptional()
  @IsString()
  @MaxLength(NAME_MAX)
  realName?: string;
}

export class BatchMarkThresholdDto {
  @ApiPropertyOptional({
    description: '限定轮次(**强烈建议**:手机/姓名跨轮去歧义;缺省跨全部未软删报名匹配)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cycleId?: string;

  @ApiProperty({ description: '门槛 code', enum: THRESHOLD_CODES as unknown as string[] })
  @IsString()
  @IsIn(THRESHOLD_CODES, { message: '门槛 code 非法' })
  thresholdCode!: string;

  @ApiProperty({ description: 'true=标记完成;false=清除标记(逐行幂等,复用单行 markThreshold)' })
  @IsBoolean()
  completed!: boolean;

  @ApiProperty({
    description:
      '匹配项数组(临时编号 / 手机 / 姓名+手机;「签到记录导入」= 前端解析签到表为本数组,后端不碰文件)',
    type: [BatchMarkThresholdMatchDto],
  })
  @IsArray()
  @ArrayMinSize(1, { message: '匹配项至少 1 条' })
  @ArrayMaxSize(500, { message: '单批至多 500 条' })
  @ValidateNested({ each: true })
  @Type(() => BatchMarkThresholdMatchDto)
  matches!: BatchMarkThresholdMatchDto[];
}

export class BatchMarkThresholdRowResultDto {
  @ApiProperty({ description: '对应入参 matches 的下标(前端按此回填行)' })
  index!: number;
  @ApiProperty({
    description:
      '逐行结果:marked(已标,幂等)/ unmatched(匹配不上)/ failed(命中但标记失败,如状态非法)',
  })
  status!: string;
  @ApiPropertyOptional({ description: '命中的报名 id(matched/failed 时)', nullable: true })
  applicationId!: string | null;
  @ApiPropertyOptional({
    description: '匹配方式 tempNo / name+phone / phone(命中时)',
    nullable: true,
  })
  matchedBy!: string | null;
  @ApiPropertyOptional({
    description: 'unmatched 原因:no-match(0 命中)/ ambiguous(多命中)/ insufficient-key(缺匹配键)',
    nullable: true,
  })
  unmatchedReason!: string | null;
  @ApiPropertyOptional({ description: 'failed 业务错误码(如 28041 状态非法)', nullable: true })
  errorCode!: number | null;
  @ApiPropertyOptional({
    description: '标记后报名态(marked 时;= pending_evaluation 即末次门槛完成自动推进)',
    nullable: true,
  })
  statusCode!: string | null;
  @ApiPropertyOptional({ description: '门槛是否全完成(marked 时)', nullable: true })
  thresholdsComplete!: boolean | null;
}

export class BatchMarkThresholdResultDto {
  @ApiProperty({
    type: [BatchMarkThresholdRowResultDto],
    description: '逐行结果(与入参 matches 同序)',
  })
  results!: BatchMarkThresholdRowResultDto[];
  @ApiProperty({ description: '入参总行数' })
  total!: number;
  @ApiProperty({ description: '已标记数(含幂等重标)' })
  marked!: number;
  @ApiProperty({ description: '匹配不上数(no-match / ambiguous / insufficient-key)' })
  unmatched!: number;
  @ApiProperty({ description: '命中但标记失败数(状态非法等;逐行容错,不整批回滚)' })
  failed!: number;
  @ApiProperty({ description: '本批标记后处于待综合评定态的行数(末次门槛完成自动推进)' })
  autoAdvanced!: number;
}

// 批量导出 CSV 筛选项(§8.1;脱敏列/明文列随 S3 read.sensitive 分级;导出本身无响应 DTO,走 text/csv)。
export const RECRUITMENT_EXPORT_FILTERS = [
  'all',
  'manual',
  'verified',
  'threshold-incomplete',
  'pending-evaluation',
  'publicity',
  'promoted',
  'rejected',
] as const;

export class ExportRecruitmentApplicationsDto {
  @ApiPropertyOptional({ description: '限定轮次(缺省导出全部未软删报名)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cycleId?: string;

  @ApiPropertyOptional({
    description:
      '筛选:all 全部 / manual 待人工 / verified 已初审 / threshold-incomplete 门槛未完成 / pending-evaluation 待评定 / publicity 公示 / promoted 发号 / rejected 淘汰;缺省 all',
    enum: RECRUITMENT_EXPORT_FILTERS as unknown as string[],
  })
  @IsOptional()
  @IsString()
  @IsIn(RECRUITMENT_EXPORT_FILTERS, { message: '导出筛选项非法' })
  filter?: string;
}

// 一键发号前预检逐行(§8.2;willIssue / skipReason 与实发同源 decidePromotionIssuance,**预检=实发**)。
export class PromotePrecheckRowDto {
  @ApiProperty() applicationId!: string;
  @ApiPropertyOptional({ description: '公示姓名(拼音序)', nullable: true })
  realName!: string | null;
  @ApiProperty({ description: '是否可一键发号(= 实发 willIssue 同源 decidePromotionIssuance)' })
  willIssue!: boolean;
  @ApiPropertyOptional({
    description:
      '跳过原因(foreign-manual-build / openid-already-bound / phone-already-bound〔v0.40.0 H5〕/ missing-login-channel〔v0.40.0;openid+phone 皆无,取代 missing-openid〕/ duplicate-openid-in-batch / duplicate-phone-in-batch〔v0.40.0 H5〕/ missing-derived-field / incomplete-data;willIssue=true 为 null)',
    nullable: true,
  })
  skipReason!: string | null;
  @ApiPropertyOptional({
    description: '拟发永久编号 {YY}{NNN}(仅 willIssue;与公示/实发同序推算)',
    nullable: true,
  })
  proposedMemberNo!: string | null;
  @ApiProperty({ description: '是否外籍(特殊证件标识;需手动建档)' })
  isForeigner!: boolean;
  @ApiProperty({ description: '证件类型(特殊证件标识)' })
  documentTypeCode!: string;
  @ApiProperty({
    description: '缺 openid(无微信通道;v0.40.0 起有已验证手机亦可发号,不再必然阻断)',
  })
  missingOpenid!: boolean;
  @ApiProperty({ description: 'openid 已被既有账号占用' })
  openidAlreadyBound!: boolean;
  @ApiProperty({ description: 'openid 在本批重复(高亮:≥2 申请人共用同一 openid)' })
  duplicateOpenidInBatch!: boolean;
  @ApiProperty({
    description: '手机通道 phone 已被既有账号占用(v0.40.0;仅无 openid 走手机通道的行有此语义)',
  })
  phoneAlreadyBound!: boolean;
  @ApiProperty({
    description: '手机通道 phone 在本批重复(v0.40.0;高亮:≥2 无 openid 申请人共用同一 phone)',
  })
  duplicatePhoneInBatch!: boolean;
  @ApiProperty({ description: '缺手机' })
  missingPhone!: boolean;
  @ApiProperty({ description: '缺生日(身份证派生失败 / 外籍未填)' })
  missingBirthDate!: boolean;
  @ApiProperty({ description: '缺性别' })
  missingGender!: boolean;
}

export class PromotePrecheckResultDto {
  @ApiProperty() cycleId!: string;
  @ApiProperty() cycleYear!: number;
  @ApiProperty({
    type: [PromotePrecheckRowDto],
    description: '公示报名逐行预检(拼音序,与实发同序)',
  })
  rows!: PromotePrecheckRowDto[];
  @ApiProperty({ description: '可一键发号数' })
  promotableCount!: number;
  @ApiProperty({ description: '跳过数(= 需手动建档数)' })
  skipCount!: number;
  @ApiProperty({ description: '公示总数' })
  total!: number;
}
