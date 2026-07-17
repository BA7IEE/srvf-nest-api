# PostgreSQL 一致性加固综合评审稿 — D0 冻结

> **状态：D0 已拍板，等待本评审 PR 合入后按本文 PR 链实施。**
>
> 基线：`main@d2d2494d84f10cbb3ee664ef56acbff89fe6eca5`（2026-07-17）；当前事实仍以 [`docs/current-state.md`](../../current-state.md)、live code、schema 与 GitHub 状态为准。本稿是 D 档立项与方案冻结记录，合入后不回改；实施进度写入滚动权威源与各 PR，不反写本历史稿。
>
> 用户批准记录：维护者于 **2026-07-17** 对总控提交的 PostgreSQL 一致性加固方案回复 **“按推荐”**。授权精确范围是本文 §4 的方案 A 与 §5 的分 PR 链；D0 lane 仅获准新增本稿、commit、push、开非 draft PR，**未授权在 D0 实现生产代码或 merge**。

---

## 0. 人话简报与冻结结论

- **人话简报·做什么**：继续只用 PostgreSQL，把组织树写入、短信签发、RBAC 判权、全局限流和通知投递的跨实例一致性收成可测试的共享规则。
- **人话简报·不做会怎样**：横向扩容或请求并发时，可能出现组织权限范围错乱、撤权延迟、限流额度按副本数放大、短信限额穿透/多活码，以及业务已提交但通知永久丢失。
- **人话简报·最坏情况与回退**：共享行成为热点会增加等待；外部通道仍可能重复投递。以锁等待、bucket 延迟、outbox lag/dead 指标守护，代码可逐 PR 回退；additive 表先保留，不在回退时立即 DROP。
- **推荐方案 A（已批准）**：PostgreSQL advisory lock + 每请求 DB 判权 + PostgreSQL throttler storage + durable notification outbox。维护者回复“按推荐”即批准本精确范围。

**冻结结论**：

1. PostgreSQL 是本阶段唯一共享协调面。
2. Redis、BullMQ、外部 queue 与第 3 个 cron 继续冻结。
3. D-ORG / D-SMS / D-RBAC 均为 **0 schema**；D-Throttle 与 D-Outbox 各使用一枚 migration token，二者绝不并行。
4. 外部通道只承诺 **durable intent + at-least-once**。没有 provider 幂等键时，禁止写“exactly-once”。
5. 全链默认 **0 endpoint / 0 DTO / 0 BizCode / 0 Permission / 0 Role / 0 AuditLogEvent**。实施探针若证明任一新增不可避免，必须回总控重新拍板。

---

## 1. 基线、核实方法与裁决标签

### 1.1 基线事实

- 基线提交：`d2d2494d feat(auth): revoke refresh family on logout (#684)`；local main、origin/main 与远端 main 同 SHA；D0 开工时 open PR = 0。
- 当前计数：36 模块 / 74 Controller / 364 Endpoint / 55 Migration / 252 BizCode / 206 Permission / 114 AuditLogEvent / 9 Role / 2 Cron（[`current-state.md:7-30`](../../current-state.md)）。
- D 档依据：鉴权、安全、migration 与全局 Guard/基础设施变更按 [`process.md:39-75`](../../process.md) 降速；所有实施拆 PR，禁止夹带。

### 1.2 标签定义

- **CONFIRMED**：live code/schema 已确定该窗口，或真实 PostgreSQL 并发已复现。
- **PLAUSIBLE**：存在完整可执行交错，但 D0 未做运行时复现，或风险仅在多实例条件成立时出现。
- **NOT REPRODUCIBLE**：当前约束或原子写已排除该具体主张；不外推为相邻风险也不存在。

---

## 2. 当前代码事实、真实复现与边界

### 2.1 F-ORG：组织 closure 并发破坏授权范围

**结论：CONFIRMED，P1，高风险。**

Live 事实：

- `Organization.parentId` 只有 FK Restrict 与普通索引；`organization_closure` 只有 `(ancestorId, descendantId)` 主键和两端 FK，没有无环、路径完备或 depth 正确约束（[`schema.prisma:161-239`](../../../prisma/schema.prisma)）。
- `create` 在事务中先验证父/根，再写 Organization、读取父 closure、插 closure；事务开始前后均无锁（[`organizations.service.ts:280-357`](../../../src/modules/organizations/organizations.service.ts)）。
- `move` 依次读取 target/new parent/subtree，基于当前快照判环，删除旧边、读取新父祖先、插新边、更新 `parentId`；没有行锁、表锁、advisory lock 或 SERIALIZABLE（[`organizations.service.ts:448-542`](../../../src/modules/organizations/organizations.service.ts)）。
- `softDelete` 的 child/member 计数与后续软删同事务但无拓扑锁（[`organizations.service.ts:544-599`](../../../src/modules/organizations/organizations.service.ts)）。
- closure 算法在串行快照下成立：cycle 只查当前 subtree，新边为“新父祖先 × 子树”的笛卡尔积（[`organization-closure.util.ts:45-80`](../../../src/modules/organizations/organization-closure.util.ts)）。
- authz 直接用 closure 展开 `ORGANIZATION_TREE` scope，并用 closure 祖先链判 `covers()`（[`authz.service.ts:139-185`](../../../src/modules/authz/authz.service.ts)、[`authz.service.ts:500-522`](../../../src/modules/authz/authz.service.ts)、[`resource-resolver.service.ts:364-373`](../../../src/modules/authz/resource-resolver.service.ts)）。

