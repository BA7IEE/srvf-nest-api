# announcement-import — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);权限地图读 [`/docs/ai-harness/RBAC_MAP.md`](../../../docs/ai-harness/RBAC_MAP.md)。**设计权威源 = T0 冻结评审稿 [`/docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md`](../../../docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md) §8.4 / §11 PR11**。本文件只记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **终态 scoped-authz PR11(2026-07-02)**:公告导入两段式端点 —— `POST admin/v1/announcement-import/preview`(零写入诊断)+ `POST admin/v1/announcement-import/execute`(幂等落库);2 码 `announcement-import.{preview,execute}.record` 绑 ops-admin
- **本模块只做锚定解析 + 编排 + 逐行结果聚合**:任命 5 校验 / 分管校验 / closure 维护 / audit 写入,全部只存在于 `OrganizationsService.create()` / `PositionAssignmentsService.create()` / `SupervisionAssignmentsService.create()`——本模块**绝不**重新实现这些校验(自证方法:grep 本目录不应出现"职务适配" / "requireMembership" / "closure 维护" / "任命 5 校验" 这类校验注释,这些只应出现在被复用的三个 service 文件里)
- **preview 零写入的实现机制 = dry-run 沙箱哨兵,不是另一套只读校验**:三个被复用 service 的 `create()` 都新增了 `options?: { dryRun?: boolean }` 末位可选参数(本刀新增,向后兼容,省略即零行为变化)。dry-run 时,校验与写入语句真实执行到底(含 audit 写入),提交前抛内部 `DryRunAbort` 哨兵类强制整个 Prisma 事务(含 audit)一并回滚,`create()` 内 catch 后原样返回"本应创建"的响应体。preview 与 execute 因此走**同一份真实校验代码**,不存在"preview 说 ok、execute 却因为preview 没覆盖到的校验分支而失败"的两套逻辑漂移风险
- **组织行 `nodeType` 恒为 `'group'`**:本工具只用于批量建组级节点(冻结稿 R1;筹备组用 `establishmentStatusCode='provisional'`),不支持通过导入建队/部/总队级节点
- **双锚铁律(R7)**:execute 只接受带 `memberNo` + `orgCode` 的行,缺任一即整行 `blocked`,不做任何姓名匹配;preview 对仅 `displayName` 的行做辅助解析(唯一命中 active 队员 → 回显 `suggestedMemberNo`,仍标 `needs-manual`,**从不自动升级为 `ok`**)

## Local facts

