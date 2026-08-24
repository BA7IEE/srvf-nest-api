### Added

- **角色权限集变更的影响预览**(P1-32 PR 5;冻结稿 `rbac-permission-catalog-t0-review.md` §9.3 / §11):
  `POST /api/system/v1/roles/{id}/permissions/preview` 的 `outcome` 里多一个 `impact{...}`,
  按判权链的三源口径(direct `RoleBinding` / position 职务策略 / supervision 分管)分别给出
  **当前有效、指向本角色的授予数**,外加 direct 源的 scope 与主体类型分布,每一项都带 **EXACT / PARTIAL** 标注。
  - ⭐ **本期只出「授予数」,不出「受影响账号数」—— 这是架构切法,不是省事。**
    「谁被授予了这个角色」是 platform-access 自己的事实;「那条授予对应哪个账号、账号还活着没有」是
    identity-org 的事实。而 `harness/domain-map.json` 的 `allowedEdges` 里
    **`platform-access → identity-org` 一条都没有**(方向恒为 identity-org → platform-access),
    本域直读 `OrganizationPositionAssignment` / `User` 是架构反向,实测当场触
    `docs:boundaries:newdebt:check` 的「禁新增代码债」棘轮(v4 §6 元规则)。
    ⇒ 与其越过边界拿一个数,不如只报本域能证明的事实。冻结稿 §11.4 逐字:
    > **不要为了显示一个好看的数字而把不确定结果写成事实。**
  - ⭐ 这个取舍把 exact/partial 那一格**变强了**:三源读数全部来自 `count()` / `groupBy()`,
    不需要把行取回来 ⇒ **不存在扫描上限,也就结构上永不 PARTIAL**。
    (原设计要把主体展开到账号,那才需要扫描上限,才会出现「下界」。)
  - **supervision 源恒为 0,而且这个 0 是精确的**:分管推导在 `authz.service.ts` 里**恒定只推出一个
    固定角色**(`org-supervisor`),与目标 roleId 无关;而它在 `PROTECTED_ROLE_CODES` 里
    ⇒ 权限集 `RELEASE_MANAGED` ⇒ 任何编辑先被 `30108` 拦下,根本走不到影响预览。
    ⚠️ 真编辑那个角色时本源改标 `PARTIAL`(分管行属 identity-org,本域数不出来),**不会继续报 0 装作精确**。
  - ⚠️ **position 源数的是「策略条数」不是「人数」**:一条职务→角色策略会随该职务的在任人数放大,
    而在任人数不属本域。DTO 描述里逐字写明了,别把它读成人数。
    带 `conditionJson` 的策略与判权链逐字同口径地**保守跳过**(条件评估器未落地,fail-close)。

