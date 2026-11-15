# attendances — 考勤、贡献与现场事实

Sheet状态只经attendance-sheet-state-machine，submit只建pending Sheet，
不直写Activity.completed；活动完结归activities.complete。不顺手大拆service或移动既有surface。

## 旧考勤写链与并发

- submit/edit/softDelete/resubmit的Activity锁覆盖Admin/managed每条surface，
  不挂在managed判断的单边分支。managed先按managedActivityId锁/判权，不能先泄露Sheet存在性；
  Admin从Sheet得到activityId再取同锁。
- edit/delete/approve/reject/finalApprove/finalReject/reopen先claimAtStatus
  （条件FOR NO KEY UPDATE）再重读Sheet，随后version/previousSnapshot/records/audit before
  只用锁后行，并发败者不先破坏子行。合法迁移仍由状态机判。
- submit/edit对registration排序去重claim(expected=pass)，再同批复读活动/Member/状态/岗位窗；
  不“只claim不复读”。与pass cancel均Activity→Registration，后到取消遇live record须21033。
- submit/edit重叠查询前用共享lockMembersForWrite取排序去重member键；
  队员维度只有这一把advisory键，不复制SQL。finalApprove/reopen在Sheet claim之后、
  贡献before快照之前取同键，不能倒序造成与edit死锁。
  四条取member键路径用runMemberLinearizedTransaction，显式ReadCommitted和有界lock_timeout，
  锁超时40901，不靠提高事务timeout解决convoy。
- finalApprove按cycleYear批量computeContributionBatch、enqueueMany，单人/批量共用贡献核，
  不恢复逐人SQL、不用after-rawDelta反推before。
  DB未加range exclusion/btree_gist是已接受边界，仅保证应用事务锁，不宣称直连SQL也受保护。
- cancelled活动保留存量resubmit/reopen/approve/finalApprove；
  submit和edit的records分支拒20122。唯一判定ActivityParticipationPolicy.canChangeAttendanceRecords，
  只拒cancelled且在Activity锁内；不扩大到draft/published/completed。

## 记录、判权与审计

attendance-record.policy是纯值校验，不收client，批量IN查询与锁后复读留service。
顺序是错误码契约：角色码→状态码→队员存在→保险缺报名→报名活动→报名队员/pass→
normalize→时间窗→未来签退。submit/edit同一now，未来checkOutAt拒22079；
输入不收contributionPoints，ContributionCalculator无规则计0。
requiresInsurance时registrationId必须同活动/成员/pass；这不证明历史报名保险已独立核验。
岗位有独立窗就用岗位窗，否则活动窗；无报名只在无需保险时允许。
草稿角色沿岗位attendanceRoleCode，无岗member，忘签退回岗位endAt；不另造计算核。

一级审核禁原提交人/最近重提人自审22081；
终审自审22074、一级与终审同人22075，SA也拒。
ATTENDANCE_ALLOW_SAME_REVIEWER仅兼容解析，不放开；reopen不受审核约束。
final动作共用assertFinalReviewAuthzOrThrow，scoped终审角色或SA，biz-admin无终审码。
资源缺失只对GLOBAL持码者回旧NOT_FOUND，其余30100。
活动嵌套面带activity ref，单Sheet动作带sheet ref，队员轴带member ref；
总表scope按activity.organizationId下推并与用户过滤求交。

QueryService只收已计算scope，不注入rbac/authz、不exports；跨模块读仍经service判权。
响应统一attendance-presenter（含Decimal→string）。
业务写和list/findOne/reviewDetail的fail-closed读取审计统一recorder，
读extra仅operation/count/filterFields。
自助签到/签退成功刻意零audit（不可变ActivityCheckIn即事实）；
新增管理端改删签到必须审计，不能误用此豁免。

firstReturn/finalReturn/finalApprove通知与状态/audit同事务enqueue，失败整体回滚。
退回收件人为active考勤责任人与当前提交人Member去重；终审按record保留多时段。
pending_final_review时计算最新joining application/cycle的capped before，
approved后同事务算after；里程碑key为team-join-contribution-met:{applicationId}:{threshold}，
普通结果key沿attendance-final:{sheetId}:{finalReviewedAt}:{recordId}。

## GPS、QR与离线

- ActivityCheckInLocationPolicy唯一geofence：合法完整活动/请求坐标，
  未舍入Haversine距离<=配置半径才写；accuracy仅证据，不改变半径。
  活动定位/策略坐标/超范围22080，DTO非法40000，均零派生写。
  已有合法winner在位置判断前幂等200，不被非法重试覆盖；新行geoVerified=true/outOfRange=false，
  不回填历史或改变Admin手工考勤。
- AttendancePunchCommandService唯一PunchEvent writer/Activity根事务，
  access层仅消费调用方tx；锁序Activity→Session→Identity→QR/Event。
  QR服务只签发/作废/受保护render并同锁复核职责。
  PunchEvent只追加，void/replace用新事实令旧事实失效，segment只由projector投影；
  整单取消按effective facts拒仍有效PunchEvent。
  明文QR token只在受保护SVG进程内，不入JSON/DB/audit/日志，digest/hash也不出App读面。
- staff/proxy/bulk/CSV全部复用同一写核，LoginScoped声明不代替锁后canManageAttendance复核。
  每item重验lease/fence、责任、identity、窗口、segment、seal；
  execute重新验证file digest/parserVersion/rowHash/previewHash，不把preview当授权。
- OfflinePackageService持Activity→OfflinePackage根事务，access层不自开事务，
  review读/approve/reject由独立review service消费同准入。
  正式offline事件只调offlinePunchWithinTransaction；22097零写，
  22098/22099只staging、零PunchEvent，approve才同事务正式化。
  package token/成员凭证/签名仅请求验证边界，不入DB/audit/错误/安全读面。

E3-2 D3 System复核GET需显式GLOBAL Human权限、锁后复核与同事务最小读审计；
窗口/签字仍CLI、各自独立权限，无写HTTP；未启shadow/Gate。
批准只追加、不删除资产，confirmed_gap不清零，unsigned旧证据不升级。
按改动验证状态/audit、cancelled增量闸、锁后报名复核、规模隔离、GPS与QR/offline用例；
App本人读where始终currentUser.memberId，改接口再跑contract。
