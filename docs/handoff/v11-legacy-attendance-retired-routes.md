# 旧考勤接口退休对照（本地候选，未部署）

本轮维护者已明确批准按 #1415 候选范围完成退役，并确认取消报名、删除活动只认新链证据，旧历史不再触发这些阻断。以下旧轮次的“待授权”说明保留其历史语境；当前待完成的是合同、业务验收与消费者适配，而不是重新决定退役方向。此授权不代表验证完成、合并、部署或生产开闸。

当前合同为 643 个操作，下表 30 个旧操作与 43 个退休 DTO 已从 OpenAPI、客户端和授权派生物中退出，并有显式负向契约。真实 HTTP 退役验收还覆盖新版工作流开/关两态、有旧数据时的匿名、管理员和 App 成员访问：均为 404，旧事实、新事实、审计与 outbox 不变。旧 Sheet ID、请求和权限不能隐式转成新版对象或作为兼容别名。路由缺席验证不代替新版业务验收。

定向 PG／HTTP 已覆盖新版活动与入队旅程、取消报名及候补并发、敏感读取、正式贡献进度、参与汇总／月报、评价纠错读取和删除保护；完整 E2E 仍未收口。成员退出保护和遗留资源解析仍有旧依赖，贡献达标通知尚未接入新链。独立前端的适配、真实联调和生产启用均未完成；下方旧轮次的未验证说明仅代表当时状态。

第五轮相对 `ffb70913` 仍为 643 项、无新增或删除操作；另外两个保留操作 `GET /api/admin/v1/activities` 和 `GET /api/admin/v1/meta/dashboard-summary` 的文案／响应结构有意改变，分别用 `settlementStats` 和 `settlementReviews` 替代旧字段，详见[参与投影](v11-participation-projection.md)。该字段变更独立于下表 30 条退役操作，旧 E2E 与受保护快照尚待审查。

第六轮额外停止一条仍注册的旧写入口：`POST /api/app/v1/my/managed-activities/{activityId}/declare-attendance-complete`。它先保留 App 成员和活动主负责人检查；无成员为 `FORBIDDEN`，非主负责人或活动不可见为 `ACTIVITY_NOT_FOUND`。通过检查后，开闸返回 `20154`／410，关闸返回 `20153`／503，只读维护返回 `20158`／503，任何闸态都不再写旧声明或审计成功。此路径暂时保留以明确告知调用方，**不是**下表已注销的第 31 个路由；新版相关能力是 `.../{activityId}/settlement` 下的结算与关账，权限、请求和效果不同。OpenAPI 不声明此方法的成功响应；当前生成器仍生成 `Promise<ApiEnvelope<void>>` 的方法签名，该签名不表示此方法可成功。旧 HTTP E2E 原有成功断言尚需按流程获准审查，未在本轮修改。

第七轮负责人列表／详情已停止读取旧 Sheet、旧声明及其待办。列表保留原活动可见范围和待审报名数，不推断结算权限，也不按旧单数造新版数字。详情保留 pending／waitlisted 报名数；原 `closure` 改为生命周期 `workflow`，旧 Sheet 计数字段移除，另增 `settlement`。独立详情在同一只读快照中重读 ACTIVE 用户和成员绑定、复核 App 成员准入，以当前角色检查活动可见性，再按活动资源检查 `activity.settlement-generate.record`：无权为 `forbidden`；有权但新版闸关为 `workflow-disabled`；有权且闸开为 `available`，才返回 run 流程状态、当前提交版本指针、只读态及工作台相对路径；存在 active 关账修订才返回 `activeClosure`。`available` 时 run 状态 null 表示无 run，省略 `activeClosure` 表示无 active 关账；不读取旧表兜底。`activeClosure` 是该活动最新的 active 关账记录，未核验与正式账本指针的一致性；它可与进行中更正并存，不代表最终完成。提交版本指针不等于当前正式生效版本，run 状态也不是关账凭证。`workflow.nextAction` 的 null 表示不推断下一步，不代表结算完成或没有待办；工作台路径是普通导航，不是操作许可。只读维护在闸开时保留读取。此详情摘要在关闸时不读取新版事实；既有独立 `GET .../settlement` 工作台目前有自己的读语义，关闸也可按其授权读取，不要把二者的 gate 行为混为一谈。缺少结算权限或关闸不会让基础活动详情失败。创建、更新、直接发布、封面和图集写入后的响应返回 `not-requested`，不新增结算授权或交互事务依赖；需要摘要时再请求独立详情。独立详情的授权或事务错误会按错误返回，不伪装为无权或零。App 首次准入在事务前进行，独立详情在事务内再次复核；身份失效时整个 GET 返回认证／准入错误；该快照不锁身份，快照建立后的撤权不保证对当前请求即时生效。写后基础响应保留原有准入与读取边界。

