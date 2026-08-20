### Added

- **队员标准照闭环(issue #1055 T4)**:四个 Admin 端点
  `GET / POST / DELETE /api/admin/v1/members/:id/official-portrait` 与
  `GET /api/admin/v1/members/:id/official-portraits`(版本历史)。
  - 上传走 **multipart 直传服务端**(与 T3 同一理由:服务端要规范化就必须看见字节),
    规范化成 **826×1158 JPEG q90、白底、清 EXIF/GPS**(`uniform-portrait-v1`)。
  - **one-active 版本状态机**:每次替换新建一行、旧行转 `SUPERSEDED` 并留下终结人与时刻;
    作废(必填 reason)把当前版转 `VOIDED`,**不自动回退到上一版** ——
    历史版本表达的是过去事实,想重新启用旧照片必须新建一个正式版本。
  - 队员详情带出 `officialPortraitId` / `hasOfficialPortrait`。
- **两条权限码开始生效**(T1 登记时刻意留的口):交给既有派生链,实测分发结果 ——
  `biz-admin` 2 条(全局)· `org-admin` 2 条(组织范围继承)· 副职只读投影自动拿到
  `read.history` 1 条 · `group-manager` 0 条。biz-admin 绑定数 69 → 71。
- 两个 BizCode:`15039`(作废时无当前标准照)· `15040`(one-active 冲突)。

### 为什么标准照要版本化,而 T3 的头像不用

头像是展示品,换掉就换掉了。标准照是**正式业务事实**:制证 / 年度名录 / 对外报送一旦定稿,
不能因为本人换了照片而背后变图(issue §10.3)。所以正式材料引用的是
`MemberOfficialPortrait.id`,不是「当前那张」。

同理,**被顶替的那一版不清二进制**(与 T3 头像相反)—— 它是历史事实,可能还被引着;
合规清理走 issue §5.2 的 purge 流程,不在本刀。

### 三处承重的实现细节

- **one-active 三道防线**:`Member` 行 `FOR UPDATE` 串行 → 同事务原子换代 →
  **DB partial unique** 兜底。第三道不是冗余:锁保证串行,**不保证后来者重读到最新状态**,
  而「忘了重读」不会让任何东西报错。P2002 映射成 `15040` 而不是 500。
- **锁内必须重读当前 ACTIVE** —— 阶段 ③(Provider put+HEAD)在事务外,那期间锁是放开的。
- **旧版 `endedAt` 与新版 `activatedAt` 是同一个 `new Date()`**,版本历史不留缝也不重叠。
  T1 特意拿掉 `activatedAt` 的 `@default(now())` 就是为了让这件事可能 ——
  有默认值时新版时间来自库时钟、旧版来自应用时钟,两个源对不齐。
- **版本号取 `max(version)+1` 不是 `count+1`** —— 作废过的行也占号。

### scoped 判权:两半都要验

issue §8.1 要求 `member-portrait.manage.record` **必须支持组织数据范围**。实现是
`getVisibleOrganizationScope(user, code)` 取范围后,**再验目标 memberId 在不在范围内**。

只验前半截(「有没有这个码」)是最容易犯的错:A 部门的队长拿着 org-scoped 绑定就能改
B 部门队员的标准照,而 `hasPermission` 照样为 `true`。范围外与不存在**返回同一个错误**,
区分开来等于给出一个成员枚举口。

范围→where 的翻译**复用 `MembersQueryService.buildOrganizationScopeFilter`**,不另写一份 ——
那条链上两端各只有一份实现,漂移的表现会是「多看见了本不该看见的人」,而这种漂移不报错。

### 验证

- e2e **15 条**:上传 / 替换 / 连替三次仍只有一张 ACTIVE / 并发 / 作废 / 作废后版本号 /
  无当前版作废 / 历史倒序 / **scoped 正反两面** / 两条拒收面 / 详情接入 / 审计
- **变异对拍**:把范围过滤摘掉(只剩「有没有码」)⇒ **2 条 scoped 反面用例变红**,正向对照保持绿
- 并发那条**诚实标注了它证明什么**:`Member` 行锁会把两个请求串行,所以两个通常都成功;
  它钉的是**串行后的结果不变量**(至多一张 ACTIVE、版本号不重),**不**期望出现 `15040`。
  15040 那条路径由 T1 的 schema spec 直插库覆盖。

### 交付中撞到的一处闸

`docs:rbacmap` 的 `swagger-auth-suffix` 按**严格的 `[rbac: <码>]`** 解析 summary 并回查 seed
事实闭包。我原本写成 `[rbac: member-portrait.manage.record + 组织范围]`,整串被当成码名,
报「不在闭包中」。范围说明已挪进括号正文。
