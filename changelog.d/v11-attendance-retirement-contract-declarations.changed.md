### Changed

- 旧考勤 HTTP 入口及相关响应已迁移至新版参与、结算和账本模型。以下逐操作记录破坏性差异、调用方影响、迁移方向与实际回退条件；旧、新对象和权限并非一一对应。具体路径和字段见 `docs/handoff/v11-legacy-attendance-retired-routes.md` 与 `docs/handoff/v11-participation-projection.md`。
- 这些记录供维护者和消费者审阅；申报不是批准，不授权合并、部署或数据迁移。独立 Admin 前端已有本地适配，但真实联调、其他消费者和回退方案尚未验证。

<!-- contract-breaking
operation: GET /api/admin/v1/activities
reason: 活动列表不再以旧 Sheet 数作为结算统计，报名头统计与有权限的新版提交版本统计分离。
impact: 响应 items[].attendanceSheetCount 被删除；使用该字段的调用方会取不到值。旧版调用方的类型可能仍声明该字段；独立 Admin 前端已有本地适配，真实联调和其他消费者仍需验证。
migration: 需要统计时显式请求 includeStats；保留 registrationCount 原报名头口径，按 settlementStats.available、数字存在性和无权限省略分别展示 submittedVersionCount。该数是曾提交版本数，不能称 Sheet 数、人数或本人待办。
rollback: 经批准可协调恢复旧 ActivityListItemDto 与 ActivitiesService.attachStats 的旧查询、合同和调用方；需核验旧 Sheet 是否覆盖新结算事实及原组织权限，不能把新账本自动反填成旧数。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/reconciliation
reason: 活动对账改以当前已入账结果、身份日行和正式时长为事实来源，移除旧已审核 Sheet 行数语义。
impact: registered/temporary 的 approvedRecordCount 删除，outcome 增加结果值，totalServiceHours 可为空；旧版前端若仍用旧字段、旧分组和旧单位，存在漏展示与误把 null 显示为零的风险；独立前端已有本地适配，真实联调待验证。
migration: 适配 registered、temporary、unclassified 三组及每人 sessions、recordCount、postedResultCount；分别处理 pending/other 与未知时长，不能把身份×北京日行数当旧 Sheet 记录数。保留活动范围及两项读取权限。
rollback: 经批准恢复旧 ActivityParticipationQueryService.reconciliation 的 Sheet 查询、对应 DTO 和旧客户端；先验证历史与新版本数据的覆盖和权限，新入账结果不能保证反映在旧 Sheet。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/participation-summary
reason: 参与汇总改用正式结果和可验证时长，分母或时长不可确定时允许返回 null。
impact: attendanceRate 与 totalServiceHours 从必有数值变为可空；旧调用方若直接格式化或乘算会把未知误判为零或报错。
migration: 区分 null、实际零值、关闸 20153/503 与请求失败；根据新版 DTO 的正式结果和来源字段更新展示，不能用旧 Sheet 行数推导到场。
rollback: 经批准恢复此入口的旧参与汇总查询、DTO 及消费者；验证旧表与新 posted 版本在同一活动下的差异，不保证回退后新事实可见。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities
reason: 负责人列表不再横读旧 Sheet 或从旧单状态推断结算待办。
impact: 列表项 unresolvedAttendanceSheets 删除；nextAction 语义随之变化，null 只表示未推断，不证明已无待办或已完成结算。
migration: 移除旧单数量及旧待办分支；继续显示生命周期状态和报名待审数。需结算事实时由有权限的用户另查对应活动详情/结算工作台，不把列表缺值当 0。
rollback: 经批准逆向恢复 ActivityWorkflowQueryService.list 的旧 Sheet 分组和原列表 DTO/策略及客户端；需复核列表可见范围与旧表是否存在、是否覆盖当前结算。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities
reason: 创建后返回的新活动详情去掉旧 Sheet counts/closure，并避免为构造写后响应额外查询结算。
impact: counts.attendanceSheets、counts.unresolvedAttendanceSheets 和 closure 及其嵌套字段删除；写后响应的 settlement 为 not-requested。
migration: 创建成功后按 activity、counts、workflow 消费基础响应，不把 not-requested 当无权或完成；若确需结算摘要再 GET 该活动详情，单独处理其 scoped 权限、关闸与失败。
rollback: 经批准恢复 AppManagedActivitiesService.create 的旧详情装配及旧 DTO/查询和生成客户端；这只回退响应代码，不撤销已经创建的活动，也不保证旧 Sheet 数据存在。
-->