真实 PostgreSQL 复现（lane 派生 test DB，未写默认 app DB）：

1. 初始 `R` 下有兄弟 `A/B`；并发调用当前 `OrganizationsService.move(A→B)` 与 `move(B→A)`。第 2 次尝试两个 Promise 均 fulfilled，最终 `A.parentId=B && B.parentId=A`，closure 同时出现 `A→B`、`B→A`。
2. 初始 `R→{A,B,D}`、`D→C`；并发 `A→B` 与 `C→A`。第 1 次尝试两者均成功，最终邻接树为 `R→B→A→C`，closure 缺 `B→C` 且 `R→C depth=2`（正确应为 3）。
3. 并发 `softDelete(P)` 与 `move(C→P)`。第 1 次尝试两者均成功，最终 P 已软删但 live C 仍挂 P。

边界：

- **NOT REPRODUCIBLE：物理重复 closure pair。**复合主键会使竞争插入冲突回滚，不会保存两条相同 pair。
- **NOT REPRODUCIBLE：单次 move 的已提交半写。**删边、插边、parent 更新、audit 在同一事务；问题是多个完整事务交错。
- **PLAUSIBLE：create child × move parent、双 root create。**前者与漏边时序同构；后者是无锁 count-before-insert（[`organizations.service.ts:166-175`](../../../src/modules/organizations/organizations.service.ts)），但 D0 未追加动态复现。

### 2.2 F-RBAC：进程内权限缓存跨实例撤权陈旧

**结论：CONFIRMED（多实例条件成立时），P1；当前单实例部署尚未触发。**

- `RbacCacheService` 明确持有进程内 `Map`，TTL 来自配置，默认 1800 秒；get/set 与三个 invalidate 入口只操作该 Map（[`rbac-cache.service.ts:24-110`](../../../src/modules/permissions/rbac-cache.service.ts)、[`app.config.ts:419-426`](../../../src/config/app.config.ts)）。
- `RbacService.getUserPermissionCodes()` cache hit 直接返回，miss 才查 RoleBinding/RolePermission（[`rbac.service.ts:70-110`](../../../src/modules/permissions/rbac.service.ts)）。
- 角色、权限、绑定写路径的提交后失效链只拿到当前进程中的 provider；跨进程没有广播或共享状态。故实例 A 撤权后，实例 B 已缓存的授权最多陈旧到该 entry 的剩余 TTL。
- [`deployment.md:8`](../../deployment.md) 已登记同一多实例边界，和 live code 一致。

边界：

- **NOT REPRODUCIBLE：用户禁用/软删因 RBAC Map 继续通过身份认证。**`JwtStrategy.validate()` 每请求查 User，并校验未软删且 ACTIVE（[`jwt.strategy.ts:12-53`](../../../src/modules/auth/strategies/jwt.strategy.ts)）；本项只处理 permission resolution，不改 JwtStrategy。
- SUPER_ADMIN 的身份层短路不属于 Map 陈旧问题；D-RBAC 不改变三层 Role 语义。

### 2.3 F-THROTTLE：10 个命名 throttler 使用进程内 storage

**结论：CONFIRMED（N 实例时有效额度约为 N 倍），P1；当前单实例下额度正确。**

- `buildThrottlerOptions()` 注册 `default / password-change / refresh / sms-send / sms-verify / password-reset / login-sms / login-wechat / recruitment / content-public` 共 10 个 throttler，未注入 `storage`，因此使用包默认内存实现（[`throttle-options.ts:19-93`](../../../src/bootstrap/throttle-options.ts)）。
- App 通过 `ThrottlerModule.forRootAsync()` 全局装配该 options（[`app.module.ts:79-85`](../../../src/app.module.ts)）；Guard 将 10 种 metadata 一一映射到命名 throttler（[`throttler-biz.guard.ts:75-224`](../../../src/common/guards/throttler-biz.guard.ts)）。
- 当前包锁定 `@nestjs/throttler@6.5.0`（[`package.json:52`](../../../package.json)、`pnpm-lock.yaml:1036`）；默认 storage 内部是 Map。每个 Nest 进程各自计数，同一 IP 被负载均衡到 N 个实例时可分别消耗 N 份额度。

边界：

- **NOT REPRODUCIBLE：10 个命名 throttler 互相串桶。**当前 name/metadata 映射将它们物理隔离；D-Throttle 必须保留该隔离与现有 429/BizCode/无 header 语义。
- SMS 的 phone 维度 DB 限额不能替代 IP throttler；两者保护面不同。

### 2.4 F-SMS：issue 检查与单活码写入不是一个原子临界区

**结论：CONFIRMED，P1。消费 CAS 安全，issue 不安全。**

- 60 秒间隔按 `phone` 查询最新 code，日 10 次按 `phone` 计数；两项均发生在事务外（[`sms-code.service.ts:55-92`](../../../src/modules/sms/sms-code.service.ts)）。
- provider resolve/生成 code 后，只有“旧码作废 + 新码创建”在事务内，且无 advisory lock（[`sms-code.service.ts:94-131`](../../../src/modules/sms/sms-code.service.ts)）。
- schema 只有 `(phone,purpose)` 普通索引，没有单活码 unique；并发 issue 可共同通过 interval/daily 检查，并分别创建活码（[`schema.prisma:1679-1706`](../../../prisma/schema.prisma)）。
- 当前文档 [`deployment.md:7`](../../deployment.md) 称 SMS DB 第二道防线“天然多实例安全”，与上述 live code 冲突；按权威顺序以代码为准。D0 不回改既有文档，D-SMS 实施 PR 必须 true-up。

