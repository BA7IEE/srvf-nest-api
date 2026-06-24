import {
  APP_STATUS_MANUAL,
  APP_STATUS_PENDING,
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_PROMOTED,
  APP_STATUS_PUBLICITY,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  THRESHOLD_CODES,
  type ThresholdMarks,
} from './recruitment.constants';
import {
  NEXT_ACTION_APPLY_TEAMJOIN,
  NEXT_ACTION_COMPLETE_THRESHOLD,
  NEXT_ACTION_VIEW_PUBLICITY,
  NEXT_ACTION_WAIT_EVALUATION,
  NEXT_ACTION_WAIT_REVIEW,
  STAGE_EVALUATION,
  STAGE_MANUAL,
  STAGE_PUBLICITY,
  STAGE_REJECTED,
  STAGE_THRESHOLD,
  STAGE_THRESHOLD_DONE,
  STAGE_VOLUNTEER,
  assembleRecruitmentProgress,
  buildRecruitmentTodoList,
  deriveRecruitmentStage,
} from './recruitment-progress-presenter';

// 招新闭环优化 S1 单测:stage 派生纯函数全分支 + 门槛 todoList 真投影 + 进度模型组装。
// 锁定评审稿 §4.2 映射 + Q-P4-8(promoted 禁「已晋升」)+ goal DoD#1/#3 边界(memberNo 恒 null)。

const ALL_MARKS: ThresholdMarks = Object.fromEntries(
  THRESHOLD_CODES.map((c) => [c, { at: '2026-06-24T00:00:00.000Z', by: 'admin-1' }]),
);

function input(over: {
  statusCode: string;
  thresholdMarks?: ThresholdMarks | null;
  tempNo?: string | null;
  promotedMemberId?: string | null;
}) {
  return {
    statusCode: over.statusCode,
    thresholdMarks: over.thresholdMarks ?? null,
    tempNo: over.tempNo ?? null,
    promotedMemberId: over.promotedMemberId ?? null,
  };
}

describe('deriveRecruitmentStage(评审稿 §4.2 全分支)', () => {
  it('manual_review → manual / wait-review / 报名申请人', () => {
    expect(deriveRecruitmentStage(input({ statusCode: APP_STATUS_MANUAL }))).toEqual({
      stage: STAGE_MANUAL,
      nextAction: NEXT_ACTION_WAIT_REVIEW,
      identityText: '报名申请人',
    });
  });

  it('verified + 门槛未齐(空)→ threshold / complete-threshold / 报名申请人', () => {
    expect(
      deriveRecruitmentStage(input({ statusCode: APP_STATUS_VERIFIED, tempNo: 'T20260001' })),
    ).toEqual({
      stage: STAGE_THRESHOLD,
      nextAction: NEXT_ACTION_COMPLETE_THRESHOLD,
      identityText: '报名申请人',
    });
  });

  it('verified + 门槛部分完成 → 仍 threshold(未齐)', () => {
    const partial: ThresholdMarks = { patrol1: { at: '2026-06-24T00:00:00.000Z', by: 'a' } };
    expect(
      deriveRecruitmentStage(input({ statusCode: APP_STATUS_VERIFIED, thresholdMarks: partial }))
        .stage,
    ).toBe(STAGE_THRESHOLD);
  });

  it('verified + 5 门槛全齐 → threshold_done / wait-evaluation', () => {
    expect(
      deriveRecruitmentStage(input({ statusCode: APP_STATUS_VERIFIED, thresholdMarks: ALL_MARKS })),
    ).toEqual({
      stage: STAGE_THRESHOLD_DONE,
      nextAction: NEXT_ACTION_WAIT_EVALUATION,
      identityText: '报名申请人',
    });
  });

  it('pending_evaluation → evaluation / wait-evaluation / 招新候选人', () => {
    expect(deriveRecruitmentStage(input({ statusCode: APP_STATUS_PENDING_EVALUATION }))).toEqual({
      stage: STAGE_EVALUATION,
      nextAction: NEXT_ACTION_WAIT_EVALUATION,
      identityText: '招新候选人',
    });
  });

  it('publicity → publicity / view-publicity / 招新候选人', () => {
    expect(deriveRecruitmentStage(input({ statusCode: APP_STATUS_PUBLICITY }))).toEqual({
      stage: STAGE_PUBLICITY,
      nextAction: NEXT_ACTION_VIEW_PUBLICITY,
      identityText: '招新候选人',
    });
  });

  it('promoted → volunteer / apply-teamjoin / 志愿者;**禁「已晋升」**(Q-P4-8)', () => {
    const d = deriveRecruitmentStage(
      input({ statusCode: APP_STATUS_PROMOTED, promotedMemberId: 'm-1' }),
    );
    expect(d).toEqual({
      stage: STAGE_VOLUNTEER,
      nextAction: NEXT_ACTION_APPLY_TEAMJOIN,
      identityText: '志愿者',
    });
    expect(JSON.stringify(d)).not.toContain('已晋升');
    expect(d.identityText).not.toContain('晋升');
  });

  it('rejected → rejected / null(终态,无动作)/ 报名申请人', () => {
    expect(deriveRecruitmentStage(input({ statusCode: APP_STATUS_REJECTED }))).toEqual({
      stage: STAGE_REJECTED,
      nextAction: null,
      identityText: '报名申请人',
    });
  });

  it('退役态 pending_verification → 防御性归 manual', () => {
    expect(deriveRecruitmentStage(input({ statusCode: APP_STATUS_PENDING })).stage).toBe(
      STAGE_MANUAL,
    );
  });

  it('未知 statusCode → 防御性默认 manual(总函数,不抛)', () => {
    expect(deriveRecruitmentStage(input({ statusCode: 'some_future_state' })).stage).toBe(
      STAGE_MANUAL,
    );
  });
});

