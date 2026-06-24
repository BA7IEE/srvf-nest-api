import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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

import { EMERGENCY_CONTACTS_MIN, THRESHOLD_CODES } from './recruitment.constants';

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
}

// ============ 公开 OCR 识别预填(OCR 改造 2026-06-22;评审稿 §3.2 端点 4b / §4)============
// multipart:`documentTypeCode`(表单字段)+ `idCardImage`(文件)→ OCR 识别结果供前端回填。
// **无状态**(不落图、不发 token,分叉①A);申请人确认/修正后再走提交端点(权威判定)。

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

// 公开出参:申请状态 + 临时编号 + 通知展示(self-scope 最小集;不回显他人/PII 明文)。
// 提交端点(submit)仍返本 DTO;**公开本人查询(query)已改返进度模型 RecruitmentApplicationProgressDto**。
export class RecruitmentApplicationPublicDto {
  @ApiProperty({ description: '报名状态(pending_verification/verified/manual_review/rejected)' })
  statusCode!: string;

  @ApiPropertyOptional({ description: '临时编号 T{year}{seq}(仅 verified 有值)', nullable: true })
  tempNo!: string | null;

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
// 作为「公开本人查询」的出参(submit 端点仍返 RecruitmentApplicationPublicDto)。文案归属见
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
  @ApiPropertyOptional({ nullable: true }) eliminationStage!: string | null;
  @ApiProperty({ description: '是否有证件照(取图走 :id/id-card-image-url)' })
  hasIdCardImage!: boolean;
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
  @ApiProperty({ description: '证件照短 TTL signed-URL(L3;不入日志/snapshot)' })
  url!: string;

  @ApiProperty({ description: 'URL 过期时刻' })
  expiresAt!: Date;
}

// ============ 招新闭环优化 S2:招新工作台 stats(评审稿 §7.1 五组;纯读聚合,零敏感明文)============
// 各业务态计数与 S1 deriveRecruitmentStage 同源(单一 stage 口径,零第二套判定;评审稿 §7.1 line 365
// 「待处理事项即各 stage 计数」)。物理隔离独立 class(禁继承 / Pick / Omit;沿 api-surface-policy §2.1)。
// 「待人工」normal/high/system 三栏:Q-P4-3 的精确 `riskLevel` 字段待 S4;本切片用 `verifyOutcome` 代理
// (system=ocr_error / high=forgery_warning / normal=其余),已在各字段 description 明确标注。

export class RecruitmentStatsTodayDto {
  @ApiProperty({ description: '今日新报名(createdAt 北京日界当日)' })
  newApplications!: number;
  @ApiProperty({ description: '今日发临时号(verifiedAt 北京日界当日)' })
  tempNoIssued!: number;
  @ApiProperty({ description: '今日人工处理数(reviewedAt 北京日界当日;人工 resolve 时刻)' })
  manualProcessed!: number;
}

export class RecruitmentStatsPendingDto {
  @ApiProperty({ description: '待人工总数(stage=manual;= manual_review 态)' })
  manualTotal!: number;
  @ApiProperty({
    description:
      '待人工·普通(verifyOutcome 代理:非 ocr_error/forgery_warning;riskLevel=normal 精确分栏待 S4)',
  })
  manualNormal!: number;
  @ApiProperty({
    description: '待人工·高风险(verifyOutcome=forgery_warning 代理;riskLevel=high 精确分栏待 S4)',
  })
  manualHigh!: number;
  @ApiProperty({
    description: '待人工·系统异常(verifyOutcome=ocr_error 代理;riskLevel=system 精确分栏待 S4)',
  })
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
