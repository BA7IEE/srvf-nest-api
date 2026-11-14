# activity-registrations — 报名、身份与容量

活动生命周期归activities，考勤归attendances；本模块不主动维护AttendanceRecord。
状态只走activity-registration-state-machine：pending→pass/reject、legacy waitlisted→pending、
pending/waitlisted→reject、pending/pass/waitlisted→cancelled、reject→pending。
仅pass占容量。allocation已committed/first_come的候补可由取消链在原session+position转pass，
不开放手动/跨岗waitlisted→pass或reject→pass，不把新链套给legacy writer。

## 永久头与命令

- (activityId,memberId)全历史只有一头，含cancelled/软删。
  live cancelled/reject重报追加revision，软删不复活；legacy仅无永久identity时可重报，
  有identity21038。canonical/onsite复用identity，从legacy切源时清旧position/extras、刷新registeredAt。
  identity=0也按member/activity核active activity-person，foreign anchor20147。
- canonical锁序：
  Activity FOR UPDATE→永久head（含终态/软删）→member/activity全identities按id锁→
  D-5 Member/User FOR SHARE→pointer/current revision对账→状态/profile/Form→session/position→
  upload session→insurance source→append revision/answer/preference/evidence→附件consumed→CAS pointer→audit。
  exact key+hash replay在锁内D-5后、Form/finality前，异hash21003，不以mutable状态破坏重放。
  pending/waitlisted/cancelled/rejected不得有active session reservation；
  coherent final状态交21030，投影漂移先20147。
- 一次性附件session仅create/upload，CSPRNG token只首响应明文、DB只SHA-256、30分钟。
  upload在Activity/Form/Session锁内复核身份/route/formVersion/status/expiry，
  不匹配在provider/ledger/audit前13001；上传后仍active。
  canonical复核AVAILABLE并先创建不可变FormAnswer，再转registration-form-answer owner、
  回填attachmentId并consumed，全部同事务；provider/签名/内容校验在事务外。
- legacy岗位可选activityPositionId，有live岗位未传21035，错活动/不存在/已删20002，
  先活动gender再岗位gender，永久头unique不含岗位（第二岗仍21002）。
  canonical任一live岗位要求preferences非空，所选场次有岗位要求positionIds非空，
  按合法数组顺序产生从1开始的preferenceOrder。Admin可返岗位摘要，App读模型不扩大。

## 容量与状态收口

CapacityReservationService只消费caller tx：Activity→member/activity全identities按id→
reserve目标scheduled live Session按id→bucket(scopeTypeCode,scopeId,id)→active reservation按id。
先锁/对账所有影响“最后active session”的bucket再DML；release可清历史/取消session。
它只写reservation与bucket.occupied/version，不写identity/header/revision/audit/outbox。
capacity_unavailable是确定性结果，caller在同一外层事务决定waitlist及其余事实，
不复制occupied算法。新activity-person以本批稳定最小identityId锚，旧锚保留到最后session释放。

legacy create/approve先锁Activity复核全活动passCount与岗位passCount/上限，父capacity永为硬上限；
不恢复“create满员直接报错”。取消pass仅同岗递补1人，软删/满岗不补；
扩容delta受父余量裁剪，null历史队列隔离，不跨岗位fallback。
promoteActivityWaitlist只处理无永久identity的legacy head，caller tx锁Activity→Member→Registration。

cancelAdmin/cancelMy固定Activity→永久head→全identities，先核current revision/pointer/reservation；
pending/waitlisted/pass才释放position/session/最后activity-person，再追加cancel revisions并CAS清投影。
cancelled/rejected/not_selected仅空pointer/position/population时noop，
attended/settled/cancellation_requested/未知20147；人口真变同tx只bump一次populationRevision。
拒绝同核：pending/waitlisted追加rejected，pass先释放三层；header summary=not_selected。
reopen只coherent rejected→pending/summary=active，cancelled/not_selected空投影noop；
reject/reopen不追加RegistrationRevision/evidence，漂移整体回滚。

活动整单取消同根事务：canonical pending/waitlisted追加admin revisions并CAS，
legacy同样沿revision链关闭；pass/active reservation保留，不复制容量DML。
approve对cancelled/completed拒20124；reject/cancel刻意可清理残留，不加此闸。
reopen清reviewedBy/At/Note、不发通知、不要求Member ACTIVE，后续approve必须重验。
取消经共同assertNoParticipationEvidence依次查live AttendanceRecord/ActivityCheckIn，
任一有证据21033；不引attendances service、不删历史、不回滚贡献。
截止闸在isPublicRegistration之后，now>deadline才20123，不按北京日取整，不限制approve。

