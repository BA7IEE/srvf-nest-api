# member-departments — 两个入口，同一归属表

memberships新面与deprecated department兼容面均写member_organization_memberships；
两个service不互调，不恢复已DROP的MemberDepartment。
旧GET/PUT/DELETE只投影active PRIMARY，响应/错误码冻结，新需求走memberships面。

- membership-term-state-machine是任期唯一纯决策源：ACTIVE为startedAt<=now且endedAt=null，
  ENDED为startedAt<=endedAt<=now，SUSPENDED为endedAt=null且从不视为当前有效。
  不做定时生效/结束；结束只ACTIVE→ENDED，写前锁Member。
- 换部门/remove/transfer均结束旧行（ENDED+endedAt+endedByUserId），不软删历史；
  先end再create释放PRIMARY partial unique槽位。
  旧面仍查active返回null，新面不过滤status可见ENDED历史，不能把deletedAt=null当active计数。
- transfer是单事务唯一写编排，不拆成end()+create()。
  源组织不查存在/ACTIVE（用于迁出无效组织），源=目标400；P2002整体回滚。
  组织成员options复用MembersService投影；expand缺省不展开，静态路由先于:id。
  conflicts只诊断多ACTIVE PRIMARY、悬空队员、悬空组织、停用组织四类。

## 入队身份锁

六个写方使用runMemberLinearizedTransaction（ReadCommitted、有界锁等待），
assertEnrollmentIdentityChangeAllowed的member键必须先于lockMemberLifecycle；
存在live入队申请拒28211，避免与final join锁倒置：

- department set（含同org no-op）/remove、memberships end无条件过闸，end在读取归属前；
- memberships create/transfer仅PRIMARY过闸；
- memberships update在dto.membershipType!==undefined时过闸，任期不能绕状态机改变资格。

## 审计

resourceType=membership，同业务事务写：
create/end用membership.set/end，viaPath=membership、operation=create/end；
department set/remove用同两事件，viaPath=department、operation=set/remove。
set只记真实首次/换部门，before/after仅id/memberId/organizationId；
remove after为status=ENDED、endedAt、endedByUserId。
PATCH和同org无写分支不audit，是既定设计。

transfer仅一条membership.transfer，viaPath=membership-transfer，
resourceId=新行，extra含from/toOrganizationId、endedMembershipId，不再为两腿分别记set/end。
新入口用新viaPath，不能覆盖三种既有语义。
验证任期状态机、两面HTTP/并发/唯一槽位、audit-characterization与memberships-f4-admin；
审计失败须全事务回滚，失效归属立即不再产权限。