边界：

- **NOT REPRODUCIBLE：同一验证码并发消费两次。**`verifyAndConsume()` 以 `updateMany({id, consumedAt:null})` CAS 抢占，败者统一 24010（[`sms-code.service.ts:176-204`](../../../src/modules/sms/sms-code.service.ts)）。D-SMS 不改消费 CAS、不改 attempts、防枚举错误或明文码纪律。
- provider resolve 保持事务前；外部 SMS 发送继续在事务外，避免持锁/持事务等待外部 HTTP。

### 2.5 F-OUTBOX：marker、commit-after-effect 与先外发后记账窗口

**结论：CONFIRMED，P1/P2（按业务权威性分层）。**

1. **Expiry marker 先写、派发后做。**活动 `startReminderSentAt`、证书 `expireNotifyDueAt`、个人/队保 `expireNotifiedAt` 都先 CAS 置 marker，随后才调用 dispatcher；marker 后崩溃或派发失败会让后续扫描跳过，通知永久丢失（[`expiry-reminder.service.ts:78-177`](../../../src/modules/notifications/expiry-reminder.service.ts)、[`expiry-reminder.service.ts:262-343`](../../../src/modules/notifications/expiry-reminder.service.ts)）。
2. **状态/audit commit 后才派发。**证书到期状态与 audit 在事务内提交，通知随后独立写（[`expiry-reminder.service.ts:180-258`](../../../src/modules/notifications/expiry-reminder.service.ts)）。
3. **业务 producer commit → Effect。**招新 promote（[`recruitment-promotion.service.ts:156-251`](../../../src/modules/recruitment/recruitment-promotion.service.ts)）、入队 join（[`team-join-enrollment.service.ts:82-247`](../../../src/modules/team-join/team-join-enrollment.service.ts)）、报名 approve/reject（[`activity-registrations.service.ts:973-1171`](../../../src/modules/activity-registrations/activity-registrations.service.ts)）、活动 publish/cancel（[`activities.service.ts:900-1074`](../../../src/modules/activities/activities.service.ts)）、考勤终审（[`attendances.service.ts:1403-1538`](../../../src/modules/attendances/attendances.service.ts)）均在业务 commit 后 try/catch 派发。进程在两者之间退出，业务成功但没有 durable notification intent。
4. **生日先外发后记账。**生日 job 先查 SENT，再调用 provider，成功后才写 `sms_send_logs`；provider 成功后、log 前崩溃会在重跑时再发（[`birthday-greeting.service.ts:113-166`](../../../src/modules/notifications/birthday-greeting.service.ts)）。
5. **短信先外发后两次记账。**notification SMS 先 provider send，再写 send log 与 delivery；任一步之间崩溃会产生未知投递态或重发窗口（[`notification-sms-dispatch.service.ts:103-194`](../../../src/modules/notifications/notification-sms-dispatch.service.ts)）。
6. **微信先外发后 delivery。**quota 先原子扣减，再调用微信，最后写 delivery；provider 已接收但 delivery 未写时只能按未知处理（[`notification-wechat-dispatch.service.ts:253-321`](../../../src/modules/notifications/notification-wechat-dispatch.service.ts)）。
7. `NotificationDispatcher.dispatchTargeted()` 当前本身是 producer commit 后的独立 Notification create，再机会式调用微信（[`notification-dispatcher.ts:17-82`](../../../src/modules/notifications/notification-dispatcher.ts)）。

边界：

- **NOT REPRODUCIBLE：只靠本地事务向无幂等键 provider 保证 exactly-once。**DB 不能原子提交外部 HTTP；worker 在 lease 到期后重试必然允许“provider 已收、DB 未记”的重复窗口。
- **PLAUSIBLE：重复外发的实际频率。**窗口由 crash/network ambiguity 触发，D0 未调用真实 provider 复现；代码顺序已确认窗口存在。
- 站内 Notification insert 是同库副作用，但当前仍不与 producer 主事务绑定；outbox 统一收口，避免继续维护两套可靠性语义。

---

## 3. 方案对比

| 方案          | 内容                                                                          | 优点                                                 | 代价/否决理由                                                       |
| ------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| **A（冻结）** | PostgreSQL advisory lock、DB 直读 RBAC、PG throttler bucket、PG outbox worker | 唯一共享协调面；不引新基础设施；能用真实 PG 并发 E2E | 增加 DB 热点、两枚 additive migration、外部通道仍仅 at-least-once   |
| B             | Redis cache/lock/rate-limit + BullMQ/外部 queue                               | 成熟分布式组件、吞吐高                               | 撞 current-state 基础设施冻结；运维面与故障域显著扩大；本阶段不批准 |
| C             | 只缩 TTL/只加重试/继续进程内状态                                              | 改动小                                               | 无法消除跨实例分叉、组织树破坏和 durable intent 缺失；否决          |

---

## 4. 冻结决策（方案 A）

### 4.1 共享基础边界

