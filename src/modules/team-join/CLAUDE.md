# team-join — 资格、贡献与入队线性化

负责Cycle、申请、gate/综合评估、贡献进度与final join。
贡献来源切换与保险资格是不同既有配置，不能混为一个开关或另增开关。

- computeContribution/computeCappedContribution必传同一ActivityWorkflowGate与只读账本端口。
  责任制闸关：approved考勤，北京日封顶3；闸开：仅SUM committed credited delta含冲回/重记，
  不叠加旧分、不二次封顶、空账不fallback。cycle.year cutoff/门槛5不变，单人批量同核。
  旧分上线前转换并逐人对账总分/cutoff，生产转换未执行。
  既有考勤终审通知仍同事务approved前后调用该核，不新建账本提交通知。
- contribution-ledger-reader只声明语义；TeamJoinModule.register(reader)唯一token注入，
  AppModule唯一组合点传公开LedgerQueryService。
  team-join不直接聚合账本、不反向import实现、不提供旧核或global client默认；批量一次groupBy。
- Cycle requiresInsurance默认false。保险单gate关闭时只配置/回显，不查资格不产evidence；
  开且cycle=true只在final join捕获一次now，按北京当日requiredFrom=requiredThrough，
  verified self优先live Policy+Coverage，无来源26031。申请/评估阶段不生成evidence。

## 锁与状态

凡取member键的事务使用runMemberLinearizedTransaction（ReadCommitted、有界锁等待），
不能退回默认隔离级别的裸事务，避免取键前快照造成write skew。
submit/updateTargets/markGate/evaluate/final join全部先lockMembersForWrite，再Application行锁。
admin两入口共用lockMemberThenApplication：预读memberId→键→FOR UPDATE→复读复核；
evaluate不再claimAtStatus。禁止行锁先于member键，否则与final join的sibling/audit User锁成环。

final join根锁序为外层member键→Application→Cycle→source（self或Policy→Coverage）→
Member→linked User→join writes→Evidence→Audit/outbox。
同事务按id ASC锁并终结本人其他live申请为rejected、eliminationStage=already-enrolled，
逐条team-join-application.supersede，不伪造evaluatedBy/At。
依据是人已入队，不是轮关闭；关轮不使approved资格失效。
Cycle update按id ASC锁全部live Application，再锁/复读Cycle后update/audit，不退回无锁findFirst。

isUnenrolledVolunteer是live申请走通的唯一前提；
team-join-enrollment-invariant是唯一身份transition闸。
final join之外改变身份者先assertEnrollmentIdentityChangeAllowed，
有live申请28211，不自动终结或静默放行；该闸取得member键，必须先于Member lifecycle锁。

## Evidence与验证

Evidence绑定TeamJoinApplication，只含最小snapshot，任一步失败全回滚；
不存保单号、附件/图片、key/URL、note/reason或自由文本。
已交付migration不代表已生产deploy；不提供改删入口、不把DB约束失败另映新BizCode。
不新增review/权限/schema来绕过现有final join边界，26031不用于其他场景。

验证enrollment-lifecycle-concurrency、gate-evaluate-member-lock-concurrency、
enrollment-identity-invariant与保险source/owner/audit回滚。
final join×cycle update/review/coverage remove使用真双Nest/Prisma pool及PG锁屏障，
并检查“已入队队员无live申请”的全库不变量。
