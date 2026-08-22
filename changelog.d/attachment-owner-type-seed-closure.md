### 修复

- 🔴 **补 seed:`member` / `certificate` / `activity` 三种附件归属类型的类别配置行**(自附件功能上线以来一直缺失)。`ATTACHMENT_OWNER_TYPES` 认 10 种归属类型,而 seed 只建了 5 种;`assertOwnerTypeAllowed` 是 fail-close —— 查不到 ACTIVE 配置行即抛 `ATTACHMENT_OWNER_TYPE_INVALID`(判定链见 `docs/attachment-config-boundary.md`)。⇒ **全新部署后,队员传证件照、传证书照片、传活动照片一律失败**,连带 15 条 `attachment.*` 权限码发给谁都没用。

  ⚠️ `ownerTable` **不是物理表名**,是 `attachment-upload.service.ts` 里 `${ownerType}:${ownerTable}` switch 的逻辑键 —— 实测它认小写 `member:member` / `certificate:certificate` / `activity:activity`(而 `user-avatar:User` / `member-official-portrait:Member` 才是大写)。照 schema 推「物理表名」会写成大写,上传时落到 default 分支抛 `ATTACHMENT_OWNER_NOT_FOUND`。

  尺寸与格式沿既有五条的取值规律(图片 10MB;证书另放行 PDF),**是按规律推的默认值不是拍板值**;运营改过之后 `update: {}` 不回退。

### Harness / 执法层

- 「附件归属类型必须有 seed 配置行」类闸(`scripts/harness-guards.selftest.ts`,随 `pnpm harness:selftest` 在 CI 跑,零新接线)。守的缺陷类是:**代码认得这个类型,而库里没有它的配置行 ⇒ 该功能在新库上直接不可用**。

  ⭐ **为什么这缺口能藏这么久**,两条叠加:① e2e 自己把配置行建出来了(实测 `test/` 下 `code: 'member'` 出现 **31 次**、`certificate` 7 次、`activity` 2 次);② 更根本的是 **e2e 结构上就看不见 seed 缺口** —— `test/setup/reset-test-db-cli.ts:19` 跑的是 `prisma migrate reset --force --skip-seed`,**根本不执行 seed**。两轮外部跨模型评审(第七轮包 F 明确判「冷启动可走」)也没发现,因为它们是静态读代码。

  根因:seed 里建附件类别配置的地方有**四处**,各是某批 feature 自己加的(内容 / 报名上传 / 视觉身份 / 本次)—— 每批只管自己那份,最早的三种没人认领。

  ⚠️ **闸的扫描面按结构特征认,不按常量名认**:第一版写的是 `*_ATTACHMENT_TYPE_CONFIG_SEED = [...]`,**当场被自己抓到漏了** `REGISTRATION_UPLOAD_SESSION_ATTACHMENT_TYPE_CONFIG`(单数 · 无 `_SEED` 后缀 · 是对象不是数组)。改为认「`code` 与 `ownerTable` 紧邻同现」这个结构特征 —— 不随命名习惯变化。

  豁免口两条,均经实测而非拍脑袋:`registration-form-answer`(由 `registration-upload-session` 附件**转换**而来,上传侧校验用的是前者)、`attendance-import-preview`(trusted facade 自成一路,对 `assertOwnerTypeAllowed` 的调用数实测为 **0**)。另有一条反向断言禁止豁免口留过期条目。
