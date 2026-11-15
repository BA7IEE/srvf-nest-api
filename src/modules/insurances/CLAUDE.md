# insurances — 资格、证据与部署边界

InsuranceRequirementService是Activity/Team Join唯一保险资格/evidence出口。
INSURANCE_ENFORCEMENT_ENABLED只设一个gate，归app.config；代码已接入不代表生产已部署。
上线须maintainer drain旧server/事务，独立deploy D81/D82+探针，再保持drain切精确runtime SHA，
不混跑新旧版本、不回滚旧runtime；不自动开启生产gate或运行数据库破坏命令。

## 审核与版本

- 唯一review action只收verified/rejected与expectedVersion，
  service校验member-insurance.review.record。
  锁序Authz→Member FOR UPDATE→所属live MemberInsurance FOR UPDATE NOWAIT→audit；
  stale/NOWAIT为26011，非pending26012。
  审计与mutation同事务，before/after仅status+version，
  extra仅memberId/insuranceId/decision，不暴露reviewer。
- App PATCH body/DELETE query契约要求expectedVersion；
  gate=true缺失/null/空白在事务前40000、零写/audit，显式stale26011；
  gate=false维持旧optional runtime兼容。
  实质PATCH version+1、回pending并清reviewer/time；DELETE加版本但保留审核结论；
  等值PATCH真no-op。响应仅沿reviewStatusCode/version/reviewedAt安全投影。

## 来源与事务

- gate=true固定verified live self优先于live Team Policy+Coverage。
  self顺序coverageEnd DESC、coverageStart DESC NULLS LAST、reviewedAt DESC、id ASC；
  team顺序policy.coverageEnd DESC、coverageStart DESC NULLS LAST、policy.id ASC、coverage.id ASC。
  读锁self FOR SHARE或Policy→Coverage；coverage写锁Policy→稳定Coverage集→稳定Member。
- gate=false沿Activity旧consumer，Team Join不查资格，两者零evidence。
  gate=true Activity无来源26030，26031只用于Team Join final join。
- Activity update仅在受保护字段真变更时查live非cancelled报名，沿20030。
  所有approve先Activity锁→claim Registration/currentRevision→锁后复核Member/source/evidence，
  最后capacity/registration/audit/outbox写；无Member/软删15001，inactive17030。
  self后段Member lifecycle→Insurance；team后段Policy→Coverage→Member lifecycle。
  exact-source资格只在gate=true且requiresInsurance时启用，失配26030，不fallback。

## Evidence

新Activity producer绑定当次activityRegistrationRevisionId；
currentRevision>0只认该revision恰一条evidence，不回退header；
revision=0只兼容恰一条revisionId=NULL的legacy evidence。复合FK同头，零旧数据回填。
Evidence不可变，无update/delete service，owner表不加evidenceId；
不存insurer/policy number、note/reason、附件/图片、key/URL、reviewer name或自由文本。

member-match只在结构合法且source/owner存在时比较：
INSERT结构/缺FK/跨member分别CHECK23514/FK23503/member-match23514。
命中Evidence的UPDATE仅结构合法、目标存在且跨member先报member-match23514；
其他UPDATE/DELETE为immutable55000。trigger名仅排列BEFORE trigger，不代表先于CHECK/FK。
不借约束新增route/DTO、第二review权限/事件或第二gate。
offboard与approve共享Member lifecycle锁，不据此宣称首签到/考勤或离队影响阻断已闭环。

## 队员概览

MemberInsuranceOverviewService是只读聚合应用服务（含scoped-authz/audit），不是纯QueryService，
也不代替资格判定。member-insurance.read.other+member ref，同事务各查一次self与team、无N+1。
北京当天summary：active team，或active+verified且reviewer/time齐全的self才confirmed；
不读enforcement gate。旧GET排序/行为保持，team不返policyNumber/note/其他成员/reviewer，
self也不返reviewer；fail-closed读取audit仅operation=overview与两个计数。

验证unit/characterization、overview安全投影/查询数/audit、App CAS、review及两consumer E2E。
竞态使用独立Nest/Prisma pool与真实PG锁屏障，不用串行调用冒充并发。
