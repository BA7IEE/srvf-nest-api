import {
  APP_STATUS_MANUAL,
  APP_STATUS_PENDING,
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_PROMOTED,
  APP_STATUS_PUBLICITY,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  RISK_LEVEL_HIGH,
  THRESHOLD_CODES,
  type ThresholdCode,
  type ThresholdMarks,
  allThresholdsComplete,
} from './recruitment.constants';
import type { RecruitmentApplicationProgressDto, RecruitmentTodoItemDto } from './recruitment.dto';

// 招新闭环优化 S1(评审稿 §4 状态业务化 + §6 新人进度模型;goal「招新闭环优化 S1」)。
//
// 把机器态 `statusCode`(+ 门槛完成度)派生为业务态 `stage` / 动作码 `nextAction` / 身份文案
// `identityText`,并把 `thresholdMarks` 真投影成门槛 `todoList`,组装公开本人进度模型(§6.1)。
// `deriveRecruitmentStage` 是「单一共享 stage 派生纯函数」,供后续 S2 招新工作台 stats 复用。
//
// **职责边界(纯派生,严守不写不判流转;沿 architecture-boundary §3.1 Presenter)**:
// - ✅ statusCode(+ 门槛完成度)→ stage / nextAction / identityText 的纯映射(评审稿 §4.2)
// - ✅ thresholdMarks → 门槛 todoList 真投影(done 来自实际标记,非写死)
// - ✅ 进度模型 DTO 组装(stageText 由调用方传入的字典 map 解析,本模块不碰 Prisma)
// - ❌ 不改 statusCode / 不做状态机流转判定(评审稿 §14 行为锁 #6;纯展示派生)
// - ❌ 不持有 PrismaService / 不鉴权 / 不审计 / 无副作用
//
// **文案归属(评审稿 §4.1「后端不存展示文案明文」)**:
// - `stageText`(业务态主文案,后台可维护)→ `recruitment_stage` 字典,本模块不内置、由 map 传入;
// - `identityText`(4 身份档)由本切片 goal DoD#1 明确要求纯函数直接产出 → 固化于此(低频、稳定);
// - 门槛展示名(THRESHOLD_NAMES)因本切片 seed 触点仅限 `recruitment_stage`(不建门槛名字典)→ 暂置常量。

// `recruitment_stage` 字典类型 code(prisma/seed.ts seed 同名类型;service 据此查 stageText map)。
export const RECRUITMENT_STAGE_DICT_TYPE = 'recruitment_stage';

// ===== 业务态 stage(派生自 statusCode + 门槛完成度;评审稿 §4.2)=====
// 本切片【已实现】(现有持久数据可派生):
export const STAGE_MANUAL = 'manual'; // manual_review(riskLevel 未引入前一律归此)
export const STAGE_THRESHOLD = 'threshold'; // verified + 门槛未齐
export const STAGE_THRESHOLD_DONE = 'threshold_done'; // verified + 门槛齐(瞬态,自动进下一态)
export const STAGE_EVALUATION = 'evaluation'; // pending_evaluation
export const STAGE_PUBLICITY = 'publicity'; // publicity
export const STAGE_VOLUNTEER = 'volunteer'; // promoted(展示「已转志愿者/待入队」,**禁「已晋升」** Q-P4-8)
export const STAGE_REJECTED = 'rejected'; // rejected
// 招新闭环优化 S4b【已实现】(会话态 / riskLevel 落地;评审稿 §4.2):
export const STAGE_RETAKE = 'retake'; // 待重拍(会话态:OCR 模糊/防伪重拍循环 requiresRetake=true;报名记录未创建)
export const STAGE_CONFIRM = 'confirm'; // 待核对(会话态:mismatch 待三选一;报名记录未创建)
export const STAGE_MANUAL_HIGH = 'manual_high'; // 待人工·高风险复核(manual_review + riskLevel=high;**申请人侧文案中性同 manual**)

