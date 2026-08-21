// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// surface: Open 无账号公开面
// contractVersion: 0.67.0
// generatorVersion: 1.0.0
// inputDigest: sha256:06996f76bb74b095f0f393cf4c1495c11c48c7cf4da7c8451373b4684654113d
//
// ⚠️ 本文件**只有类型与调用签名**:不含 baseURL、不含令牌、不含任何鉴权逻辑。
//    登录态怎么带、令牌怎么刷新,由消费方在注入的 Fetcher 里自理
//    (登录/刷新的三步接线见 docs/handoff/admin-web.md §3.1)。

import type {
  ApiEnvelope,
  PageResult,
  FetchRequest,
  Fetcher,
  ContentAttachmentDto,
  ContentReadDetailDto,
  ContentReadListItemDto,
  PageResultDto,
  PublicCertificateClaimDto,
  PublicCertificateClaimResultDto,
  PublicCertificateStandardOptionDto,
  PublicCertificateStandardOptionsResponseDto,
  PublicRecruitmentPublicityItemDto,
  PublicRecruitmentPublicityResponseDto,
  RecruitmentApplicationProgressDto,
  RecruitmentCertificateProgressItemDto,
  RecruitmentOcrCardWarningsDto,
  RecruitmentOcrDetailDto,
  RecruitmentOcrFieldDto,
  RecruitmentOcrRecognizeResponseDto,
  RecruitmentQueryByPhoneDto,
  RecruitmentQueryDto,
  RecruitmentRebindPhoneDto,
  RecruitmentRebindWechatDto,
  RecruitmentSendCodeDto,
  RecruitmentSendCodeResponseDto,
  RecruitmentSubmitResultDto,
  RecruitmentTodoItemDto,
  RecruitmentVerifyCodeDto,
  RecruitmentVerifyCodeResponseDto,
  RecruitmentWithdrawDto,
  WithdrawCertificateClaimDto,
} from './types';

export type { ApiEnvelope, PageResult, FetchRequest, Fetcher };