- **高风险角色权限集变更要求二次验证**(冻结稿 §12):差集里出现 `CRITICAL` 码 / 控制面码 /
  `CONTROL_PLANE`·`CREDENTIAL`·`FINAL_APPROVAL`·`LEDGER` 风险标签 / `SUPER_ADMIN_ONLY` 授予策略,
  或**在 seed 闭包里却缺目录元数据的码**(fail-close;今天是空集)时,`PUT` 与 `preview` 都要求带 `stepUpToken`,
  缺它返新码 **`30112 ROLE_PERMISSION_STEP_UP_REQUIRED`**,proof 对不上返 `10008`。
  - 🔴 **「目录里查不到」是两件事,别混成一件**:**在 seed 闭包里却缺元数据** = 目录漏登记
    ⇒ fail-close(那是一条零症状的放行路);**压根不在闭包里** = 不是本系统的权限码
    ⇒ **不加重**(它真提交时会因 `30001` 整批拒绝,先弹二次验证只会让人以为「验证过就能加」;
    而测试夹具里这类合成码大量存在,判成高风险会让 DoD 第三条在最常见的路径上当场失效)。
    判据用**参数化谓词**分别驱动这两档 —— 前者今天是空集,不参数化就永远测不到,等于没有。
  - 🔴 **不新造风险分级**:五条触发条件全部锚在 Catalog 既有的 `riskLevel` / `riskTags` / `grantPolicy`
    与**正在执法的** `isControlPlanePermissionCode()` 上。判据 AST 扫策略文件的字符串字面量,
    出现任何权限码即红 —— 抄一份码清单进来就是第二份分级,而两套分级第一天一定一致、此后漂了毫无症状。
  - 🔴 **proof 绑 (roleId, expectedRevision, 目标权限码集合) 三元组**(冻结稿 §12.2 标题逐字
    「Proof 必须绑定具体变更」)。三项各自单独进签名快照:换角色、换版本号、改一个字节的权限码,
    任一条都让 proof 失效。判据对三条**各做一次独立变异**,每个反面样本**只在被测那一维上不同**
    —— 一次动两维时,另一维根本没绑也照样红,「红了」就证明不了这一维在守。
  - 🔴 **默认走密码因子**。微信因子依赖企微 / 微信通道,而企微卡在备案(`current-state` §4 P0),
    默认走它会让整条路在上线前根本走不通;短信可作备选。
  - 🔴 **有意偏离冻结稿 §9.3 示例的响应形状**:示例是 `valid:true` + `requiresStepUp:true`,
    本刀是 **`valid:false` + `blockingIssues[0].bizCode=30112`**。
    理由:那份示例写于 PR 4b 之前,而 **4b 那条同源判据**(`check-role-permission-read-preview.ts`)
    定义的缺陷恰恰是「预览说能过、真提交拒」。若 `PUT` 会因缺 proof 拒绝而 preview 报 `valid:true`,
    就是亲手造出那个缺陷,还要去改松一条判据。**同源优先于示例保真。**
    ⇒ 前端流程改成两趟:preview(拿 diff / impact,低风险直接存)→ 高风险收 `30112` →
    做二次验证 → 带 proof 重新 preview → `PUT`。

- **判据(本刀主交付物)**:`scripts/check-role-permission-impact.ts`(selfGuard 内的裁判)+ 薄运行器
  `src/modules/permissions/role-permission-impact.criteria.spec.ts`。守九件事,每条都做过变异对拍:
  - **`exact-lies` / `partial-missing`** —— 24 组事实矩阵逐条**独立反算真值**比对(三源相加用 `+`、
    可观测性用 `&&`,与被测函数结构不同,不是同义反复)。变异:把 `completeness` 写死成 `'EXACT'`
    ⇒ **63 条**违规逐条点名。
  - **`impact-cross-domain-read`** —— 从 `harness/domain-map.json` 的 `modelOwnership` **现取**归属,
    逐个核对影响查询碰过的每个 Prisma 模型。**不写死模型清单**,domain-map 改了自己跟上。
  - **`proof-reuse-{cross-role,cross-revision,cross-payload}`** —— 走**真实代码**:proof 由
    `IdentityStepUpService.stepUpWithPassword()` 真实签发(依赖全哑元,零 DB),由生产路径上那个
    `verify()` 真实校验,**外加一条正向对照**(原样复用必须通过 —— 没有它,一句 `throw` 能让三条变异全绿)。
  - **`risk-overreach` / `risk-underreach` 两向** —— 在**全目录 237 条**上跑;
    ⭐ 假阳性对照本体是自证里的地板:不触发二次验证的码必须 ≥60(实测 **181**)。
    变异:把判定写成恒 `true` ⇒ 不触发数掉到 **0**,自证当场红。
  - **`stepup-scope-*` 射程登记** —— 见下方「已知缺口」。
  - **`stepup-dto-whitelist`** —— `auth.controller.ts` 三处 step-up handler 各有一行
    `const safeDto: StepUpXxxDto = {...}` 的**显式白名单**:DTO 新增字段没同步加进那一行就被
    **静默丢弃且零报错**。本刀差点踩到(症状会是「proof 永远对不上」,没人会往那一行想)。
    判据钉住白名单与 DTO 字段集**逐一相等**,顺带纳管了同文件里第 4 处(`LoginWecomDto`)。
  - **`proof-family-shared-domain` / `proof-family-forgery`** —— 两族 proof 的密钥域与 audience
    必须逐字不同,且双向交叉验签必须失败。⚠️ 两条**强度不同,判据头注里如实标了**:
    行为层今天被**两层**同时保护(密钥域隔离 **与** `action` 声明比对),
    单看它红不红**推不出**密钥域还在不在 ⇒ 两条都要留。
  - **`proof-instance-interop`** —— 签发实例与验签实例在生产里就是**两个独立对象**,
    判据的真实签发/验签也走两个实例:哪天有人往 proof 里塞随机量或内存缓存,两侧立刻对不上。
  - **`proof-file-single-purpose`** —— 见下方「域中立层」。