负责人列表和详情字段变化是有意的破坏性合同变更：小程序须适配 `workflow`／`settlement`，旧 E2E 和受保护快照仍待审查，真实 PG／HTTP 未验证。独立前端需另行适配并回执，后端生成客户端更新不能证明前端实际采用；候选仍不得部署。

旧控制器类缩写：C=`AttendanceSheetsCollectionController`，R=`AttendanceSheetsResourceController`（均在 `src/modules/attendances/attendances.controller.ts`）；A=`AdminActivityCheckInsController`，M=`AdminMemberAttendanceController`，P=`AppActivityCheckInsController`，U=`AppMyAttendanceRecordsController`，W=`AppManagedActivityAttendancesController`（各自在 `src/modules/attendances/controllers/` 下）。旧生成客户端方法是完整控制器类名加下表方法名首字母大写，例如 `R.finalApprove` 对应 `AttendanceSheetsResourceControllerFinalApprove`。C/R/A/P/U/W 已注销，M 类保留但 `attendanceRecords` 方法移除。

下表“相关能力”仅供前端重新设计流程，不代表旧 Sheet ID、请求方法、DTO、权限或数据可一比一替换。新版结算读可使用 `GET /api/admin/v1/attendance-settlements`、`GET /api/admin/v1/attendance-settlements/{settlementVersionId}/review-detail`；新版 App 负责人结算入口位于 `/api/app/v1/my/managed-activities/{activityId}/settlement`。新版审核为 `POST /api/admin/v1/attendance-settlements/{id}/{first-approve,first-return,final-approve,final-return}`，分别使用 `activity.settlement-first-review.record` 和 `activity.settlement-final-review.record`，不自动继承旧审核权限。新版本人打卡为 `POST /api/app/v1/activities/{activityId}/sessions/{sessionId}/punches/check-in`、`check-out` 及 `GET .../my-punch-state`。个人参与账本和时长证明不是旧考勤记录列表。

| 被移除的 Admin 方法和路径 | 旧控制器方法 | 旧权限 | 相关能力或明确缺口 |
|---|---|---|---|
| `GET /api/admin/v1/activities/{activityId}/attendance-sheet-draft` | A.attendanceSheetDraft | `attendance.read.sheet` | App 结算生成，无旧草稿等价接口 |
| `GET /api/admin/v1/activities/{activityId}/check-ins` | A.list | `attendance.read.sheet` | 未发现等价旧 GPS 证据列表 |
| `GET /api/admin/v1/activities/{activityId}/attendance-sheets` | C.list | `attendance.read.sheet` | 结算读或活动参与账本，过滤与对象不同 |
| `POST /api/admin/v1/activities/{activityId}/attendance-sheets` | C.submit | `attendance.create.sheet` | App 结算 generate/submit，无同义 Admin Sheet 提交 |
| `GET /api/admin/v1/attendance-sheets` | R.listAll | `attendance.read.sheet` | 结算读，工作台过滤不同 |
| `GET /api/admin/v1/attendance-sheets/{id}` | R.findOne | `attendance.read.sheet` | 结算版本详情，不接受旧 Sheet ID |
| `GET /api/admin/v1/attendance-sheets/{id}/review-detail` | R.reviewDetail | `attendance.read.sheet` | 结算版本审核详情 |
| `PATCH /api/admin/v1/attendance-sheets/{id}` | R.edit | `attendance.update.sheet` | App 结算逐项修改，无整张旧 Sheet 编辑 |
| `DELETE /api/admin/v1/attendance-sheets/{id}` | R.softDelete | `attendance.delete.sheet` | 未发现等价软删接口 |
| `PATCH /api/admin/v1/attendance-sheets/{id}/approve` | R.approve | `attendance.approve.sheet` | 新结算 first-approve；权限、方法、对象不同 |
| `PATCH /api/admin/v1/attendance-sheets/{id}/reject` | R.reject | `attendance.reject.sheet` | 无等价驳回；first-return 是退回 |
| `POST /api/admin/v1/attendance-sheets/{id}/return` | R.firstReturn | `attendance.return.sheet` | 新结算 first-return |
| `PATCH /api/admin/v1/attendance-sheets/{id}/final-approve` | R.finalApprove | `attendance.final-approve.sheet` | 新结算 final-approve；基线旧终审已停用 |
| `PATCH /api/admin/v1/attendance-sheets/{id}/final-reject` | R.finalReject | `attendance.final-reject.sheet` | 无等价终审驳回；final-return 是退回 |
| `POST /api/admin/v1/attendance-sheets/{id}/final-return` | R.finalReturn | `attendance.final-return.sheet` | 新结算 final-return |
| `POST /api/admin/v1/attendance-sheets/{id}/resubmit` | R.resubmit | `attendance.update.sheet` | App 结算版本 resubmit，不是旧 Sheet 重提 |
| `POST /api/admin/v1/attendance-sheets/{id}/reopen` | R.reopen | `attendance.reopen.sheet` | 未发现等价旧单撤回；新版更正为独立流程 |
| `GET /api/admin/v1/members/{memberId}/attendance-records` | M.attendanceRecords | `attendance.read.sheet` | 个人账本或时长证明，非旧记录等价物 |