- PostgreSQL 是本阶段唯一共享协调面；允许 transaction-scoped advisory lock、行锁、unique、原子 SQL、`FOR UPDATE SKIP LOCKED`。
- 禁止 Redis、BullMQ、外部 queue、事件总线、第 3 个 cron、自动 retention cron。
- 所有 advisory lock 使用固定字符串命名空间经稳定 64-bit 派生函数转换为 key；禁止依赖 JS 进程随机 hash、对象地址或启动时盐。
- 建议统一派生：`sha256(namespace + ':' + normalizedParts.join(':'))` 取固定前 64 bit，按 PostgreSQL signed bigint 解释；测试固定输入→固定 bigint golden vector。日志只记 namespace/资源掩码，不打印 phone 明文。
- transaction-scoped lock 只能用 `pg_advisory_xact_lock`，随 commit/rollback 自动释放；禁止 session lock。

### 4.2 D-ORG：组织拓扑单锁

- `OrganizationsService.create/update/updateStatus/move/softDelete` 的每个写事务，在任何 Organization/closure 读取或写入之前，获取同一个 `srvf:organizations:topology:v1` transaction advisory lock。
- `rbac.can()` 保持事务外；锁内保留原校验顺序、DryRunAbort、audit 与响应语义。
- 所有组织写只拿这一把拓扑锁，不再组合 per-node 锁；锁序天然唯一，避免 A/B 节点反序死锁。
- create 的单根计数、status/delete 的 last-root/children 计数、move cycle/closure 重算均进入同一串行临界区。
- **0 schema / 0 endpoint / 0 DTO / 0 BizCode / 0 Permission / 0 AuditLogEvent。**announcement-import 复用 create，自动继承该锁。
- 部署前只做 closure 等价只读审计：递归邻接树与 closure 的 missing/extra/wrong-depth/cycle 均为 0。若发现存量脏数据，修复/回填另立 D 档，**不包含在本 goal**。

### 4.3 D-SMS：phone → phone+purpose 双锁

总控在 D0 核实时确认：原批准 advisory-lock 方案必须按 live 查询维度精化，且不改变业务口径或授权范围。

- provider resolve 保持事务前；进入 issue 事务后固定顺序获取两把 transaction advisory lock：
  1. `srvf:sms:issue:phone:v1:<normalizedPhone>`：保护跨 purpose 的 60 秒最近发送检查与自然日 10 次计数。
  2. `srvf:sms:issue:phone-purpose:v1:<normalizedPhone>:<purpose>`：保护该 phone+purpose 的旧活码作废与新码创建。
- 两把 key 都用 §4.1 稳定派生；phone 进入 hash 前先按现有 DTO/调用链规范化，日志不得打印原值。
- 相关 latest/count/updateMany/create 必须全部位于持有双锁的同一事务；任何路径若按相反顺序取锁，测试与 review 直接判失败。
- 外部 provider send 与 send log 继续在事务外；D-SMS 不尝试用长事务覆盖外部 HTTP。
- **0 schema。**不改 `verifyAndConsume` CAS、attempts、HMAC、错误码、防枚举、provider 解析或发送失败语义。

### 4.4 D-RBAC：移除跨请求权限缓存

- `RbacService.getUserPermissionCodes()` 每次从数据库解析当前在期 GLOBAL RoleBinding 与 RolePermission；删除 Map hit/miss 分支。
- 删除/退役 `RbacCacheService` get/set、TTL 配置与所有“提交后 invalidate”依赖链；写路径不再承担缓存正确性。
- `getRoleIdsWithPermission()` 本来就直读 DB，保持不变；AuthzService 三源与 scope 语义不改。
- JwtStrategy、JwtPayload、身份 ACTIVE/软删每请求查库规则不改。
- **0 schema / 0 endpoint / 0 DTO / 0 BizCode / 0 Permission。**性能以 SQL latency/query count 监控；不得在本刀换成另一种跨请求缓存。

### 4.5 D-Throttle：PostgreSQL shared storage

- 新增一张 additive throttler bucket 表；`(throttlerName, key)` 唯一，每个 key 的滚动 hit expiry 集、blockedUntil、retention 时间在一行内，由 PostgreSQL 行锁/原子 SQL更新。
- 必须覆盖现有全部 10 个命名 throttler，保留 name 隔离、IP tracker、阈值、TTL、blockDuration、HTTP 429/BizCode 42900、`setHeaders:false`。
- 当前 `@nestjs/throttler@6.5.0` live 接口冻结为：

```ts
increment(
  key: string,
  ttl: number,
  limit: number,
  blockDuration: number,
  throttlerName: string,
): Promise<{
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}>;
```

证据：`node_modules/@nestjs/throttler/dist/throttler-storage.interface.d.ts:2-4` 与 `throttler-storage-record.interface.d.ts:1-6`；包版本见 [`package.json:52`](../../../package.json)。升级包版本前必须重核接口。

- 语义按当前 6.5.0 characterization：每次未 blocked hit 有独立 ttl expiry；超过 limit 进入 block；block 期间不继续加 hit；block 到期清零后当前请求计为新 hit。禁止悄悄改成简单固定窗口。
- DB/storage error **严格 fail-closed**：绝不 fallback 到进程内 Map，绝不放行业务 handler；沿现有系统异常路径失败，0 新 BizCode。实现 PR 必须用故障注入证明 handler 零调用。
- migration token 恰好 1 枚；无新依赖。过期 bucket 只按手动 retention SOP 清理，不新增 cron。

### 4.6 D-Outbox：durable notification intent + PostgreSQL worker

#### 数据模型

新增 additive `notification_outbox_intents`（最终 Prisma 名在实施 PR 以 schema 规范落位）至少包含：