<!-- contract-breaking
operation: PUT /api/app/v1/my/managed-activities/{activityId}/cover
reason: 封面更新后的详情响应沿统一新版投影，不再在成功写后额外请求结算数据。
impact: 原详情中两个旧 Sheet 数和 closure 及其嵌套字段删除，settlement.availability 为 not-requested；封面写入语义与返回模型应分开处理。
migration: 接收封面写成功后按 workflow 与 activity 更新界面；确需结算摘要时再 GET 活动详情并独立处理权限/关闸/失败，不能将 not-requested 当零。
rollback: 经批准恢复封面 handler 的旧 detail 返回路径、旧 DTO 及调用方；回退响应代码不会自动撤销已写入的封面或存储对象，需另按已批准的操作恢复。
-->

<!-- contract-breaking
operation: PUT /api/app/v1/my/managed-activities/{activityId}/gallery
reason: 图集更新后的详情响应沿统一新版投影，不再为写后格式化增加结算查询。
impact: 原详情的两个旧 Sheet 数和 closure 及其嵌套字段删除，settlement 标记 not-requested；已成功的图集变更不会因后续摘要请求失败而自动撤销。
migration: 用新版 activity/workflow 更新图集和生命周期 UI；需要结算时另发详情 GET，区分无权、关闸、请求失败，不推断图集写失败。
rollback: 经批准恢复图集 handler 的旧 detail 返回路径及旧 DTO/客户端；该代码回退不自动恢复已经保存的图集或删除存储对象。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}
reason: 负责人详情以生命周期 workflow 与经活动 scoped 权限保护的新版 settlement 摘要替换旧 closure/Sheet 聚合。
impact: counts 两个旧 Sheet 字段、closure 及其子字段删除；基础活动详情与结算可见性不再是同一判断，消费者旧模型会失配。
migration: 消费 workflow.status/nextAction；独立 GET 按 settlement 的 forbidden、workflow-disabled、available 分支展示，共用 DTO 的 not-requested 是写后形态。available 时 runStatus=null 是无 run；activeClosure 缺省是无 active 记录，不能证明账本最终生效；workbenchPath 不授予写权。
rollback: 经批准恢复旧详情 loader、ActivityClosurePolicy 投影、旧 DTO 和对应客户端；先核验 App 准入、活动范围、历史 Sheet 与当前正式数据差异，不能假定新版结算能无损回写旧字段。
-->

