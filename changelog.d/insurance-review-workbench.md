### Added

- **保险审核工作台**:新增 `GET /api/admin/v1/member-insurances` —— 跨队员的保险审核工作列表,支持按 `reviewStatusCode`(`pending` / `verified` / `rejected`)筛选,不传即不筛;沿仓内分页铁律(`page` / `pageSize`,默认 20)。判权**复用** `member-insurance.read.other`,零新增权限码 —— 换个查询形状不改变可见性边界。
  **它解锁的是什么**:维护者 2026-08-22 拍板 `INSURANCE_ENFORCEMENT_ENABLED` 上线设 `true`,并接受了一个前置条件 —— **开成 `true` 之前,先把已经录进去的保险审一遍**(开关一开,所有「录了但没审」的记录当场失效,那批人会突然报不上名)。而在本刀之前,这个前置**在系统里做不到**:只有两个按 `memberId` 的读端点(`GET /members/:memberId/insurances` 与 `.../overview`),没有跨队员列表、不能按审核状态筛,要回答「哪些还没审」只能把每个队员挨个点一遍;`scripts/` 下也没有运维脚本旁路,`meta` 的两个聚合面(dashboard-summary / participation-overview)都不含保险。本刀只交付这个查询能力,**不碰开关本身**(那是运维动作)。
  这类缺口不会让任何测试变红、不会让任何检查报警 —— 只在有人真去翻开关那天才暴露,而那天通常没有时间再补一个端点。

### Security

- 🔴 **跨队员面保单号恒掩码**。工作台出参只有 `policyNumberMasked`(前 2 + `****` + 后 2,≤4 位整体打码,走全仓共用的 `maskIdentifier`),**永不返明文** —— 沿 `certificates-workbench` 的成文范式(「工作台永不返回完整 certNumber」)。一个跨队员列表若返明文保单号,它就是一个绕过掩码的批量通道。
  **实测事实与原 goal 前提不符,已请维护者拍板**:原 goal §3 假设单人端点已有掩码可复用、要求新列表「与单人端点掩码口径逐字一致」。实测(`d1adf853`)单人端点 `GET /admin/v1/members/:memberId/insurances` 返的是**明文** `policyNumber`,既无掩码也无 `*.read.sensitive` 分档(全仓四个 `*.read.sensitive` 码里没有保险)。照字面「逐字一致」解出来的正是同一节要防的那个批量通道,故改为**沿工作台范式恒掩码**。单人端点的行为与口径**未被改动**。
- 新增 `src/modules/insurances/member-insurance-projection.ts`:`MemberInsurance` 行 → admin 出参的**唯一**字段分级点。单人面与工作台的 select 都由「安全列 ∪ 敏感列」派生,敏感列名清单从敏感 select 机械派生,工作台的敏感列剥离由分级表驱动的循环完成(不是 `const { policyNumber, ...rest }` —— 后者明天加一列时不会跟着变,而 **TS 的多余属性检查对 spread 是失明的**,漂移零症状)。
  判据落在 `member-insurance-projection.spec.ts` + `member-insurances-workbench.service.spec.ts` 两份:前者证明投影本身不泄漏,后者证明 service 真的走了那个投影(少了后者,把 service 改成自己拼一份出参、绕开 presenter,前者依然全绿)。三轮变异对拍均**必红**:① 工作台绕开共用投影自拼出参 → 1 条红;② 单人面 select 改回手抄字面量并漏一列 → 2 条红;③ 把 `policyNumber` 从敏感重分类为安全列 → 3 条红(且该变异 **`pnpm typecheck` 照过**,正是「漂移零症状」的当场证据)。
- 审计复用既有事件族 `member-insurance.read.other`(不新增族,`sensitive-read-audit-unification` 的九族清单不变),查询后 fail-closed 先落账再返数据;`extra` 只记 `operation` / 过滤字段名 / 计数,不记保单号、保险公司或 id 列表。
- 软删保险行与**软删队员**的保险行均不出 —— 单人面对软删队员是 `26001`,跨队员面若把它们列出来就成了「单人面查不到、列表里却看得见」的两套口径。
