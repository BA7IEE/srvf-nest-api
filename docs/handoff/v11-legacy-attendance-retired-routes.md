# 旧考勤接口退休对照（本地候选，未部署）

本表比较 `7c377227` 与 `2515d617`：OpenAPI method/path 从 673 个变为 643 个，删除下列 30 个、新增 0；643 个保留操作的生成对象当时逐个相等。旧合同白名单与权限清单仍含这 30 项，待授权并审查后更新。除操作外另移除 41 个旧 DTO schema：Admin 类型少 24、App 少 17。生成客户端方法 Admin 323→305，App 208→196，其余四个 surface 方法集合不变。此对比是离线源码和生成物检查，不是 HTTP 测试。

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

本候选的活动对账、参与汇总和月度总览在新版关闭时可返回 `20153`／503；月度无可见组织时先返回空数组。三个读面的新语义见[参与投影](v11-participation-projection.md)；报名保护和仪表盘仍有旧依赖，新版达标通知未接线，真实 PG／HTTP 未验证。不得据此部署。
