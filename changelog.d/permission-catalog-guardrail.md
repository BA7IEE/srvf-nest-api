### Fixed

- **管理员的一步自伤路已封:删一个权限码 = 一次性撤销所有角色对它的授权**(P1-32 PR1)。`DELETE /api/system/v1/permissions/:id` 此前是**物理删 + 零护栏** —— 只判调用者有没有 `rbac.permission.delete`(持有者:`ops-admin`),不检查这个码是不是正被角色使用;而 `RolePermission.permission` 是 `onDelete: Cascade`。clean 探针库实测:237 个权限码 / 337 条 `role_permissions` 下执行 `DELETE FROM permissions WHERE code='member.read.record'` → `DELETE 1`,`role_permissions` 337 → 333,`biz-admin` / `org-admin` / `org-readonly` / `org-supervisor` **四个角色同时失去「查看队员」**。全程无确认、无影响预览、无撤销。恢复也只恢复一半:重跑 seed 补得回内置角色的映射,**自定义角色那条实测永久丢失**。

  现在 seed 事实闭包内的码一律拒删(`30105`,任何身份**含 `SUPER_ADMIN`**),错误消息直接指路:「要收回某个角色的这项权限,请改该角色的权限映射,不要删权限码本身」。护栏**只**管闭包内的码 —— 闭包外的历史惰性码删除行为一字不变,否则会把唯一的清理入口也堵死。刻意**不**改成软删:软删的码会被 rbac 误读(既有拍板)。

- **凭空造出来的权限码是惰性的,而管理员得不到任何反馈**。`POST /api/system/v1/permissions` 此前只校验 code 形状,不检查这个码在不在 seed 事实闭包内。造出来的码会真的存进表、能绑给角色,却**守不住任何端点**(端点判的是硬编码的码)—— 管理员拿到一个「看起来生效、实际什么都不管」的权限。现在闭包外的码直接拒(`30106`),消息说明「权限码由系统定义,新增权限点需要改代码并发版」。

  结果上 `POST /permissions` **不再存在成功路径**(闭包内的码 seed 后已存在 → `30002`,闭包外的码 → `30106`)。这是刻意的:端点保留是为了给出一个明确的「不能这么干、该去哪」,而不是静默造出无效配置。`PATCH` 的既有收紧(仅 `description` 可改)本就成立,本次只补上回归锁,未放宽。

### Added

- **运行时权限目录闭包判据**(`test/e2e/seed-permission-catalog-runtime.e2e-spec.ts`):空库 → 实跑 `prisma/seed.ts` → 读 `permissions` 表,与闭包清单**双向**逐条对照。

  这条不能用源码扫描代替:#1129 建的 `check-permission-catalog-closure.ts` 两侧读的都是**源码**(运行时导出对象 + typed-AST 静态扫描),而经 API 往 DB 里增删权限行**不改任何源码** ⇒ 那条判据对运行时漂移结构性失明、永远全绿。「源码侧闭包」与「运行时 DB 与闭包一致」是两件事,本 PR 补的是第二件。

- **`src/modules/permissions/seed-permission-codes.ts`** —— 护栏在运行时唯一读得到的闭包清单。`src/` 够不到 seed 事实闭包(`prisma/seed.ts` 不进 `dist/`,且它自己 `import` `rbac-seed-facts.ts` ⇒ 反向 import 是循环),所以这份副本是**结构上必需**的,与 `protected-role-codes.ts`(15 个内置角色的 API 删除保护清单)是同一范式的镜像件。

  它靠三段链钉死,每段各有独立执法位:清单 ==(A)== `RBAC_SEED_CATALOG.permissions` 各桶并集 ==(B)== typed-AST 全集 ==(C)== seed 后的 DB 行。(A)(B) 由 `seed-permission-codes.spec.ts` 守(薄跑红区 selfGuard 内的 `check-permission-catalog-closure.ts`,实质提取逻辑不在 spec 里),(C) 由上面那条 e2e 守。两个方向都查:清单缺项 ⇒ 护栏对新码失明(症状恰好是「什么都不发生」);清单多项 ⇒ 护栏挡住一个不该它管的码且永久删不掉。自证全用地板锚点(`≥N`)不用「恰 N 条」。

- **护栏正/反/级联三条对照**(`test/e2e/permission-catalog-guardrail.e2e-spec.ts`):同一个码、同一个起点,**闸开 vs 闸关**。闸开(走 HTTP)→ `30105`,权限行与两条角色授权一条没少;闸关(绕 HTTP 直发同一条 SQL)→ 权限行没了,两条角色授权跟着没了,而两个角色本身还在、只是空了。只证明「HTTP 返回了 30105」说不出这个码替管理员挡住了什么,第二半才是「挡住的是什么」的证据。另含两条次序判据:删不存在的 id 仍返 `30001` 不被误报成「被保护」,格式非法的码仍先返 `30008` 不被护栏抢答。