describe('buildRecruitmentTodoList(门槛真投影)', () => {
  it('null marks → 5 项全 done:false,顺序与 THRESHOLD_CODES 一致', () => {
    const list = buildRecruitmentTodoList(null);
    expect(list).toHaveLength(THRESHOLD_CODES.length);
    expect(list.map((i) => i.code)).toEqual([...THRESHOLD_CODES]);
    expect(list.every((i) => i.done === false)).toBe(true);
    expect(list.every((i) => i.name.length > 0)).toBe(true);
  });

  it('部分标记 → done 来自实际数据(非写死)', () => {
    const partial: ThresholdMarks = {
      patrol1: { at: '2026-06-24T00:00:00.000Z', by: 'a' },
      training: { at: '2026-06-24T00:00:00.000Z', by: 'a' },
    };
    const byCode = Object.fromEntries(
      buildRecruitmentTodoList(partial).map((i) => [i.code, i.done]),
    );
    expect(byCode.patrol1).toBe(true);
    expect(byCode.training).toBe(true);
    expect(byCode.patrol2).toBe(false);
    expect(byCode.redCross).toBe(false);
    expect(byCode.bsafe).toBe(false);
  });

  it('全标记 → 5 项全 done:true', () => {
    expect(buildRecruitmentTodoList(ALL_MARKS).every((i) => i.done)).toBe(true);
  });
});

describe('assembleRecruitmentProgress(进度模型组装)', () => {
  const cycle = {
    meetingInfo: '6/30 见面会',
    qqGroup: 'QQ-123',
    notifyTemplate: { verified: '已发临时号' },
  };
  const stageTextByCode = new Map<string, string>([
    [STAGE_THRESHOLD, '门槛未完成'],
    [STAGE_VOLUNTEER, '已转志愿者 / 待入队'],
  ]);

  it('verified + 门槛未齐 → 进度模型字段齐全(stageText 取字典 / todoList 投影 / memberNo 恒 null)', () => {
    const app = {
      statusCode: APP_STATUS_VERIFIED,
      tempNo: 'T20260001',
      thresholdMarks: { patrol1: { at: '2026-06-24T00:00:00.000Z', by: 'a' } },
      promotedMemberId: null,
    };
    const dto = assembleRecruitmentProgress(app, cycle, stageTextByCode);
    expect(dto.stage).toBe(STAGE_THRESHOLD);
    expect(dto.stageText).toBe('门槛未完成');
    expect(dto.statusText).toBe('门槛未完成'); // S1:同 stageText
    expect(dto.nextAction).toBe(NEXT_ACTION_COMPLETE_THRESHOLD);
    expect(dto.tempNo).toBe('T20260001');
    expect(dto.memberNo).toBeNull(); // 覆盖边界:公开查询不可达 promoted 行
    expect(dto.identityText).toBe('报名申请人');
    expect(dto.todoList.find((i) => i.code === 'patrol1')?.done).toBe(true);
    expect(dto.todoList.find((i) => i.code === 'patrol2')?.done).toBe(false);
    expect(dto.meetingInfo).toBe('6/30 见面会');
    expect(dto.qqGroup).toBe('QQ-123');
    expect(dto.notice).toEqual({ verified: '已发临时号' });
  });

  it('字典缺该 stage → stageText 回退 stage 机器码(防空)', () => {
    const app = {
      statusCode: APP_STATUS_PENDING_EVALUATION,
      tempNo: 'T20260002',
      thresholdMarks: null,
      promotedMemberId: null,
    };
    const dto = assembleRecruitmentProgress(app, cycle, stageTextByCode);
    expect(dto.stage).toBe(STAGE_EVALUATION);
    expect(dto.stageText).toBe(STAGE_EVALUATION); // map 无该项 → 回退 code
  });

  it('promoted 行组装 → 全输出无「已晋升」(Q-P4-8)', () => {
    const app = {
      statusCode: APP_STATUS_PROMOTED,
      tempNo: 'T20260003',
      thresholdMarks: ALL_MARKS,
      promotedMemberId: 'm-9',
    };
    const dto = assembleRecruitmentProgress(app, cycle, stageTextByCode);
    expect(dto.stage).toBe(STAGE_VOLUNTEER);
    expect(dto.memberNo).toBeNull();
    expect(JSON.stringify(dto)).not.toContain('已晋升');
  });
});
