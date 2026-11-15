# activities — 活动聚合与发布边界

负责Activity、Session/Position、发布审核、责任、模板/指标/成果与结算编排；
报名/容量占用写核归activity-registrations，考勤事实归attendances。
生产与验收状态只看 `docs/current-state.md` 和对应runbook，不追加分支进度、迁移计数或CI流水账。
旧全文在 `harness-v3-final`。ACTIVITY_V11_WORKFLOW_ENABLED仍默认关闭，不由AI开启或执行生产转换。

## 状态、身份与责任

- activity-state-machine唯一迁移源：draft→published→completed，draft/published可cancel。
  complete在Activity锁后复读，必须published且严格晚于endAt才完成；错误沿ACTIVITY_STATUS_INVALID。
  update/delete/publish/cancel/complete在根锁后claimAtStatus（FOR NO KEY UPDATE，不写no-op tuple），
  只认领不代替合法迁移判断。考勤submit不直写Activity状态。
- Admin create保持no-ref/GLOBAL-only，其他写带activity ref；
  资源不存在仅GLOBAL持码者回旧NOT_FOUND，否则30100。
  list/detail/options既有login-only不改，BD-3不新增activity.read.*码。
- App可参加池published+公开报名+endAt>=now，detail刻意允许回看已结束published；
  invitation仅本人accepted或未过期pending，myInvitations不泄露他人。
  岗位列表仅published+公开报名，live余量/canRegister实时计算；
  _memberId扩展槽不因暂未用于where删掉，MyActivities始终本人范围。
- ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED在dev/test默认false，production/smoke显式；
  关闭沿旧Admin，开启后pending冻结、published直改20037、发布原子生成唯一owner。
  production仍需preflight、补责任/reviewer、drain全fleet，禁止混档，不能以smoke已开替代生产证据。
- ActivityInitiationPolicy是create/真实draft改组织唯一资格入口：
  组织ACTIVE未删非根、initiator ACTIVE未删且正式等级、至少一live ACTIVE User，
  再查membership或acting user既有cross-org grant。draft用持久initiatorMemberId，null拒；
  同组织不追加策略查询。published proposal不能换组织，提交及审批锁后都复核并沿20022。
- 责任新增/移交锁序Activity→目标Member（新旧按id）→assignment→RoleBinding；
  assignment与system:activity-responsibility:{assignmentId} binding同事务建/终结，
  只由projector写system-managed角色，通用API含SA不能代写。
  managed活动与报名历史surface分开；draft仅initiator直改，published仅active owner提变更。
  cancelled优先于声明/考勤，closure=cancelled/null、nextAction=null；
  completed+已声明+有效Sheet全approved才closed。

## 审核、表单与版本

Activity→review锁序固定，initial服务端重建快照，change解析并复验完整proposal；
applier无自有事务，Activity/positions diff、revision一次递增、候补与audit同根事务。
主资源/岗位/审核各用既有recorder，event复用activity.publish、extra.operation区分，不拆新事件。

- 旧v1/v2快照/hash/apply兼容。v3把canonical Form纳入stale hash但不含allocation mode；
  v4才冻结/apply allocationModeCode，旧版本不能用undefined覆盖现行mode。
  RuleSnapshot仅formVersionId/version/schemaHash指针。
- Form根锁内分配version，draft initiator维护，相同canonical零写/audit；
  active替换/移除撤旧upload sessions。draft schemaHash=null，active才写hash；
  clone只复制definition为目标draft v1，不复制答案、附件、会话或审核历史。
- RuleSet活动/场次/岗位双向复合FK，NULL参与active槽位去重；
  active/retired及子Rule冻结，EvaluationSnapshot只追加。
  detail同事务统一evaluator、按命中RuleSet写display snapshot，只安全投影，不返敏感原值。
  draft qualification-rules全量维护，相同canonical零写；initial/显式规则change用V5，
  锁后冻结/激活/退役并同步岗位指针，旧v2–v4 hash不改，published直写20037。
