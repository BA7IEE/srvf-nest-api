# users — 身份与生命周期

管理入口粗权限之外，能操作谁仍由 users.policy/assertCanManageUser 与自我保护判断；
SUPER_ADMIN>ADMIN>USER 不等同 RBAC 业务角色。规则细节见 permissions 和
`docs/reference/roles-admin-protection.md`。

- JwtStrategy 每请求查库，不缓存身份；禁用/软删下一请求失效。
  `loadActiveUserIdentityInTx(tx,userId)` 是跨域当前 User 读取唯一公开原语，
  只返 ACTIVE未删的安全身份快照；不创建事务/隐式锁/缓存。
  AppIdentityResolver 的 tx 只控制 Member 读取、不重读 User；
  写编排等待锁后先加载当前 User，再 resolve，不能复用锁前 memberId。
- App capabilities 只作提示；正式队员精确 level-1…level-7、当前 authz scope、
  发起记录和 active responsibility 每次读 PG，写端重判，不按 role 放宽准入。
- 削权共用 LastAdminProtectionPolicy，不另造 count/advisory SQL。
  锁序固定 last-SA → last-ops advisory（需要时）→ linked Member → User；
  guard、锁后重读重算、写入与 audit 同事务，不先锁 User 再等 invariant。
  linked 账号启用前确认 Member ACTIVE，不能从用户轴启用 INACTIVE Member 的账号。
- last-SA 保至少一个活跃 SA；ops-admin 同时保当前有效 holder 与 endedAt=null 常驻 holder，
  任期共用 role-binding-validity；任一归零30101，拒绝时 User/refresh 都不变。
  禁用/软删在同事务 revoke refresh，reason=admin-disable/admin-delete。
- 所有 session 写复用 lockAuthSessionUser，锁后重读再 mutation/revoke/audit，
  不复制 FOR UPDATE、不先 broad revoke 后补锁。
  role/status/soft-delete 同事务记录既有 user.* 审计，before/after 仅安全动作字段。

## 本人身份换绑

phone/wechat/wecom PUT 必填 action-bound stepUpToken，User 锁后完整 credential snapshot 校验 proof。
真实变更同事务写身份、撤全部活跃未过期 refresh、写 masked bind/rebind audit；
原因分别 self-phone-identity-change、self-wechat-identity-change、self-wecom-identity-change。
同目标 no-op 不撤 refresh、不写变更 audit，旧 access 不主动吊销。
proof/snapshot/因子/完整 phone/openid 不进 audit、日志或 App 响应。

企业微信独立 user-wecom-binding.service，与 auth/login-wecom 是姊妹流程；
改任一方须比对锁序、occupancy、revoke+create、refresh 和 audit。
WECOM_BIND 使用锁后快照，防旧 proof 在管理员清除后重新绑定。
显式解除仅 admin DELETE，无 App DELETE；空转不审计不撤 refresh。

revokeActiveWecomIdentityInTx 是唯一撤销原语：
clearUserWecom、softDelete、members.reopenAccount 都复用；
位置是 User session 锁之后、refresh/audit之前，原语不隐式取 User 锁。
代际终止（softDelete/reopenAccount）撤销；
临时 disable/enable、members account/status/offboard 一列也不改 WecomIdentity（含 updatedAt）。
沿 umbrella audit 写 extra.wecomIdentitiesRevoked，含0，不另造逐腿事件。

## 头像

app-avatar.service 独立，仅依赖 AttachmentVisualIdentityUploadService。
multipart 经服务器规范化，不用 upload-url 先让含 EXIF/GPS 原图入 storage。
短事务备 intent → 事务外 put+HEAD → 短事务落库改指针，两次都锁 User并复核生命周期；
中间释放锁不可假定账号仍有效。清空幂等、空转不 audit。
旧头像清理必须 prepareDelete+executeEventKey 成对，只有前者会留下永不执行的删除意图。

验证 last-admin、user-role/role-binding、身份 step-up/session lock、
wecom-user-lifecycle 整行快照与头像阶段回归；端点/DTO变化再跑 contract。