- `id`、`eventKey @unique`、`eventType`、`payloadVersion`、`payload Json`
- `status`：`pending | processing | succeeded | dead`（可用 String 常量，避免为状态扩 enum）
- `attempts`、`availableAt`
- `leaseOwner`、`leaseExpiresAt`
- `lastErrorCode`/`lastErrorClass`（禁止存 secret/完整 provider payload）
- `completedAt`、`deadAt`、`createdAt`、`updatedAt`
- claim 索引 `(status, availableAt)`、lease 回收索引 `leaseExpiresAt`、retention 索引 `createdAt`

`eventKey` 必须由稳定业务事件身份产生，不用随机时间戳冒充幂等键。终态/单次跃迁优先使用 `producer:operation:aggregateId[:targetState]`；可重复合法变更使用在事务外生成并透传同一事务的 event id，重试 worker 复用原 key。

`payloadVersion` 必须显式落库；worker 只走静态 `eventType + payloadVersion` handler allowlist。未知类型/版本直接进入 dead 且保留可诊断错误分类，禁止由 payload 动态装载模块或决定 URL。payload 只存内部实体/收件目标引用与最小、已审模板参数；禁止 token、secret、provider credential、完整 signed URL、原始 provider 请求/响应报文，`eventKey` 也不得嵌入原始手机号/OpenID。若某 producer 为可靠投递必须新增原始手机号等敏感字段，先回答“业务用途、查看角色与掩码、保存期限与退队清理”三问并停回总控，实施 lane 不得自行放宽。

#### producer 规则

- producer 与业务状态、marker、audit **同一事务写 intent**；producer 事务内只写 DB，不调用外部 provider。
- expiry：marker/status/audit 与对应 intent 同事务。marker 不得在没有 intent 时单独置位。
- 招新 promote、team-join join、报名/活动/考勤等 producer 把现有 commit 后 dispatcher 调用改为事务内 enqueue；业务响应仍不等待 provider。
- 生日继续复用现有 `birthday-greeting` cron：cron 只为“北京日期 × 模板 × 收件人”写唯一 intent，不直接外发；worker 消费。expiry-reminder 继续是现有第二个 cron，不新增第三个。
- `NotificationDispatcher` 转为 intent payload/handler 边界，不再作为 producer commit 后的可靠性孤岛。

#### worker 规则

- 独立 PostgreSQL worker 进程，不挂 Nest `@Cron/@Interval/@Timeout`，不引 Redis/BullMQ。
- claim 事务使用 `FOR UPDATE SKIP LOCKED` 领取 `pending && availableAt<=now` 或 lease 已过期的 processing 行，写 `processing + leaseOwner + leaseExpiresAt + attempts+1` 后立即提交。
- 外部 HTTP 在 claim 事务外执行。成功写 succeeded；明确失败按有界指数 backoff 回 pending；超过 max attempts 进入 dead。进程在 provider 成功后、ack 前退出时，lease 到期可重领，因此只承诺 at-least-once。
- worker 可多副本并行，SKIP LOCKED 保证同一时刻不重复领取；lease 负责 crash recovery。
- dispatch 前按静态 `eventType + payloadVersion` allowlist 解析；未知组合不执行任何 Effect，进入 dead 并暴露可诊断分类。
- provider 若支持幂等键，传 `eventKey`；不支持则保留重复可能，禁止伪称 exactly-once。
- migration token 恰好 1 枚；与 D-Throttle migration 绝不并行。历史 Notification/SmsSendLog/Delivery 不回填为 intent。

---

## 5. PR 链、排班与 migration token

```text
D0 review
  ├─ D-ORG ─────┐
  ├─ D-SMS ─────┼─ 串行集成
  └─ D-RBAC 补位┘
        ↓
D-Throttle（migration token #1）
        ↓
D-Outbox core（migration token #2）
        ↓
D-Outbox recruitment/team-join producers
        ↓
D-Outbox participation producers
```

- D-ORG / D-SMS / D-RBAC 是互不相交 bounded context，可按 lane 槽位并发开发；**合入仍由总控逐 PR 串行**。
- D-RBAC 在 D-ORG/D-SMS 任一 lane 释放后补位；不与 D-Throttle 混成一个 PR。
- D-Throttle 与 D-Outbox core 各持一枚 migration token，绝不并行开发或集成。
- participation producer 接入不得与 **C-QUAL / C-RULE** 并行；这些线共享 activities/registrations/attendances/contribution bounded context。
- 任一在飞 lane 在前序 PR 合入后必须 rebase，再跑 lane preflight 与受影响门禁。
- 全链 no release / no tag / no version bump；D0 与实施 PR 均禁止 merge 自治。

---

## 6. 逐 PR 实施卡

### PR D0 — 本冻结稿

**写集**：仅新增 `docs/archive/reviews/postgresql-consistency-hardening-review.md`。

**DoD**：本稿覆盖 live evidence、标签边界、方案 A、双锁、throttler 6.5.0 类型、outbox 语义、PR 写集/测试/回退/非目标；docs 守护与链接检查通过；diff 白名单恰好 1 文件。

**明确未做**：不改 src/test/prisma/package/现有 archive/CHANGELOG；不跑 migration；不 merge。

### PR D-ORG — organization topology serialization（0 schema）

**候选写集**：

- `src/modules/organizations/organization-topology-transaction.ts`（新）
- `src/modules/organizations/organizations.service.ts`
- `src/modules/organizations/CLAUDE.md`
- `test/e2e/organizations-concurrency.e2e-spec.ts`（新）
- `changelog.d/<lane>.md`
- `CODEMAP.md`（仅 codemap 守护要求时 true-up）