### Changed

- **`POST /api/auth/v1/step-up/{password,sms,wechat}` 新增可选入参 `rolePermissionSet`**,
  与新 `StepUpAction.RBAC_ROLE_PERMISSION_SET_REPLACE` 配套(冻结稿 §12.2 逐字的 action 名)。
  老调用方**不传它,行为一字不变**;三条既有 action 的 snapshot 算法**一个字符都没改**
  (冻结稿 §7.4「其他 PHONE_BIND/WECHAT_BIND snapshot 算法保持逐字不变」原样成立)。

<!-- contract-breaking
operation: POST /api/auth/v1/step-up/password
reason: 新 action `RBAC_ROLE_PERMISSION_SET_REPLACE` 的 proof 必须绑定 (roleId, expectedRevision, payloadHash) 三元组(冻结稿 §12.2「Proof 必须绑定具体变更」),三项做成必填对象是刻意的 —— 做成三个可选标量的话,漏传一个就静默退回「只绑身份」的 proof,而那正好把要挡的复用面重新打开(与 B2 给 wecomBinding 绑成必填对象同一条教训)。语义门把「可选父对象下的必填叶子」判成 B3,是本仓已登记的判据形态,不是本次真的破坏了老调用方。
impact: 零存量调用方受影响 —— 父字段 `rolePermissionSet` 本身**可选**,不传该对象的老调用方(今天全部三条既有 action)请求形状与响应逐字不变;只有新 action 才会走到这三个必填叶子。
migration: 调用方无需改动。要用新 action 的前端按 `docs/handoff/admin-web.md` 的两趟流程传 `rolePermissionSet`;`payloadHash` = 去重升序后的权限码数组 canonical JSON 的 sha256(base64url)。
rollback: git revert 本 PR(无 migration、无数据变更、无 feature gate 依赖;新 action 与新码 30112 随之消失,既有三条 action 的算法本就未动)
-->

<!-- contract-breaking
operation: POST /api/auth/v1/step-up/sms
reason: 同 password 端点 —— 三个 step-up 签发入口共用同一个绑定上下文对象,只给其中一个加会让「哪个因子能签哪种 proof」变成要读代码才知道的事。
impact: 零存量调用方受影响(父字段可选,老调用方请求形状不变)。
migration: 调用方无需改动;新 action 传 `rolePermissionSet`,字段含义同 password 端点。
rollback: git revert 本 PR
-->

<!-- contract-breaking
operation: POST /api/auth/v1/step-up/wechat
reason: 同上。⚠️ 该因子依赖微信 / 企微通道,而企微卡在备案(current-state §4 P0)——**本刀默认走密码**,这里加字段只为让三个入口对称,不代表推荐用它。
impact: 零存量调用方受影响(父字段可选,老调用方请求形状不变)。
migration: 调用方无需改动。
rollback: git revert 本 PR
-->

- **配置变更 proof 落在域中立层 `src/common/security/role-permission-step-up-proof.ts`**,
  而不是 `permissions/` 或 `auth/`。签发方在 `auth`(identity-org)、验签方在 `permissions`
  (platform-access),而**两个方向的模块间 import 都过不了架构闸**(逐条实测):
  - `permissions → auth`:`allowedEdges` 里 `platform-access → identity-org` 一条都没有 ⇒ `cross-domain-import`;
  - `auth → permissions`:方向虽是 `confirmed: true` 的允许边,但域图上
    `platform-access → participation → identity-org` 已经存在 ⇒ 这条边**闭合一个环**,报 `cross-domain-cycle`。
    ⚠️ **不只是模块声明**:把 `AuthModule` 的 import 撤掉、只留文件级 import,同一条环照样报
    (位置从 `auth.module.ts:8` 换到 `identity-step-up.service.ts:24`)。
  - ⇒ 落在 `src/common/`(实测:`auth` 与 `permissions` 现有的 `src/common/**` import 零 finding;
    `commonGovernance` 的五类检查对本文件逐条为 0;`docs:boundaries:newdebt:check` 实测
    **`ok: true / unknownCount: 0`**)。
  - ⚠️ **「域中立」不等于「没有归属」**:这段代码的语义归属仍是 platform-access。
    放这里是**可达性**的要求,不是把它变成了公共设施 —— 执行位是 `proof-file-single-purpose`
    (每个导出符号都必须以 `ROLE_PERMISSION_` / `RolePermission` 开头)。
    ⚠️ 它挡的是**漂移**,挡不住蓄意规避,也管不到「另建 `src/common/security/foo.ts`」。
  - 🔴 **两族 proof 不是同一件事的两份实现**:身份绑定族(`PHONE_BIND` / `WECHAT_BIND` / `WECOM_BIND`)
    绑的是凭证快照与企微身份代际(identity-org 的事实);配置变更族绑的是
    (roleId, expectedRevision, payloadHash)(platform-access 的事实)。各有各的 HKDF 盐 / info 域与
    audience ⇒ **没有任何需要保持同步的东西** —— 「不是第二份真相」的判据是这个,不是「抄的时候小心一点」。
    ⭐ 而且这次拆分**换来了更强的保证**:两族在结构上互相冒充不了,而不是靠 `action` 字段这种
    「同一把钥匙签、靠一个声明区分」的形态。