App 的“责任范围”是旧控制器的 `app-member` + `responsibility`，service 还执行表中读写权限与责任检查；旧 resubmit 对 SUPER_ADMIN 的责任检查有分支例外。

| 被移除的 App 方法和路径 | 旧控制器方法 | 旧准入或权限 | 相关能力或明确缺口 |
|---|---|---|---|
| `POST /api/app/v1/my/activities/{activityId}/check-in` | P.checkIn | App 成员、本人 | 本人场次 punches/check-in |
| `POST /api/app/v1/my/activities/{activityId}/check-out` | P.checkOut | App 成员、本人 | 本人场次 punches/check-out |
| `GET /api/app/v1/my/activities/{activityId}/check-in` | P.getCurrent | App 成员、本人 | 本人场次 my-punch-state |
| `GET /api/app/v1/my/attendance-records` | U.listMyAttendanceRecords | App 成员、本人 | 个人账本或正式时长证明 |
| `GET /api/app/v1/my/managed-activities/{activityId}/check-ins` | W.listCheckIns | 责任范围、`attendance.read.sheet` | 未发现等价旧 GPS 证据列表 |
| `GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheet-draft` | W.draft | 责任范围、`attendance.read.sheet` | 新结算 generate，不是旧 Sheet 草稿 |
| `GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheets` | W.listSheets | 责任范围、`attendance.read.sheet` | `GET .../settlement` 工作台，非旧单列表 |
| `POST /api/app/v1/my/managed-activities/{activityId}/attendance-sheets` | W.submit | 责任范围、`attendance.create.sheet` | 新结算 generate/submit，使用新结算权限 |
| `GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}` | W.detail | 责任范围、`attendance.read.sheet` | `GET .../settlement/versions/{versionId}`，ID 和对象不同 |
| `PATCH /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}` | W.edit | 责任范围、`attendance.update.sheet` | `PATCH .../settlement/items/{identityId}`，使用新草稿修改权限 |
| `DELETE /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}` | W.softDelete | 责任范围、`attendance.delete.sheet` | 未发现等价软删接口 |
| `POST /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}/resubmit` | W.resubmit | 责任范围、`attendance.update.sheet` | `POST .../settlement/versions/{versionId}/resubmit`，使用新结算提交权限 |

本候选的活动对账、参与汇总和月度总览在新版关闭时可返回 `20153`／503；月度无可见组织时先返回空数组。三个读面、列表统计及工作台的新语义见[参与投影](v11-participation-projection.md)；成员退出保护和遗留资源解析仍有旧依赖，新版达标通知未接线。已有定向 PG／HTTP 验证，完整 E2E 与外部前端联调仍未收口。不得据此部署。

管理员现场复核仍有能力缺口：当前 Admin 结算接口提供版本审核与入账状态，没有按活动分页读取现场打卡证据、保留取消/软删成员历史的等价读面，也没有只读的未结算出勤/缺席聚合。App 现场名册要求当前责任资格，不能用授予管理员活动责任的方式冒充原有 `attendance.read.sheet` GLOBAL/ACTIVITY 读权。`admin-activity-check-ins.e2e-spec.ts` 的相关验收继续保留，不能仅以旧路由返回 404 宣称完成。旧草稿“忘签退补到结束时间”不适用于新链；新链保留开放段并阻止封场，不伪造签退事实。旧软删、终态驳回与新链退回/更正也不是等价命令，需分别核定其验收口径。