- **组织行处理顺序 = 请求内声明顺序,父必须先于子**:`orgCodeMap`(`code → {id, nodeTypeCode}`)在处理 `organizations[]` 时逐行建立,dry-run 下也可用(cuid 由 Prisma 客户端侧生成,回滚前已产生);`positions[]` / `supervisions[]` 的 `orgCode` 解析先查 `orgCodeMap` 再查库,因此可引用同请求内更早声明的组织行,也可引用早已存在的组织
- **批内重复检测(`seenOrgCodes`/`seenPositionKeys`/`seenSupervisionKeys`)是 dry-run 的固有盲区补丁,不是重复业务校验**:preview 下同一批内两行若引用同一个"即将创建"的资源,各自的 dry-run 会各自独立回滚、互相看不见对方,被复用 service 的 DB 级防重查询在这种场景下失效,必须在编排层显式去重,否则会对两行都误报 `ok`
- **`already-exists` 双语义**:对 position/supervision 行 = 命中被复用 service 的防重 BizCode(`POSITION_ASSIGNMENT_ALREADY_EXISTS`/`SUPERVISION_ALREADY_EXISTS`);对 organization 行 = 命中 `ORGANIZATION_CODE_ALREADY_EXISTS` 时**先核对锚点一致性**(`nodeTypeCode=group` 且 `parentId` 与本行已解析的 parent 一致)**才**当作"就是这个组"处理(名称/设立状态/组功能差异不纳入比对,仅锚 = 类型 + 父级),取现有行 id 供后续行引用 —— 决断⑤幂等可重跑的直接体现,重复执行同一批不应重复报错(**收窄见 review #484 G8,2026-07-03**:锚点不一致 → 改判 `blocked` 并把 code 计入本请求的毒丸集,阻断同请求内 `positions[]`/`supervisions[]` 引用该 code 的行静默挂错;`resolveOrg` 是"先查 map 再查库",不写 `orgCodeMap` 挡不住后续行经 DB 直查命中同一个错误组织,必须显式毒丸传播)
- **`reasons[]` 不是 OpenAPI 契约锁定的稳定枚举**(区别于 authz/explain 的 `reason`):`bizCode` 字段在命中被复用 service 抛出的真实 `BizException` 时原样携带其 `code`/`message`;纯本模块合成的诊断(缺字段 / 双锚缺失 / 姓名多义 / 批内重复)`bizCode: null`,`message` 是自由文本。只有 `status` 是锁定的 4 值枚举(`IMPORT_ROW_STATUS_VALUES`)
- **组织行两个 additive 字段本刀首次接入 Create DTO**:`establishmentStatusCode?`/`groupFunctionCode?` 由 PR1(2026-07-01)加列但标注"本刀 schema-only,不进 Create/Update DTO"——PR11 是这两列第一次被写入(`organizations.dto.ts`/`organizations.service.ts` 改动仅此;不影响既有 5 个字段的校验/行为,`organizationSelect`/`OrganizationResponseDto` 未动,响应体不回显这两列)
- **BD-2 终审中枢绑定不进本模块代码**:导入只落 `PositionAssignment`,不自动挂 `RoleBinding`;运营需在导入完成后另行经 `POST admin/v1/role-bindings` 手工挂 `attendance-final-reviewer` 绑定(参数样例见 `docs/ai-harness/RBAC_MAP.md` §5 / `docs/current-state.md` §1)
- **`appointmentSource` 默认 `'announcement-2026'`**:行内可显式覆盖(`ImportPositionRowDto.appointmentSource`),分管行无此字段(`SupervisionAssignment` 无 `appointmentSource` 列)

## Risk points(不要做)

- ❌ **不**在本模块重新实现职务适配 / `requireMembership` / 单人独占 / 兼任 / 分管防重等任何校验逻辑——一律通过调用被复用 service 的 `create()` 触发,本模块只捕获其抛出的 `BizException` 并转译成行结果
- ❌ **不**按姓名自动落库(execute 对缺 `memberNo` 的行直接 `blocked`,即便 `displayName` 唯一命中)
- ❌ **不**给 `dryRun` 沙箱哨兵机制加共享工具类(`DryRunAbort` 在三个被复用 service 文件内各自私有声明,不抽 `common/utils`,沿 AGENTS §2 铁律)
- ❌ **不**在本模块写自己的 `AuditLogEvent`/直接调用 `AuditLogsService`——audit 全部由被复用 service 内部完成(组织行本就无 audit,PR1 现状不变,本刀不新增)
- ❌ **不**把真实公告数据(姓名 / memberNo 对照)写进本仓任何位置(seed / fixture / e2e / 文档示例)——R13 红线;测试与文档一律用假数据(如 `T0001`/`张三` 类占位)
- ❌ **不**摘 biz-admin 终审两码(留 PR12 显式项)

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` —— `announcement-import.service.spec.ts` + 三个被复用 service 各自新增的 dry-run 单测用例
- `pnpm test:e2e` —— `announcement-import.e2e-spec.ts`(preview 全标记族 + 零写入断言 / execute 混合三类行落库 + 幂等重跑 + 权限门);改动三个被复用 service 后必须连跑 `position-assignments.e2e-spec.ts` / `supervision-assignments.e2e-spec.ts` / `organizations.e2e-spec.ts` 确认逐字行为锁
- `pnpm test:contract` —— `EXPECTED_ROUTES` 新增 2 行 + snapshot 更新