### 本次未做(如实登记,别读成已完成)

- 🔴 **旧增量端点 `POST` / `DELETE /roles/:id/permissions` 不受 step-up 管辖。**
  闸挂在 `runReplaceSet()`(`PUT` + `preview` 的共同委托)上,那两条走的是同一条写原语但不经它 ——
  这是 goal「不改 replace 原语的判定」的直接后果,**也是一条真实缺口**:持
  `rbac.role-permission.create` 的人仍可用 `POST` 加一条 CRITICAL 码而不触二次验证。
  收口它要给 `AssignRolePermissionsDto` 也加 proof 字段并改原语判定 = 行为破坏,超出本刀;
  冻结稿 PR 8 本来就要退役那两条端点,缺口窗口是「PR 5 合入 → PR 8 合入」这一段。
  ⇒ **⭐ 缺口做成了机器可见**:判据的 `stepup-scope-*` 把当前射程**登记在案** ——
  有人扩大或收窄要显式改登记;**PR 8 删掉那两条端点时判据会红并逐字要求「重看射程登记」**,
  而不是悄悄失效。(实测:把 `assign` 改名模拟退役 ⇒ `stepup-scope-stale` 当场红。)
- 🔴 **配置变更 proof 不绑凭证快照**(改密码 / 换手机不会踢掉在途 proof)。
  这是**去掉一层假保证**而不是削弱 —— 实测三条读数:
  - `users.service.ts` 改密码时吊销的是 **refresh token**(写 `revokedAt` / `revokedReason='self-password-…'`);
  - JWT 策略每请求查库,只校验 `deletedAt === null && status === ACTIVE`;
  - `JWT_EXPIRES_IN = 15m`,access token **无状态**。
  ⇒ 「改密码即刻踢人」这条保证**在这条链上本来就不存在**:已签发的 access token 照活 15 分钟。
  给 proof 绑凭证快照只会让一条不存在的保证**看起来存在**,而假保证比没有保证更危险。
  ⚠️ 残余风险:改密码后 5 分钟内在途的配置变更 proof 仍然有效;挡住它的是 TTL 与五元组绑定。
- **`catalogHash` 未做**。冻结稿 §12.2 把它列为 proof 的第四维,但 PR 5 的 DoD 逐字只要求
  「不能跨角色 / 跨 revision / 跨 payload」三条。补它要新开一个「目录版本」事实源
  (PR 2 刻意没出)并往两个 DTO 加必填字段,属独立一刀。
  ⚠️ 残余风险如实说:目录改分类后旧 proof 在 5 分钟窗口内**仍然有效**。
- **`editPolicy.addBlocked[]` / `removeBlocked[]` 未做**(理由同 4b:那是把控制面两层闸重新表达一遍,
  属 preview 的第二份真相形状;要做得先把 `assertControlPlaneCodesOrThrow` 拆成 per-code verdict)。
- **按绑定数量强制 step-up 未做**。冻结稿 §12.1 最后一条自己就把阈值挂在业务拍板上;
  而且那会让一道安全闸依赖 impact 读数,是把两个问题绑成一个。