<!-- contract-breaking
operation: PATCH /api/app/v1/my/managed-activities/{activityId}
reason: 活动资料更新后复用新版基础详情，不在已提交写操作后附加可能失败的结算读取。
impact: 两个旧 Sheet 数、closure 及其子字段从响应删除；settlement 为 not-requested，原写权限和更新结果不应与摘要可用性混同。
migration: 更新成功后使用新版 activity/workflow；需要结算摘要再 GET 详情，单独显示失败和无权，避免把后续 GET 失败误认为 PATCH 已回滚。
rollback: 经批准恢复 update 的旧 detail 响应链、DTO 和客户端；恢复代码不会自动撤销先前已提交的活动修改。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/direct-publish
reason: 直接发布成功后的详情使用新版 workflow/settlement 形状，避免写后依赖新结算读取。
impact: 两个旧 Sheet 数、closure 及其子字段被移除；写后 settlement 为 not-requested，调用方不可将其视为发布失败或结算已完成。
migration: 以发布响应中的 activity/workflow 确认发布状态；若要显示结算再发独立详情 GET，分别处理 scoped 权限、关闸和失败。
rollback: 经批准恢复 directPublish 的旧响应装配、DTO/消费者；代码回退不会撤销已发布活动，状态恢复须由已授权的单独业务流程完成。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/declare-attendance-complete
reason: 保留旧路径作为明确退休提示，停止写旧考勤提交声明，不再返回成功详情。
impact: R11 报告成功状态改变及原成功 envelope 的 60 个嵌套字段移除；旧客户端仍有 Promise<ApiEnvelope<void>> 签名，不能据此推断此操作可能成功。
migration: 停止调用旧声明；活动结束改按新版结算生成、提交和关账流程重新设计，并分别验证新权限、请求与事实。旧路径在原成员/负责人检查后按闸态拒绝；不能把它当旧声明或新关账成功。
rollback: 若维护者另行决定恢复旧写，须协调撤回退休 handler/文档及受影响后续改动，恢复旧作者权限和写闸，并评估新旧写入、审核及账本一致性；不假设单独恢复路由即可安全回滚。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activities/{activityId}/attendance-sheets
reason: 旧 AttendanceSheetsCollectionController.submit 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/admin/v1/activities/{activityId}/attendance-sheets 不再有该处理器；旧入口的准入/权限为 attendance.create.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：App 结算 generate/submit，无同义 Admin Sheet 提交。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsCollectionController.submit、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/attendance-sheets
reason: 旧 AttendanceSheetsCollectionController.list 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/admin/v1/activities/{activityId}/attendance-sheets 不再有该处理器；旧入口的准入/权限为 attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：结算读或活动参与账本，过滤与对象不同。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AttendanceSheetsCollectionController.list 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/attendance-sheets
reason: 旧 AttendanceSheetsResourceController.listAll 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/admin/v1/attendance-sheets 不再有该处理器；旧入口的准入/权限为 attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：结算读，工作台过滤不同。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AttendanceSheetsResourceController.listAll 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/attendance-sheets/{id}/review-detail
reason: 旧 AttendanceSheetsResourceController.reviewDetail 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/admin/v1/attendance-sheets/{id}/review-detail 不再有该处理器；旧入口的准入/权限为 attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：结算版本审核详情。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AttendanceSheetsResourceController.reviewDetail 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/attendance-sheets/{id}
reason: 旧 AttendanceSheetsResourceController.findOne 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/admin/v1/attendance-sheets/{id} 不再有该处理器；旧入口的准入/权限为 attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：结算版本详情，不接受旧 Sheet ID。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AttendanceSheetsResourceController.findOne 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/attendance-sheets/{id}
reason: 旧 AttendanceSheetsResourceController.edit 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 PATCH /api/admin/v1/attendance-sheets/{id} 不再有该处理器；旧入口的准入/权限为 attendance.update.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：App 结算逐项修改，无整张旧 Sheet 编辑。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.edit、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/attendance-sheets/{id}
reason: 旧 AttendanceSheetsResourceController.softDelete 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 DELETE /api/admin/v1/attendance-sheets/{id} 不再有该处理器；旧入口的准入/权限为 attendance.delete.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：未发现等价软删接口。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.softDelete、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/attendance-sheets/{id}/approve
reason: 旧 AttendanceSheetsResourceController.approve 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 PATCH /api/admin/v1/attendance-sheets/{id}/approve 不再有该处理器；旧入口的准入/权限为 attendance.approve.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：新结算 first-approve；权限、方法、对象不同。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.approve、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/attendance-sheets/{id}/reject
reason: 旧 AttendanceSheetsResourceController.reject 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 PATCH /api/admin/v1/attendance-sheets/{id}/reject 不再有该处理器；旧入口的准入/权限为 attendance.reject.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：无等价驳回；first-return 是退回。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.reject、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/attendance-sheets/{id}/return
reason: 旧 AttendanceSheetsResourceController.firstReturn 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/admin/v1/attendance-sheets/{id}/return 不再有该处理器；旧入口的准入/权限为 attendance.return.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：新结算 first-return。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.firstReturn、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/attendance-sheets/{id}/final-approve
reason: 旧 AttendanceSheetsResourceController.finalApprove 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 PATCH /api/admin/v1/attendance-sheets/{id}/final-approve 不再有该处理器；旧入口的准入/权限为 attendance.final-approve.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：新结算 final-approve；基线旧终审已停用。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.finalApprove、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/attendance-sheets/{id}/final-reject
reason: 旧 AttendanceSheetsResourceController.finalReject 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 PATCH /api/admin/v1/attendance-sheets/{id}/final-reject 不再有该处理器；旧入口的准入/权限为 attendance.final-reject.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：无等价终审驳回；final-return 是退回。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.finalReject、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/attendance-sheets/{id}/final-return
reason: 旧 AttendanceSheetsResourceController.finalReturn 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/admin/v1/attendance-sheets/{id}/final-return 不再有该处理器；旧入口的准入/权限为 attendance.final-return.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：新结算 final-return。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.finalReturn、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/attendance-sheets/{id}/resubmit
reason: 旧 AttendanceSheetsResourceController.resubmit 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/admin/v1/attendance-sheets/{id}/resubmit 不再有该处理器；旧入口的准入/权限为 attendance.update.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：App 结算版本 resubmit，不是旧 Sheet 重提。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.resubmit、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/attendance-sheets/{id}/reopen
reason: 旧 AttendanceSheetsResourceController.reopen 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/admin/v1/attendance-sheets/{id}/reopen 不再有该处理器；旧入口的准入/权限为 attendance.reopen.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：未发现等价旧单撤回；新版更正为独立流程。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AttendanceSheetsResourceController.reopen、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/check-ins
reason: 旧 AdminActivityCheckInsController.list 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/admin/v1/activities/{activityId}/check-ins 不再有该处理器；旧入口的准入/权限为 attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：未发现等价旧 GPS 证据列表。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AdminActivityCheckInsController.list 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/attendance-sheet-draft
reason: 旧 AdminActivityCheckInsController.attendanceSheetDraft 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/admin/v1/activities/{activityId}/attendance-sheet-draft 不再有该处理器；旧入口的准入/权限为 attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：App 结算生成，无旧草稿等价接口。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AdminActivityCheckInsController.attendanceSheetDraft 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/members/{memberId}/attendance-records
reason: 旧 AdminMemberAttendanceController.attendanceRecords 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/admin/v1/members/{memberId}/attendance-records 不再有该处理器；旧入口的准入/权限为 attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：个人账本或时长证明，非旧记录等价物。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AdminMemberAttendanceController.attendanceRecords 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/activities/{activityId}/check-in
reason: 旧 AppActivityCheckInsController.checkIn 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/app/v1/my/activities/{activityId}/check-in 不再有该处理器；旧入口的准入/权限为 App 成员、本人，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：本人场次 punches/check-in。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AppActivityCheckInsController.checkIn、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/activities/{activityId}/check-in
reason: 旧 AppActivityCheckInsController.getCurrent 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/app/v1/my/activities/{activityId}/check-in 不再有该处理器；旧入口的准入/权限为 App 成员、本人，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：本人场次 my-punch-state。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AppActivityCheckInsController.getCurrent 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/activities/{activityId}/check-out
reason: 旧 AppActivityCheckInsController.checkOut 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/app/v1/my/activities/{activityId}/check-out 不再有该处理器；旧入口的准入/权限为 App 成员、本人，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：本人场次 punches/check-out。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AppActivityCheckInsController.checkOut、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/attendance-records
reason: 旧 AppMyAttendanceRecordsController.listMyAttendanceRecords 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/app/v1/my/attendance-records 不再有该处理器；旧入口的准入/权限为 App 成员、本人，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：个人账本或正式时长证明。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AppMyAttendanceRecordsController.listMyAttendanceRecords 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/check-ins
reason: 旧 AppManagedActivityAttendancesController.listCheckIns 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/app/v1/my/managed-activities/{activityId}/check-ins 不再有该处理器；旧入口的准入/权限为 责任范围、attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：未发现等价旧 GPS 证据列表。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AppManagedActivityAttendancesController.listCheckIns 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheet-draft
reason: 旧 AppManagedActivityAttendancesController.draft 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheet-draft 不再有该处理器；旧入口的准入/权限为 责任范围、attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：新结算 generate，不是旧 Sheet 草稿。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AppManagedActivityAttendancesController.draft 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheets
reason: 旧 AppManagedActivityAttendancesController.listSheets 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheets 不再有该处理器；旧入口的准入/权限为 责任范围、attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：GET .../settlement 工作台，非旧单列表。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AppManagedActivityAttendancesController.listSheets 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/attendance-sheets
reason: 旧 AppManagedActivityAttendancesController.submit 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/app/v1/my/managed-activities/{activityId}/attendance-sheets 不再有该处理器；旧入口的准入/权限为 责任范围、attendance.create.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：新结算 generate/submit，使用新结算权限。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AppManagedActivityAttendancesController.submit、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}
reason: 旧 AppManagedActivityAttendancesController.detail 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId} 不再有该处理器；旧入口的准入/权限为 责任范围、attendance.read.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：GET .../settlement/versions/{versionId}，ID 和对象不同。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 恢复 AppManagedActivityAttendancesController.detail 及其原模块/查询装配、鉴权与合同客户端；须先核验旧历史表是否覆盖新链事实，不能把读取旧数据当作新账本回退。
-->