**DoD / 探针**：五个写入口在第一条 topology SQL 前获取同一 xact lock；移除 lock 变异会使真实并发测试失败；closure 递归等价审计为 0 差异；DryRunAbort/audit/announcement-import 行为不漂移。

**测试矩阵**：

- A→B × B→A：一方成功，另一方现有 11012；无环、closure 等价。
- A→B × C→A：允许串行后均成功；missing/extra/wrong-depth=0。
- softDelete parent × attach child：只允许一个业务结果生效，绝不出现 live child→deleted parent。
- create child × move parent、并发 root create、同节点双 move、不相交 moves。
- `organizations.e2e`、audit characterization、authz visible-scope/resource-resolver、announcement-import、full gate。

**回退条件**：组织写 lock wait p95/p99 超预算或死锁不为 0。先查锁内慢 SQL；紧急代码回退会重新暴露 P1，一旦回退必须同时冻结组织写并回总控，不做 schema 回滚。

**未做**：不做 closure 回填/重建，不改 authz、controller、DTO、BizCode、Permission、audit event。

### PR D-SMS — atomic issue 双锁（0 schema）

**候选写集**：

- `src/modules/sms/sms-issue-lock.ts`（新，命名可按模块局部规范微调）
- `src/modules/sms/sms-code.service.ts`
- `src/modules/sms/sms-code.service.spec.ts`
- `test/e2e/sms-code-concurrency.e2e-spec.ts`（新）
- `docs/deployment.md`（修正“天然多实例安全”漂移）
- `src/modules/auth/CLAUDE.md`（仅本地事实需要 true-up 时）
- `changelog.d/<lane>.md`

**DoD / 探针**：双锁顺序固定 phone→phone+purpose；四项 DB 操作同事务；provider resolve/外发在事务外；删除任一锁或把检查挪出事务的变异被真实并发测试杀死。

**测试矩阵**：

- 同 phone 同 purpose 并发 issue：只一个成功，另一方命中现有 60 秒限制；恰好一条 active code。
- 同 phone 不同 purpose 并发：phone 全局锁使 60 秒/日限不穿透。
- 日计数 9→两并发：最终最多 10，一方现有 24121。
- 不同 phone 并发不互阻；pg_locks 证明锁命名空间/顺序。
- provider unavailable 零 code；provider failure 既有保留 code+FAILED log；verify consume CAS 并发单赢家与 24010 防枚举不变。

**回退条件**：同号 lock wait 超预算、出现 advisory deadlock、发送成功率/现有 BizCode 分布异常。回退为旧 issue 流程只允许紧急短时，并同步收缩到单实例；0 schema 无 DB 回滚。

**未做**：不改模板、provider、消费 CAS、HMAC、DTO、endpoint、BizCode、throttler。

### PR D-RBAC — DB-backed permission resolution（0 schema）

**候选写集**：

- `src/modules/permissions/rbac.service.ts`
- `src/modules/permissions/rbac-cache.service.ts`（删除）
- `src/modules/permissions/rbac-cache.service.spec.ts`（删除/由 DB 行为测试替代）
- `src/modules/permissions/permissions.module.ts`
- `src/modules/permissions/{permissions,rbac-roles,role-permissions,user-roles}.service.ts`
- `src/modules/role-bindings/role-bindings.service.ts`
- `src/config/app.config.ts`、`.env.example`（退役 RBAC cache TTL）
- `src/modules/permissions/CLAUDE.md`、`docs/deployment.md`
- `src/modules/permissions/rbac.service.spec.ts`
- `test/e2e/rbac-multi-instance-consistency.e2e-spec.ts`（新）
- 现有 RBAC/authz characterization；`changelog.d/<lane>.md`

**DoD / 探针**：仓内生产代码 0 个 `RbacCacheService`/get/set/invalidate 引用；每次 can/judge 读 DB；两套 Nest app 共库，A 预热后由 B 撤权，A 下一请求立即拒绝；授予亦立即可见；JwtStrategy 无 diff。

**测试矩阵**：RBAC judge 矩阵、me/permissions、reload 契约兼容、user-role/role-binding/role-permission/role delete、authz-rbac-equivalence、three-source、两 app 共库 grant/revoke。

**回退条件**：DB permission query p95/p99、连接池占用或错误率超过预算。优先补索引/查询投影需另审；本 PR 禁止顺手加另一种 cache。紧急回退可恢复旧 Map，但多实例撤权陈旧风险同步恢复。

**未做**：不改 JwtStrategy/JwtPayload、Role/Permission 码、scope、SUPER_ADMIN 短路、endpoint/DTO/BizCode/schema。

### PR D-Throttle — PostgreSQL shared throttler storage（1 migration）

**候选写集**：

- `prisma/schema.prisma`
- `prisma/migrations/<timestamp>_postgresql_throttler_buckets/migration.sql`（新）
- `src/bootstrap/postgresql-throttler-storage.ts`（新）
- `src/bootstrap/throttle-options.ts`
- `src/app.module.ts`
- `test/setup/reset-db.ts`
- `test/e2e/throttler-shared-storage.e2e-spec.ts`（新）
- 现有 throttle e2e specs
- `docs/ops/postgresql-throttler-retention-sop.md`（新）
- `docs/deployment.md`、`prisma/CLAUDE.md`、`docs/current-state.md` 计数、必要时 `CODEMAP.md`
- `changelog.d/<lane>.md`