- allocationModeCode是活动唯一标量，first_come/qualification_rank/lottery闭集，
  Admin/App新建显式选择，DB default仅存量兼容；draft可改，published走review。
  Activity锁内检查所有preparing/committed/voided batch与目标mode一致，不重写旧batch。
  Admin/managed返allocationModeCode，公共detail返allocationMode，列表不扩展。
- V7 base/target冻结指标选择三事实，显式选择须expected revision；
  published省略只保历史引用，显式同值仍重新验证新选资格。
  Activity→集→定义，等待后复核当前身份/责任/状态，仅approved apply写选择；
  旧v2–v6/legacy parser/hash不变，diff只安全字段名。

## 模板、指标与成果

目录定义/集draft→active→retired，精确(code,version)，激活后冻结。
集项写同时更新draft父，防旧快照绕激活；激活先父再按id锁定义并验canonical/hash，
定义退役不改历史集，DB不代算hash。
Human GLOBAL目录写/重放根事务复核当前User/显式权限，等待命令/父锁后再验；
收据只原安全字段，不返配置/operationKey，目录/收据/audit同事务，不自动授内建角色。

TemplateFamily稳定身份，不回填旧版本元数据。
Activity.selectedTemplateVersionId非空精确优先，NULL保留legacy fallback；
from-template按operationKey重放后锁精确Version，验hash/grammar，同事务物化Activity/Session/Position。
不以Family状态/effective interval发明“当前版本”，不复制Form答案或历史事实。
V1不含坐标，要求定位/半径的场次岗位必须fail-closed；
旧activityTypeCode只由activity-type-migration.registry解释，不借模板选择改写旧值。
V3选择required/not_required，旧活动unconfigured/revision0；
退役引用可解释、不可新选，V1/V2 hash/replay逐字节保持。
App options只当前成员发起组织资格，不隐含GLOBAL目录权；
每目录1000候选，1001明确20183/409，grammar/hash/active闭包过滤先于分页/total，
同快照只读、不缓存资格、不返配置/表单全文。

ActivityCreationService唯一根事务；快速模式地点/容量确认入requestHash；
专业模式一次物化活动、场次/岗位、地点、Form/Qualification、收据/audit。
紧急模式须独立权限，冻结受众、起源、七项义务、一次emergency outbox及audit同事务；
呼叫不是发布，immutable起源在所有正式发布边界均拒绝，补齐义务也不解锁。
义务只凭现有事实，场次/岗位/地点消失回pending，设备/成果/事故不伪装verified，考勤仍pending。

Readiness是单个只读事务+纯evaluator，固定域序，复用模板/Form/Qualification/指标与保险事实；
不接HTTP/发布Gate/审核写/audit/cache，Time/Contribution/Safety未表达的不能填成通过。
地点读Session/Position WGS84与半径，不用ActivityPlace/PlacePreset替代。

成果写/重放每次锁等待后复核当前Human App身份、显式outcome权限、组织资格与initiator/owner，
SA不直通。命令锁→Activity→引用锁，成果/值/证据、superseded旧draft、收据/audit同事务。
历史明细绑定自己的集id/hash，不拿当前选择替换；白名单值保留false/0/规范小数字符串，
人工draft不收short_text或创建confirmed，不返证据原文/身份/内部来源/操作键/存储凭证。
候选按完成事实产生不可变值/来源/计数，Gate关明确拒绝，不用零值冒充可用；
候选永久保留，无删除/过期/清理。来源按occurredAt,id重放，不按随机UUID猜顺序。
确认复制新revision，准备/取消更正不替换旧正式成果，历史来源永久保留。
workbench/report只读，活动稳定锁序、等待后与返回前复核，整批失败不部分返回；
未确认返null，不从摘要推出操作许可。

服务段更正prepare仅pending段与首次数量收据，不造正式段；
commit核精确base，先superseded再物化draft，复用ledger commit。
prepare/commit含replay复用GLOBAL settlement-final-review，
等待后由Users原语重读当前身份；清理仅独立批准的维护者CLI，默认只读，正式历史不删。
时间/贡献正式链预算、完整source/hash/guard/proof与历史失败不能因文档精简放宽；
当前规模及未完成验收见current-state和对应R4/R5规格，不把局部CI通过当生产验收。

