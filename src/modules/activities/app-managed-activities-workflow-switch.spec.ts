import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AppManagedActivitiesService } from './app-managed-activities.service';

// ===== 断点①(全链路贯通 e2e 的第二个发现):开关关闭时抛的码必须**说的是那件事** =====
//
// 历史误用:`activityResponsibilityWorkflow` 关闭时,App 面建草稿抛的是
// `ACTIVITY_ATTENDANCE_DECLARATION_INVALID`(20039「当前活动不能声明考勤已全部提交」)——
// 一个跟「建草稿」毫无关系的码,读日志的人会被引去查考勤。20039 的真身是同 service 里的
// `declareAttendanceComplete`,那里用得对,故不能把 20039 从仓里删掉,只能把这里换掉。
//
// 判据钉的是**码本身**而不是「抛了异常」:后者在换回任何一个错码时都照样绿。

describe('App 管理面建草稿 —— 责任制工作流开关关闭时的错误码', () => {
  function serviceWith(enabled: boolean): AppManagedActivitiesService {
    // 只喂 config:开关判定在方法第一行,走不到其它依赖。
    return new AppManagedActivitiesService(
      undefined as never, // prisma
      undefined as never, // authz
      undefined as never, // activities
      undefined as never, // positions
      undefined as never, // drafts
      undefined as never, // reviews
      undefined as never, // responsibilities
      undefined as never, // workflowQuery
      undefined as never, // auditRecorder
      { activityResponsibilityWorkflow: { enabled } } as never,
    );
  }

  it('开关关闭 ⇒ 恰好抛 ACTIVITY_RESPONSIBILITY_WORKFLOW_NOT_ENABLED(20036 / 503)', async () => {
    const service = serviceWith(false);
    const error = await service
      .create({} as never, { memberId: 'member-1' } as never, {} as never)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(BizException);
    // 整包比对:码、文案、httpStatus 一起钉住 —— 换成任何别的码都红。
    expect((error as BizException).biz).toEqual(BizCode.ACTIVITY_RESPONSIBILITY_WORKFLOW_NOT_ENABLED);
    expect((error as BizException).biz.code).toBe(20036);
  });

  it('反面:抛的不再是 20039 —— 那个码的真身是 declareAttendanceComplete,不是建草稿', async () => {
    const service = serviceWith(false);
    const error = await service
      .create({} as never, { memberId: 'member-1' } as never, {} as never)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect((error as BizException).biz.code).not.toBe(
      BizCode.ACTIVITY_ATTENDANCE_DECLARATION_INVALID.code,
    );
  });

  it('开关打开 ⇒ 不再被这道闸挡住(证明上面两条不是「怎么调都抛 20036」)', async () => {
    const service = serviceWith(true);
    const error = await service
      .create({} as never, { memberId: 'member-1' } as never, {} as never)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    // 开关打开后会继续往下走并因缺依赖而失败 —— 关键是**不是**这枚开关码。
    const code = error instanceof BizException ? error.biz.code : null;
    expect(code).not.toBe(BizCode.ACTIVITY_RESPONSIBILITY_WORKFLOW_NOT_ENABLED.code);
  });
});