**DoD / 探针**：一张 additive 表、composite unique、原子 increment；两个 Nest app 共库合计只得到一份额度；10 names 全覆盖且互不串桶；6.5.0 record 四字段/单位与 block 语义 characterization 一致；DB/storage error 严格 fail-closed、handler 零调用、0 本地 Map fallback、0 新 BizCode；不新增依赖/cron。

**测试矩阵**：

- 两 app 对同 endpoint/IP 并发，总成功数不超过 limit，余者统一 42900。
- 同 IP 不同 endpoint/name 独立；不同 IP 独立。
- ttl 滚动过期、limit+1 block、block 到期首请求计 1、`setHeaders:false`。
- 原子 upsert 首击竞态、blocked 热 key；故障注入 DB/storage error，断言严格 fail-closed、业务 handler 零调用、无本地 Map fallback、沿既有系统异常路径且 0 新 BizCode；全 10 既有 throttle E2E。
- migration deploy 到 lane 派生 DB；禁止 migrate dev/reset/db push。

**回退条件**：increment p99/锁等待/DB CPU/连接池异常、429 比例异常。运行中绝不因 DB/storage error 自动 fallback 到本地 Map；紧急代码回退只允许先缩到单实例、停止/替换新部署，再显式恢复上一版本，回退完成前继续 fail-closed。additive bucket 表保留，后续手动 retention，不立即 DROP。

**未做**：不改 limit/ttl/env 口径，不新增 endpoint/BizCode/header，不引 Redis，不自动清表。

### PR D-Outbox core — model、worker 与 notifications-owned producer（1 migration）

**候选写集**：

- `prisma/schema.prisma`
- `prisma/migrations/<timestamp>_notification_outbox_intents/migration.sql`（新）
- `src/modules/notifications/notification-outbox.service.ts`（新）
- `src/modules/notifications/notification-outbox-worker.service.ts`（新）
- 独立 worker entrypoint（候选 `src/notification-outbox-worker.ts`）
- `src/modules/notifications/notifications.module.ts`
- `src/modules/notifications/notification-dispatcher.ts`
- `src/modules/notifications/expiry-reminder.service.ts`
- `src/modules/notifications/birthday-greeting.service.ts`
- `src/modules/notifications/notification-sms-dispatch.service.ts`
- `src/modules/notifications/notification-wechat-dispatch.service.ts`
- 对应 unit/e2e，`test/setup/reset-db.ts`
- `package.json`（仅 worker 启动脚本确有需要时）
- `docs/ops/notification-outbox-retention-sop.md`（新）、`docs/deployment.md`
- `src/modules/notifications/CLAUDE.md`、`prisma/CLAUDE.md`、`docs/current-state.md` 计数、必要时 `CODEMAP.md`
- `changelog.d/<lane>.md`

**DoD / 探针**：eventKey unique；payloadVersion 显式落库；静态 eventType+version handler allowlist；marker/status/audit+intent 同事务；两个现有 cron 只生产 intent；worker SKIP LOCKED+lease+retry/backoff+dead；provider 调用永不在 DB 事务内；进程 crash/lease reclaim 测试证明 durable+at-least-once；0 新 cron。

**测试矩阵**：

- 同 eventKey 并发 enqueue 只一条 intent，业务事务成功。
- marker 写失败→零 intent；intent 写失败→marker/status/audit 全回滚。
- 两 worker 并发不同时 claim 同一 lease；worker claim 后 crash，lease 到期被重领。
- provider transient failure backoff 后成功；超过上限 dead；dead 不静默删除。
- 未知 eventType/version 进入 dead、可诊断且零 Effect；payload schema/fixture 拒绝 secret、token、provider credential、完整 signed URL 与原始 provider 报文。
- provider 成功、ack 前 crash 可重复：测试明确断言 at-least-once 边界，不写 exactly-once 断言。
- birthday/expiry 二跑、SMS/WeChat delivery、notifications e2e 与 full gate。

**回退条件**：oldest pending age、dead rate、attempts、claim latency、lease reclaim、provider duplicate 投诉超预算。回退先暂停 worker并盘点 pending/processing，再决定 drain 或保持；禁止先恢复同步外发导致与 pending intent 双发。additive 表不立即 DROP。

**未做**：不回填历史通知/marker/log，不新增管理 endpoint/Permission/AuditLogEvent，不做自动 retention，不引 queue/Redis/cron。

### PR D-Outbox producer A — recruitment + team-join

**候选写集**：

- `src/modules/recruitment/recruitment-promotion.service.ts`
- `src/modules/team-join/team-join-enrollment.service.ts`
- 相应 module import/provider 接线
- `src/modules/recruitment/CLAUDE.md` 与 team-join 现有权威指针（如需）
- `src/modules/recruitment/recruitment-promotion.service.spec.ts`
- `test/e2e/{recruitment,team-join,notifications-directed}.e2e-spec.ts`
- `changelog.d/<lane>.md`

**DoD / 探针**：promote/join 业务事务内写 deterministic intent，删除 commit 后 dispatcher 调用；outbox 写失败使业务事务回滚；worker/provider 失败不逆转已提交业务；批量 promote 每个新 member 恰一 intent。

**回退条件**：业务事务时长/失败率异常或 eventKey 冲突不符合设计。回退前暂停/盘点 worker，防止同步调用与存量 intent 双发。