## 资格、保险与现场

- create先live/ACTIVE快照保持15001/17030优先级，source选择后Member lifecycle锁复读。
  approve先Activity→Registration claim/currentRevision，再Member/source/evidence，最后业务写；
  self为Member→Insurance，team为Policy→Coverage→Member，无保险也锁Member；bulk仍逐条single approve。
- 单保险gate且requiresInsurance才写当次registrationRevision evidence；
  revision>0只认恰一对应evidence，revision=0只兼容唯一NULL legacy证据，不fallback/重选source；
  source失配26030，取消不产evidence，gate关/无需保险零evidence。
- evaluator只消费D83规则与member-profiles/certificates/insurances窄事实口；
  活动/场次/岗位AND，同规则数组OR，fail>warn>pass。
  submit/onsite/legacy/approve锁内重评，approve目标从current revision preferences/identities重建；
  block21040零写，配置漂移21041，pass/warn才append snapshot。
  legacy遇场次/岗位RuleSet21038，不猜场次。
- onsite只managed，Activity锁后复核责任；历史head→全identities→session/position/Form/RuleSet/保险→
  三层容量→revisions/evidence/pointer→population→audit。
  不复活软删、不造第二identity，精确replay在D-5/责任后、mutable finality前；
  有Form字段仍21039，不接答案/上传、邀请accept、allocation/waitlist，但合法RuleSet须评价。
  成功pointer必须等于本identity active session reservation，全部锚/投影先对账，漂移20147。

## 邀请、分配与到点任务

managed写除既有authz还须Activity锁后active canManageRegistrations；
owner/报名协办可，global旧角色/考勤协办不旁路。App self锁currentUser.memberId，无role/scope=all。
邀请create/list/revoke/本人decline为Activity→Invitation；decline同key/hash重放，异hash20151。
accept为Activity→Invitation→canonical，完整复用Form/资格/保险/身份/容量/mode；
visitor只写Visitor+visitor.create audit、attendanceCode=null，不写参与/预留/考勤/账本。

rank/lottery仅prepare/commit/void/get，同Activity根锁；first_come不建batch、各session独立。
rank=qualificationScore DESC→acceptedAt ASC→UTF-8 identity ASC，lottery只在commit公开seed。
prepare冻结candidate/revision/资格hash，commit一次写全部事实；void必须D86 live facts精确一致，
否则20147零写。同key/hash返原安全视图。
reconciliation仅既有两个worker，无HTTP/新cron；Activity→job lease/fence→headers/identities/revisions，
最早live session start（无session才Activity.startAt）到点将canonical pending/waitlisted追加expired，
同事务expire pending invitation；不动pass、不释放/重算capacity，任何漂移整笔零写。

## 边界、通知与验证

QueryService只构造读查询并接scope，不判权、不exports；presenter负责字段/expand/CSV，
不碰DB，不反依赖service；expand未知键400。
CSV保留500行cursor async generator、BOM首chunk、Readable.from、手写escape，
不全量内存、不加库、不写export_logs/AttendanceRecord。
registration.create/review事件名保持，promote用action=promote，
export在返generator前fail-closed audit operation=export，不移到尾部。

管理嵌套list/export带activity ref，单项带registration ref，队员轴member ref，
总表按activity组织scope求交；代报名create保持no-ref/GLOBAL-only。
资源缺失仅GLOBAL持码者回旧NOT_FOUND，否则30100。
App DTO物理独立，self不收memberId/memberNo/memberDisplayName，managed不返reviewedBy/cancelledByUserId；
export静态路由在:id前，现有MyActivities方法级tag例外保留。

通知与业务写/audit同事务，provider在commit后。
cancelMy标题/收件人快照在claim+证据守卫后读取；仅取消pass通知owner，
pending/waitlisted取消零通知。正文仅displayName/memberNo，缺任一匿名，不用内部ID。
gate=true只当前ACTIVE owner，缺失fail-closed；gate=false才显式publisher。
review key绑定registration/reviewedAt/audit序号，其他绑定状态时刻，enqueue失败全回滚。
按改动跑state/audit、永久头、capacity/allocation、资格/onsite、取消/候补和expiry定向E2E，
不在本机跑全量；契约改动再跑contract。
