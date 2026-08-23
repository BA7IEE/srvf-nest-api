### Added

- **权限目录只读 API**(P1-32 PR 2;冻结稿 `rbac-permission-catalog-t0-review.md` §9.1):
  `GET /api/system/v1/permissions/catalog`,鉴权**复用既有 `rbac.permission.read`,零新增权限码** ——
  目录与 `GET /permissions` 是同一份权限定义的两种呈现(一份给机器分页、一份给人按业务区分组),
  「能不能读」是同一个问题;为一个只读端点新增码要连坐 seed + fixture 独立子集 + selftest 基线 + 四份生成物,换不来任何判权粒度。
  响应是两级分组树 `{ totalItems, sections[] → groups[] → items[] }`,一次返回全部 **237 条**权限码的
  中文名 / 人话说明 / 分类 / 风险等级 / 风险标签 / 授予策略 / 生命周期 / 编辑器可见性。
  这就是 DoD「目录中文可用」的落点 —— 管理员面对的不再是机器权限码。
  - 🔴 **不分页**,冻结稿 §9.1 逐字「返回完整目录,不分页」。**没有默默不分页** ——
    分页铁律的例外已登记进 `docs/reference/response-pagination-errors.md` §4 新开的
    「整取型只读目录」表(与既有那张「`pageSize` 默认值 / 上限」表分开:那是「分了页但两个数值不同」,
    这是「根本不分页」,两类偏离判据不同)。够格的判据是「固定参考集合 + 客户端必须整取才能用」,
    不是「数据量看起来不大」:目录条数只随版本发布变、不随用户操作变,上界由**代码事实**兜住
    (`permission-catalog.ts` 在红区);而且它是两级分组树,按页切会让树在客户端拼不齐。
    端点新增、零存量调用方,不存在「老调用方从 N 条掉到 20 条」那类破坏。
  - ⚠️ **刻意不出** `catalogVersion` / `catalogHash`:前者仓内**没有任何事实源**,硬造一个手维护的数字
    就是又一份会静默漂移的真相;后者的消费方是冻结稿 §9.3 的变更预览,属 PR 4b/5,那时再加是 additive。
    同理 `technicalDescription` / `replacementCodes` —— PR 0 刻意一条都没落地(见 `PermissionCatalogMetadata` 头注),
    这里没有东西可返,不是漏返。
  - 投影是**纯函数、零 DB**(`permission-catalog.presenter.ts`)。好处不是省一次查询,而是**判据可以直接跑它并断言真实响应体**:
    「说明字段被删掉」「扫描面塌空」这两类形状,查库版只能在 e2e 里验,而 e2e 验不到。

- **角色响应新增三个分类字段**(`kind` / `permissionManagementMode` / `bindingManagementMode`),
  角色的 **6 个产出点全部带上**(list / 详情 / 建 / 改 / 软删 / `roles/:id/permissions` 的角色详情)。
  `permissionManagementMode` 是 DoD「系统角色只读状态可被前端识别」的落点:
  值为 `RELEASE_MANAGED` 时前端把权限编辑器整个置灰,后端对加码 / 撤码一律 `30108`(**含 SUPER_ADMIN**)。
  - ⭐ **三字段选「派生」不存库**。冻结稿 §6.3 的标题逐字就是「**不必立即给 Role 表增加 kind 字段**」,
    它给的三条理由里最硬的一条是「**不会出现 DB 字段被改成 CUSTOM 逃逸保护**」——
    分类回答的正是「这个角色能不能改」,存库等于给它开一个**可写的**第二真相,
    而「后台显示可改、接口却拒」或反过来,都**没有任何症状**。
    派生的代价是零:`RbacRole` 没有对应列 ⇒ 零 migration、零 schema、不占 schema lane,
    也不碰那 6 份 e2e 里刻意手维护的 `CURRENT_MIGRATION_COUNT`。
  - 值全部由**正在执法的谓词**算出,一条清单都不抄:`isProtectedRoleCode()`(PR 3a 四道闸共用的锚点)
    与 `SYSTEM_MANAGED_ROLE_CODE_SET`(`RoleDelegationPolicy.assertRoleIsNotSystemManaged` 的锚点)。
  - ⚠️ **`bindingManagementMode` 本期只产出 `SYSTEM_ONLY` / `MANUAL_ALLOWED` 两值**。
    冻结稿 §6.2 对其余系统角色写的是「`MANUAL_ALLOWED` / `POLICY_DERIVED` **或二者并存**」——
    单值枚举表达不了「并存」,而今天所有非 `SYSTEM_ONLY` 的角色**都允许人工绑定**,
    硬填 `POLICY_DERIVED` 会让前端以为人工入口关着,与实际相反;
    且「有没有职务策略映射」是 `organization_position_role_policies` 的**逐行数据事实**,不是角色级分类。
    枚举仍**声明满三值**:响应枚举加值算契约破坏(语义门 B6),首版声明全集,将来出第三值才不打爆老客户端。