**未做**：不改发号、入队状态机、编号、部门、级别、DTO、endpoint、权限、audit event。

### PR D-Outbox producer B — participation

**候选写集**：

- `src/modules/activity-registrations/activity-registrations.service.ts`
- `src/modules/activities/activities.service.ts`
- `src/modules/activities/activity-positions.service.ts`
- `src/modules/attendances/attendances.service.ts`
- 对应 module/CLAUDE/audit characterization tests
- `test/e2e/notifications-participation-producers.e2e-spec.ts`
- activities/registrations/attendances state-transition 与并发 E2E
- `changelog.d/<lane>.md`

**排班硬约束**：不得与 C-QUAL / C-RULE 并行；写集与 bounded context 相交时必须排队。

**DoD / 探针**：approve/reject、publish/schedule-change/cancel、waitlist promotion、finalApprove 等现有 producer 在各自业务事务内 enqueue；业务状态/audit/intent 全或无；收件集在持有既有 aggregate lock 的事务内冻结；0 commit 后直接 dispatcher 调用。

**回退条件**：participation 事务时长、dead intent、收件集差异或行为锁漂移。任何状态机/贡献值/资格规则变化立即停，不借 outbox PR 调业务规则。

**未做**：不改 capacity、状态机、C-QUAL/C-RULE、contribution 算法、DTO、endpoint、权限、audit event。

---

## 7. 指标、失败语义与回退总表

| 项         | 必看指标                                                                                   | 正常失败语义                                            | 回退纪律                                            |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------- |
| D-ORG      | advisory lock wait p50/p95/p99、事务时长、deadlock、closure audit 差异                     | 后到请求基于新快照命中现有 BizCode 或成功               | 代码回退恢复 P1；回退时冻结组织写，0 schema         |
| D-SMS      | phone lock wait、24120/24121 比例、活码数、发送失败率、deadlock                            | 后到同号请求命中现有限额；不同 phone 并行               | 0 schema；回退须单实例并承认限额穿透风险            |
| D-RBAC     | permission query p95/p99、QPS、连接池、30100 比例                                          | DB 当前事实即时生效；DB 错误不允许用旧 cache 放行       | 可代码回退旧 Map，但跨实例陈旧风险恢复              |
| D-Throttle | increment latency、row lock wait、429 rate、hot key、表增长                                | DB error 沿既有系统异常路径 fail-closed；handler 零调用 | 运行中 0 fallback；仅单实例后显式回滚旧部署；表保留 |
| D-Outbox   | oldest pending、pending/dead 数、attempts、claim latency、lease reclaim、provider failures | transient→backoff，耗尽→dead；不丢 intent               | 先暂停 worker、盘点/drain；表保留，不立即 DROP      |

数据库热点不以“换 Redis”作为本 goal 内自动回退。触及新基础设施必须重新 D 档拍板。

---

## 8. 计数影响与全链非目标

### 8.1 预计净计数

| 项                                                           |  D0 | D-ORG | D-SMS | D-RBAC | D-Throttle | D-Outbox 全链 |
| ------------------------------------------------------------ | --: | ----: | ----: | -----: | ---------: | ------------: |
| Endpoint / DTO / BizCode / Permission / Role / AuditLogEvent |   0 |     0 |     0 |      0 |          0 |             0 |
| Migration                                                    |   0 |     0 |     0 |      0 |         +1 |            +1 |
| Cron                                                         |   0 |     0 |     0 |      0 |          0 | 0（仍恰好 2） |
| 外部依赖                                                     |   0 |     0 |     0 |      0 |          0 |             0 |

### 8.2 明确非目标

- 不做历史 closure、notification、delivery、sms log 数据回填。
- 不在 D0 改 schema；后续仅 D-Throttle 与 D-Outbox core 各一枚已冻结 migration。
- 不改任何旧 archive、已发布 CHANGELOG 段或本稿合入后的内容。
- 不新增 Redis、BullMQ、外部 queue、事件总线、第 3 个 cron、自动 retention。
- 不承诺外部 provider exactly-once；没有幂等键时重复是 at-least-once 的已知边界。
- 不新增 endpoint、Permission、AuditLogEvent；实施探针若证明不可避免，回总控重新拍板。
- 不做 release、tag、version bump；不合并任何 PR。
- 不把 D-Outbox 与 C-QUAL/C-RULE 的 participation 业务规则混改。
- 不在组织锁 PR 顺手修现有脏数据，不在 RBAC PR 改 JwtStrategy，不在 SMS PR 改消费 CAS。

---

## 9. 冻结声明

本稿冻结以下决策：**PostgreSQL 单一共享协调面；D-ORG 单拓扑 xact advisory lock；D-SMS phone→phone+purpose 双 xact advisory lock；D-RBAC 每请求 DB 解析并退役 Map；D-Throttle 按 `@nestjs/throttler@6.5.0` live 接口实现严格 fail-closed、0 本地 fallback 的 PostgreSQL shared storage；D-Outbox 使用 eventKey unique、payloadVersion、静态 eventType+version handler allowlist、最小已审 payload、SKIP LOCKED、lease、retry/backoff/dead 的独立 PostgreSQL worker，并只承诺 durable intent + at-least-once。**

任何改变基础设施边界、锁顺序、migration 数、对外错误/接口/权限/audit 计数、外部投递承诺或 PR 排班交集的提案，均超出“按推荐”授权，必须回总控重新拍板。