<!-- contract-breaking
operation: PATCH /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}
reason: 旧 AppManagedActivityAttendancesController.edit 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 PATCH /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId} 不再有该处理器；旧入口的准入/权限为 责任范围、attendance.update.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：PATCH .../settlement/items/{identityId}，使用新草稿修改权限。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AppManagedActivityAttendancesController.edit、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: DELETE /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}
reason: 旧 AppManagedActivityAttendancesController.softDelete 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 DELETE /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId} 不再有该处理器；旧入口的准入/权限为 责任范围、attendance.delete.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：未发现等价软删接口。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AppManagedActivityAttendancesController.softDelete、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}/resubmit
reason: 旧 AppManagedActivityAttendancesController.resubmit 所属旧考勤运行时入口已注销，避免继续从退役链读写。
impact: 原调用 POST /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}/resubmit 不再有该处理器；旧入口的准入/权限为 责任范围、attendance.update.sheet，旧客户端方法与 DTO 不再可用。
migration: 交接表列出的相关能力或缺口：POST .../settlement/versions/{versionId}/resubmit，使用新结算提交权限。调用方须重新验证对象 ID、方法、请求、权限与数据口径；若写明无等价能力，应暂停该旧流程并另行设计，不得声称已一一替代。
rollback: 维护者若决定回退，可依据 7c377227 协调恢复 AppManagedActivityAttendancesController.resubmit、对应旧 writer/模块、原鉴权和写闸及合同客户端；须先审新旧写入和账本一致性，不得仅重新暴露路径或假定旧数据可无损恢复。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/meta/dashboard-summary
reason: 工作台不再用旧 attendanceSheets 提供待审数，改按新 settlement run 和相应审核范围生成摘要。
impact: attendanceSheets 整块及 pending、pendingFirstReview、pendingFinalReview 删除；依赖旧块的 Admin 首页可能静默不显示卡片；独立前端已有本地适配，真实联调待验证。
migration: 使用 settlementReviews.available 和按一审/终审分别可省略的字段，区分关闸、无权、真零与失败；新数是组织范围流程数而非“本人待审”，新版本历史列表也不是可精确筛同阶段的旧工作台。
rollback: 经批准协调恢复旧 dashboard 计算与 DTO、客户端和原权限筛选；核验旧 Sheet 是否仍被维护，新 run 统计不能当作同口径旧数。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/meta/participation-overview
reason: 月度聚合改为正式参与、账本和正式时间；无可靠时长或已判定分母时不捏造数字。
impact: months[].totalServiceHours、averageAttendanceRate、noShowRate 可为空；未适配的月报表格和图表存在把 null 转成零的风险；独立前端已有本地适配，真实联调待验证。
migration: 为 null 使用未知/断点，真零保留 0；识别 durationUnknownCount、关闸 20153/503、无可见组织空结果与请求失败，不再标注旧终审 Sheet 口径。
rollback: 经批准恢复旧月度 Sheet 聚合和 DTO/客户端，同时复核组织范围和月份边界；新账本或正式时间不自动回填旧 Sheet。
-->