- 判据 `check-role-classification`(selfGuard 内的裁判)+ 薄运行器
  `src/modules/permissions/role-classification.criteria.spec.ts`。守两件事:
  ① **派生结果 == 正在执法的谓词,两向都钉** —— 内建角色全部只读(某个被标成可改即红并点名),
  且**自定义角色不许被标成只读**(没有这条反向样本,一行「恒返回 SYSTEM」就能让正向断言全绿而毫无意义);
  ② **分类派生处不许出现任何角色 code 字面量**(AST 扫字符串字面量)—— 抄一份清单进来就是造第二个事实源。
  目录侧断言的是**真响应体**:每条的中文名与人话说明必须出得来,目录与元数据表**双向集合相等**,
  权限码定义索引与元数据表**双向集合相等**(反射漏掉某个 `*_PERMISSION_SEED` 数组即红)。
  地板锚点用 `≥N` 不用「恰 N」(内建角色 ≥15 / 目录 ≥200),既避免「改判据才能过」,
  也让「把清单删空」以红的形态出现而不是「没有违规所以全绿」。

### Changed

- `rbac.permission.read` 的**人话说明**改了一句(Catalog 元数据,`businessDescription`;其余字段一律未动)——
  它的管辖面从 1 个端点变成 2 个,而说明只描述了老端点。**这不是顺手改,是 P2-13「说明 ↔ 管辖面绑定」闸判红后的收口**:
  老端点返的是 Permission 表原始行,新端点返的是**带风险等级与授予策略的能力全景图**;
  决定「要不要把这条码放进某个自定义角色」的人应当知道持有它的人能看到这些。
  基线随之推进(`harness/permission-surface-baseline.json`,diff 仅这一条码:`endpoints 1→2` + 两个哈希)。
  - ⭐ **刻意不走 `--acknowledge-unchanged`**。字面上说明不算「假」(目录确实是清单、确实只读),acknowledge 过得去;
    但 P2-13 立项的实证正是「**3 个新端点、0 个新权限码**,三条说明当场过期,没有任何机器发现」——
    **本刀是这条闸落地后的第一次触发,第一次就 acknowledge 等于把它建成一条永远被绕过的闸。**
  - ⚠️ **取证教训(比这次修复本身更值钱)**:这条闸读的是 `ROUTE_AUTHZ.md`。生成物刷新**之前**跑它,
    它读到的是上一版(551)事实,报「无漂移」——**判据没坏、扫描面没塌,单纯是输入过期**。
    ⇒ 顺序不只是 `openapi → clients → authz`,而是「**生成物全刷完再跑判据**」;
    本刀实测同一条闸在刷新前后给出相反结论。

- **纯 additive,旧前端不受影响**:既有接口 wire 一条没删没改,`PermissionResponseDto`、
  分页列表响应、角色响应的既有字段全部逐字不变(字段名 / 类型 / 可空性三者都没动),
  三个新字段**追加在末尾**。契约语义门对「新增响应字段」判 `ADD`
  (必填性只在**请求**侧算破坏,响应侧新增恒 additive),故本刀**没有** `contract-breaking` 申报块。
  实测口径:contract snapshot 的 diff 只有新增行、零删除零修改;`gate:contract:semantic` 读数 `breaking=0`。