// ===== 下一步动作码(机器码;前端据此渲染按钮文案;评审稿 §6.2)=====
export const NEXT_ACTION_WAIT_REVIEW = 'wait-review';
export const NEXT_ACTION_COMPLETE_THRESHOLD = 'complete-threshold';
export const NEXT_ACTION_WAIT_EVALUATION = 'wait-evaluation';
export const NEXT_ACTION_VIEW_PUBLICITY = 'view-publicity';
export const NEXT_ACTION_APPLY_TEAMJOIN = 'apply-teamjoin';
// S4b 会话态动作码(§6.2):
export const NEXT_ACTION_RETAKE = 'retake'; // 待重拍 → 重新拍照上传
export const NEXT_ACTION_CONFIRM_OCR = 'confirm-ocr'; // 待核对 → 用OCR结果 / 改填写 / 确认OCR错

// ===== 身份文案(评审稿 §5.3 / §6.1;goal DoD#1 要求纯函数直接产出)=====
const IDENTITY_APPLICANT = '报名申请人'; // 报名 / 初审 / 门槛 / 未通过
const IDENTITY_CANDIDATE = '招新候选人'; // 综合评定 / 公示
const IDENTITY_VOLUNTEER = '志愿者'; // 已发永久编号(**禁「已晋升」**)

// ===== 门槛展示名(5 项固定 code;来源 recruitment-applications.admin.controller「巡山×2/培训/红十字/BSAFE」)=====
// 导出供 S2 工作台 stats 的「各门槛完成分布」复用同一份展示名(零第二份副本;不改 deriveRecruitmentStage 口径)。
export const THRESHOLD_NAMES: Record<ThresholdCode, string> = {
  patrol1: '巡山一',
  patrol2: '巡山二',
  training: '培训',
  redCross: '红十字',
  bsafe: 'BSAFE',
};

// 派生入参 = 现有持久数据(评审稿 §6.1;S1 4 字段)+ S4b OCR 六分流派生信号(全可选,向后兼容):
// - riskLevel:application.riskLevel(manual_review + high → manual_high;§4.2)
// - requiresRetake / pendingOcrConfirm:**会话态**(报名记录尚未创建,submit 延迟响应派生 retake/confirm)。
export interface RecruitmentStageInput {
  statusCode: string;
  thresholdMarks: ThresholdMarks | null;
  tempNo: string | null;
  promotedMemberId: string | null;
  riskLevel?: string | null;
  requiresRetake?: boolean;
  pendingOcrConfirm?: boolean;
}

export interface RecruitmentStageDerivation {
  stage: string;
  nextAction: string | null;
  identityText: string;
}

/**
 * 机器态 `statusCode`(+ 门槛完成度 + S4b riskLevel / 会话态)→ 业务态 `stage` / 动作码 / 身份文案(纯函数,零副作用)。
 * 评审稿 §4.2 映射。**会话态优先**(报名记录尚未创建):requiresRetake → `retake` / pendingOcrConfirm → `confirm`。
 * `manual_review` + `riskLevel=high` → `manual_high`(高风险分流仅后台用,**申请人侧文案中性同 manual**;goal 三③)。
 * `promoted` → `volunteer`,口径「已转志愿者/待入队」,**全程禁「已晋升」**(Q-P4-8)。
 * 退役态 `pending_verification`(OCR 改造后不再产生)与未知 statusCode 防御性归「待人工核验」。
 */