## 容量、候补与到点

- Activity父capacity永为硬上限，岗位只收紧；有效capacity取父与岗位合计交集。
  变容锁Activity后重读全pass/live岗位，同父有限上限内岗位合计不得超；
  岗位容量不另加行锁。活动时间与岗位create/update/delete同根锁，
  live岗位独立窗超新活动窗20017，整笔拒绝。
- 保险单gate关闭沿旧查询图；开启后真实写前，在Activity锁内通过InsuranceRequirementService检查
  live非cancelled报名。有此类报名时requiresInsurance真值变化拒ACTIVITY_STATUS_INVALID，
  当前需保险时startAt/endAt真变化也拒；false仍false的改期沿旧行为。
  不把查询搬到根锁前，不据此宣称首签到/考勤的资格链已闭环。
- 有live岗位改父capacity不递补，只岗位扩容放人；无岗位才沿父delta/改无限/缩容规则。
  多岗位同时扩容必须promoteActivityWaitlistsWithinSharedCapacity，
  稳定sortOrder→createdAt→id，按实际promoted扣父预算；不能逐岗重复领同一父余量。
  容量只intersectHeadroom一份；legacy递补waitlisted→pending，不是pass。
- 队列仅本activityPositionId，含null历史队列也隔离；无同岗候选留空，不跨岗fallback。
  legacy引擎Activity→Member→Registration，失效Member保持waitlisted、排除后继续；
  只处理无永久identity，canonical归allocation。只有真实推进写promote audit/intent。
- CapacityBucketProjector仅在Activity→review内、Form/Rules后、QR/population revision前投影。
  同容量零UPDATE，变容CAS version+1；只核occupied与active reservations相等，
  新桶occupied=0，不改旧occupied、不做reservation DML；错锚/漂移/降容/占用历史scope20147全回滚。
- cancelLocked锁header→identity→current revision，关闭pending/waitlisted、append revisions/CAS，
  pass reservation/pointer/population保留，任何漂移20147零写，不复制容量内核。
- ActivityBatchWorker复用既有两个worker/PG lease/fence，ledger优先；
  仅到点published且有canonical pending/waitlisted或pending invitation才建reconciliation job。
  Activity→job fence→headers/identities/revisions→invitations，
  最早live session start，无session才Activity.startAt。pass/reservation不动，漂移整笔零写。

## 通知与多锚点

发布/改期/取消/审核/扩容与责任变更都在业务/audit同事务enqueue，失败整体回滚。
initial通知initiator，change只当前ACTIVE owner，缺失不回退publishedBy；
移交快照新旧owner，两个intent与assignment/binding同事务。provider仅commit后worker执行。
四类活动producer仅收FrozenRecipientCohort，不自查受众/责任；
cohortKey先回捞后重算，命中不查recipient，legacy广播也显式盖broadcast-visibility章。

audienceTagCodes仅string[]有效：null沿legacy，[]为全ACTIVE未删Member，
非空有效标签OR去重；初发限公开报名。组织维度与标签AND，
null/[]均不按组织收窄，非空用closure子树含自身+effective membership（业务事件时刻）。
无组织收窄时旧basis/requestHash字节不变、audit空数组键省略；
真收窄才audience-organizations及tag:/org:前缀。勾选组织无法解析live行整批400。
HTTP标签gate先身份/权限后503，不影响通用字典/legacy approval，冻结后不随赋标改变。

多业务锚表指向同链对象用复合FK，例外须有权威依据；
schema闭合检查不代替真实PG23503及约束名负例。
活动岗位字段/参数/relation用activityPositionId/activityPosition，仅URL保留positions段。
list includeStats用批量groupBy；participation-summary评价复用feedback aggregate，
不复制统计核或增加N+1。按改动跑发布/责任并发、父子窗/容量与共享候补、
Form/V7/资格、模板成果与切换定向验收；契约改动再跑contract。
