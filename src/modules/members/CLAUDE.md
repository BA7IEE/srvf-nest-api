# members — 队员范围与生命周期

队员轴仅管理role=USER关联账号，其他Role先返MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE、回用户轴处理。
正式等级唯一谓词isFormalMemberGradeCode仅认精确level-1…level-7，不复制Set/正则或用归属推导。

## 读取与边界

- list/options取member.read.record的visible scope，与organizationId/includeDescendants求交；
  只active PRIMARY扩大范围，其他归属类型不算。持码但scope空返空列表，无码30100。
  除create无ref/GLOBAL-only外，详情/单项写用member ref，bulk每项独立判。
  certificate用certificate ref，档案/联系人/保险用member ref。
  resource_not_found仅旧GLOBAL持码者回既有NOT_FOUND，scoped统一30100。
- sensitive权限也带member ref，基础read允许不等于sensitive允许；未获敏感授权继续掩码。
  副职只读投影不含read.sensitive。
- MembersQueryService只接算好的scope做where/closure/投影，不注入rbac/authz、不export；
  跨模块复用MembersService.options，不开绕判权的第二入口。
  presenter/policy自由函数显式依赖；AuditRecorder仅AuditLogsService+调用方tx，不持PrismaService/自开事务。
- audience-tags按revokedAt保留历史、live pair partial unique。
  Member lifecycle锁内全量替换，仅ACTIVE未删member_audience_tag；空数组撤标不硬删；
  同事务member.audience-tags.update。GET/PUT先member authz后HTTP gate，已授权但gate关503。

## 账号、离队与锁

updateAccountStatus(DISABLED)、offboard/updateStatus(INACTIVE)、reopen旧号软删
共用LastAdminProtectionPolicy，保当前有效ops-admin及endedAt=null常驻holder，任一归零30101。
顺序固定invariant advisory→Member→User，锁后重算，不复制count/任期/锁键；
role护栏仍优先。bind/unbind只改memberId、账号仍live，不接last-admin守卫。
拒绝时账号/角色/成员所有腿/refresh/新号全不变；
放行沿既有refresh reason、username探测、先软删旧号后建新号和幂等skip。

Member生命周期统一member-lifecycle-lock：软删15001、inactive17030。
离队、linked账号启用/绑定/重开、任职/分管、活动责任、报名/递补、direct binding创建恢复共用Member排他锁；
通常Member→User，报名team保险保持Policy→Coverage→Member。
reopen/status/offboard在Member之后按linked userId调用lockAuthSessionUser，
锁后复读memberId/role/status再mutation/revoke/audit，不恢复第二套裸User锁。

offboard同事务终结授权来源、revoked活动责任并同步结束MEMBER system-managed binding，
audit记activityResponsibilitiesEnded，不异步补偿。
归属逐条走状态机ACTIVE→ENDED，以当前时刻结束，不盲批改任期。
改gradeCode与INACTIVE/offboard先过assertEnrollmentIdentityChangeAllowed，
有live入队申请28211，不开离队例外；member键在lifecycle前、offboard中在ops invariant之后。
这两类路径用runMemberLinearizedTransaction（ReadCommitted+有界锁等待）。

账号status写/refresh撤销/audit同事务，status-change仅before/after.status及
linkedUserId/refreshTokensRevoked。offboard/reopen复用既有umbrella事件，不多记一腿。
reopen的旧User代际终止：User锁后、refresh前复用revokeActiveWecomIdentityInTx，
extra.wecomIdentitiesRevoked恒写含0，新号不继承身份。
offboard/disable/enable是可恢复停用，WecomIdentity整行（含updatedAt）不动。
不注入UsersService或制造模块环。

## 标准照

member-official-portrait独立service，multipart由AttachmentVisualIdentityUploadService规范化。
Member FOR UPDATE→锁后重读ACTIVE→同事务旧SUPERSEDED+新ACTIVE→DB one-active partial unique，
P2002映射15040；provider阶段锁已释放，不能沿用锁前pointer。
旧endedAt与新activatedAt同一时刻，版本max(version)+1（作废也占号），被替代二进制保留作历史，
清理另走purge。scoped权限须再检目标在范围，复用buildOrganizationScopeFilter；
范围外/不存在同15001，不以hasPermission代替范围判定。
Swagger鉴权后缀严格`[rbac: <码>]`，范围说明放正文。

验证department-data-scope-members、last-ops-admin/account-lifecycle/offboard、
control-plane-audit、wecom整行生命周期与标准照并发/越权；
audit形状用完整字段集相等，不能多泄露字段。