export function deriveRecruitmentStage(input: RecruitmentStageInput): RecruitmentStageDerivation {
  // 会话态优先(报名记录尚未创建;submit 六分流延迟响应派生)。
  if (input.requiresRetake) {
    return {
      stage: STAGE_RETAKE,
      nextAction: NEXT_ACTION_RETAKE,
      identityText: IDENTITY_APPLICANT,
    };
  }
  if (input.pendingOcrConfirm) {
    return {
      stage: STAGE_CONFIRM,
      nextAction: NEXT_ACTION_CONFIRM_OCR,
      identityText: IDENTITY_APPLICANT,
    };
  }
  switch (input.statusCode) {
    case APP_STATUS_VERIFIED:
      return allThresholdsComplete(input.thresholdMarks)
        ? {
            stage: STAGE_THRESHOLD_DONE,
            nextAction: NEXT_ACTION_WAIT_EVALUATION,
            identityText: IDENTITY_APPLICANT,
          }
        : {
            stage: STAGE_THRESHOLD,
            nextAction: NEXT_ACTION_COMPLETE_THRESHOLD,
            identityText: IDENTITY_APPLICANT,
          };
    case APP_STATUS_PENDING_EVALUATION:
      return {
        stage: STAGE_EVALUATION,
        nextAction: NEXT_ACTION_WAIT_EVALUATION,
        identityText: IDENTITY_CANDIDATE,
      };
    case APP_STATUS_PUBLICITY:
      return {
        stage: STAGE_PUBLICITY,
        nextAction: NEXT_ACTION_VIEW_PUBLICITY,
        identityText: IDENTITY_CANDIDATE,
      };
    case APP_STATUS_PROMOTED:
      return {
        stage: STAGE_VOLUNTEER,
        nextAction: NEXT_ACTION_APPLY_TEAMJOIN,
        identityText: IDENTITY_VOLUNTEER,
      };
    case APP_STATUS_REJECTED:
      return { stage: STAGE_REJECTED, nextAction: null, identityText: IDENTITY_APPLICANT };
    case APP_STATUS_MANUAL:
      // 高风险复核分流(riskLevel=high):stage 区分 manual_high(后台三栏用),申请人侧文案中性同 manual。
      return {
        stage: input.riskLevel === RISK_LEVEL_HIGH ? STAGE_MANUAL_HIGH : STAGE_MANUAL,
        nextAction: NEXT_ACTION_WAIT_REVIEW,
        identityText: IDENTITY_APPLICANT,
      };
    case APP_STATUS_PENDING: // 退役态(历史行防御);与未知 statusCode 同归「待人工核验」
    default:
      return {
        stage: STAGE_MANUAL,
        nextAction: NEXT_ACTION_WAIT_REVIEW,
        identityText: IDENTITY_APPLICANT,
      };
  }
}

/** 门槛清单真投影:5 项固定 code → { code, name, done };done 来自 thresholdMarks 实际标记(评审稿 §6.1)。 */
export function buildRecruitmentTodoList(marks: ThresholdMarks | null): RecruitmentTodoItemDto[] {
  return THRESHOLD_CODES.map((code) => ({
    code,
    name: THRESHOLD_NAMES[code],
    done: marks?.[code] != null,
  }));
}

// 组装入参最小结构约束(沿 attendance-presenter RowLike 范式;只声明真正读取的字段,
// service 侧把 RecruitmentApplication / RecruitmentCycle 行按结构子类型直接传入)。
export type RecruitmentProgressSource = {
  statusCode: string;
  tempNo: string | null;
  thresholdMarks: unknown; // Prisma Json
  promotedMemberId: string | null;
  riskLevel: string | null; // S4b:manual_review + high → manual_high(申请人侧文案中性)
};

export type RecruitmentProgressCycle = {
  meetingInfo: string | null;
  qqGroup: string | null;
  notifyTemplate: unknown; // Prisma Json
};

/**
 * 组装公开本人进度模型(评审稿 §6.1)。`stageText` 由调用方传入的 `recruitment_stage` 字典 map 解析
 * (本模块不碰 Prisma,守 §4.1「后端不存展示文案明文」);字典缺该 stage 时回退 stage 机器码(防空、可自证)。
 * `statusText` 本切片同 `stageText`(主文案在字典;更细/动态文案延后,守 §4.1)。
 * `memberNo` 恒 null(公开无账号查询不泄编号;经登录态 app 侧另见)。招新可用性收口 F4-3b 起,
 * promoted 行经 User openid/phone 锚 fall-through 可达 → stage=volunteer 引导态(「已转志愿者 / 待入队」)。
 */
export function assembleRecruitmentProgress(
  app: RecruitmentProgressSource,
  cycle: RecruitmentProgressCycle,
  stageTextByCode: ReadonlyMap<string, string>,
): RecruitmentApplicationProgressDto {
  const marks = app.thresholdMarks as ThresholdMarks | null;
  const { stage, nextAction, identityText } = deriveRecruitmentStage({
    statusCode: app.statusCode,
    thresholdMarks: marks,
    tempNo: app.tempNo,
    promotedMemberId: app.promotedMemberId,
    riskLevel: app.riskLevel,
  });
  const stageText = stageTextByCode.get(stage) ?? stage;
  return {
    stage,
    stageText,
    statusText: stageText,
    nextAction,
    tempNo: app.tempNo,
    memberNo: null,
    identityText,
    todoList: buildRecruitmentTodoList(marks),
    meetingInfo: cycle.meetingInfo,
    qqGroup: cycle.qqGroup,
    notice: cycle.notifyTemplate as Record<string, unknown> | null,
  };
}