export function createOpenClient(fetcher: Fetcher) {
  return {
    /** 公开内容列表(仅 published+public;keyword/tags/contentTypeCode 过滤;无 body;throttler content-public) [public] */
    ContentPublicControllerList(query?: { "page"?: number; "pageSize"?: number; "contentTypeCode"?: string; "keyword"?: string; "tags"?: string[] }): Promise<ApiEnvelope<PageResultDto & { "items": ContentReadListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": ContentReadListItemDto[] }>({ method: "GET", path: "/api/open/v1/contents", query });
    },
    /** 公开内容详情(仅 published+public,否则 404 防枚举;正文占位改写 + 附件签名 + viewCount 自增;throttler content-public) [public] */
    ContentPublicControllerDetail(id: string): Promise<ApiEnvelope<ContentReadDetailDto>> {
      return fetcher<ContentReadDetailDto>({ method: "GET", path: `/api/open/v1/contents/${id}` });
    },
    /** 公开报名提交(无账号;multipart:payload JSON 串 + idCardImage 文件 + 必填 signatureImage 签名图〔发号后随档案长期留存〕;⚠️ 契约收紧:signatureImage、payload.privacyConsentAccepted=true、已验手机 phoneVerificationToken 均必填,缺省/false → 40000;wechatCode 可选〔提供时另取 openid〕;免费校验通过后才调付费 OCR;大陆证件 OCR 匹配+防伪+清晰→发临时编号,否则/其余证件→人工待核;OCR 改造后提交端对 OCR 永不硬报错,通道未配/上游失败均转人工;throttler recruitment) [public] */
    RecruitmentPublicControllerSubmit(): Promise<ApiEnvelope<RecruitmentSubmitResultDto>> {
      return fetcher<RecruitmentSubmitResultDto>({ method: "POST", path: "/api/open/v1/recruitment/applications" });
    },
    /** 公开查询本人报名进度(凭新 wx.login code 换 openid;返回本人最近一条进度模型:业务态 stage + 字典文案 + 门槛 todoList 真投影 + 临时编号 + 轮次通知;F4:发号后〔报名行 openid 已清〕经账号 openid 锚 fall-through 返 stage=volunteer 引导态〔已转志愿者/待入队,memberNo 恒 null〕;无匹配→28002;throttler recruitment) [public] */
    RecruitmentPublicControllerQuery(body: RecruitmentQueryDto): Promise<ApiEnvelope<RecruitmentApplicationProgressDto>> {
      return fetcher<RecruitmentApplicationProgressDto>({ method: "POST", path: "/api/open/v1/recruitment/applications/query", body });
    },
    /** 公开查询本人报名进度②(手机+验证码;无账号;验码消费一码 → 手机定位最近一条报名进度模型,与微信 code 查询同出参/同派生口径;F4:发号后〔报名行 phone 已清〕经账号 phone / 档案手机锚 fall-through 返 stage=volunteer 引导态;码错→24010 / 无匹配→28002;throttler recruitment) [public] */
    RecruitmentPublicControllerQueryByPhone(body: RecruitmentQueryByPhoneDto): Promise<ApiEnvelope<RecruitmentApplicationProgressDto>> {
      return fetcher<RecruitmentApplicationProgressDto>({ method: "POST", path: "/api/open/v1/recruitment/applications/query-by-phone", body });
    },
    /** 自助换手机换绑(无账号;双验:当前手机验码校验本人 + 新手机验码;更 application.phone + 换绑历史追加;返更新后进度模型;码错→24010 / 无报名→28002 / 新旧手机相同→40000;审计 rebind-phone;throttler recruitment) [public] */
    RecruitmentPublicControllerRebindPhone(body: RecruitmentRebindPhoneDto): Promise<ApiEnvelope<RecruitmentApplicationProgressDto>> {
      return fetcher<RecruitmentApplicationProgressDto>({ method: "POST", path: "/api/open/v1/recruitment/applications/rebind-phone", body });
    },
    /** 自助换微信换绑(无账号;当前手机验码校验本人 → code2session 新微信 → 更 application.openid;返更新后进度模型;码错→24010 / 无报名→28002 / 新微信已绑本轮他人报名→28051;审计 rebind-wechat;throttler recruitment) [public] */
    RecruitmentPublicControllerRebindWechat(body: RecruitmentRebindWechatDto): Promise<ApiEnvelope<RecruitmentApplicationProgressDto>> {
      return fetcher<RecruitmentApplicationProgressDto>({ method: "POST", path: "/api/open/v1/recruitment/applications/rebind-wechat", body });
    },
    /** 公开证件 OCR 识别预填(无账号;multipart:documentTypeCode + idCardImage;OCR 回填姓名/证件号供申请人确认/修正;无状态不落库;非 OCR 类型→ocrSupported:false;不清晰→clarityOk:false;throttler recruitment) [public] */
    RecruitmentPublicControllerRecognize(): Promise<ApiEnvelope<RecruitmentOcrRecognizeResponseDto>> {
      return fetcher<RecruitmentOcrRecognizeResponseDto>({ method: "POST", path: "/api/open/v1/recruitment/applications/recognize" });
    },
    /** 自助撤销报名(无账号;凭证双通道二选一:wechatCode〔code2session 定位〕或 phone+code〔验码消费一码〕;非终态皆可撤 → withdrawn 终态,撤销后同轮同证件号/同微信/同手机可重报;已发号/未通过/已撤销 → 28052;返更新后进度模型 stage=withdrawn;审计 withdraw;throttler recruitment) [public] */
    RecruitmentPublicControllerWithdraw(body: RecruitmentWithdrawDto): Promise<ApiEnvelope<RecruitmentApplicationProgressDto>> {
      return fetcher<RecruitmentApplicationProgressDto>({ method: "POST", path: "/api/open/v1/recruitment/applications/withdraw", body });
    },
    /** 公开提交一条证书申报(无账号;一证一行 —— 同类别可提交多张,互不覆盖;multipart 文件位 images 1~3 张;凭证双通道二选一:wechatCode 或 phone+code;suggestedStandardId 可不传〔「不确定」是合法选项〕且只是建议,后台不据此自动通过;每份报名最多 10 条未撤回申报,超限 28059;throttler recruitment) [public] */
    RecruitmentPublicControllerSubmitCertificateClaim(): Promise<ApiEnvelope<PublicCertificateClaimResultDto>> {
      return fetcher<PublicCertificateClaimResultDto>({ method: "POST", path: "/api/open/v1/recruitment/certificate-claims" });
    },
    /** 重传单条证书申报(无账号;只换这一条的图与自报事实,**不影响同类别其他申报**;回 SUBMITTED 并清上一轮审核痕迹;version 为 CAS,不符 28058;已通过的申报不可由本人直接改〔需管理员先撤回审核〕→ 28057;throttler recruitment) [public] */
    RecruitmentPublicControllerResubmitCertificateClaim(id: string): Promise<ApiEnvelope<PublicCertificateClaimResultDto>> {
      return fetcher<PublicCertificateClaimResultDto>({ method: "POST", path: `/api/open/v1/recruitment/certificate-claims/${id}/resubmit` });
    },
    /** 撤回单条证书申报(无账号;WITHDRAWN 是终态,要重来请新提交一条 —— 不复用行;已发号的申报不可撤 → 28057;version 为 CAS;撤回会在同一事务重算证书门槛〔同类别若还有另一张已通过证书,门槛仍成立〕;throttler recruitment) [public] */
    RecruitmentPublicControllerWithdrawCertificateClaim(id: string, body: WithdrawCertificateClaimDto): Promise<ApiEnvelope<PublicCertificateClaimResultDto>> {
      return fetcher<PublicCertificateClaimResultDto>({ method: "POST", path: `/api/open/v1/recruitment/certificate-claims/${id}/withdraw`, body });
    },
    /** 公开证书标准选项(无账号;仅生效的正式证书标准,按招新证书类别过滤;currentlyRecognized=false 表示已收录待认定,后台不据此自动通过;不含认定规则细节;throttler recruitment) [public] */
    RecruitmentPublicControllerCertificateStandards(): Promise<ApiEnvelope<PublicCertificateStandardOptionsResponseDto>> {
      return fetcher<PublicCertificateStandardOptionsResponseDto>({ method: "GET", path: "/api/open/v1/recruitment/certificate-standards" });
    },
    /** H5 报名前手机发码(无账号;SmsPurpose=RECRUITMENT_BIND;F4:放行=有开放轮 或 手机命中未清除报名记录〔闭轮自助查询/换绑链恢复〕,闭轮陌生手机返防枚举泛化 200 不发码零留痕;手机维度 60s 间隔/10 条日限〔跨 purpose 合计〕+ throttler recruitment 双层兜底) [public] */
    RecruitmentPublicControllerSendCode(body: RecruitmentSendCodeDto): Promise<ApiEnvelope<RecruitmentSendCodeResponseDto>> {
      return fetcher<RecruitmentSendCodeResponseDto>({ method: "POST", path: "/api/open/v1/recruitment/identity/send-code", body });
    },
    /** H5 报名前验码 → 发短时一次性身份令牌(无账号;验码成功落会话行 + 返 phoneVerificationToken〔30min 内随报名提交出示,明文仅一次性返回〕;码错/过期/超次统一 24010;F4:轮次锚=开放轮 或 手机命中未清除报名记录所在轮〔闭轮+无命中→防枚举统一 24010〕;throttler recruitment) [public] */
    RecruitmentPublicControllerVerifyCode(body: RecruitmentVerifyCodeDto): Promise<ApiEnvelope<RecruitmentVerifyCodeResponseDto>> {
      return fetcher<RecruitmentVerifyCodeResponseDto>({ method: "POST", path: "/api/open/v1/recruitment/identity/verify-code", body });
    },
    /** 公开公示名单(无账号;当前公示中轮次的姓名+拟发编号,与后台预览/实发同源推算;无公示中名单返回 cycleYear=null + 空 items;throttler recruitment) [public] */
    RecruitmentPublicControllerPublicity(): Promise<ApiEnvelope<PublicRecruitmentPublicityResponseDto>> {
      return fetcher<PublicRecruitmentPublicityResponseDto>({ method: "GET", path: "/api/open/v1/recruitment/publicity" });
    },
  };
}
