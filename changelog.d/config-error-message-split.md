### Fixed

- **P2-8 `storage-settings-bootstrap` 把权限错误报成 JSON 语法错误**(`src/modules/storage/storage-settings-bootstrap.ts`):`readFileSync()` 与 `JSON.parse()` 原先共用一个 `try` / 一个 `catch`,统一抛「config-file 不是合法 JSON」。config-file 按安全要求设 `600 root:root`、而 runner 镜像是 `USER node`(uid 1000)⇒ **EACCES 被报成 JSON 语法错误**。本刀拆成两段、两句话:读失败报「无法读取 config-file(检查权限 / 属主 / 路径)」,解析失败才报「不是合法 JSON」。

  **它省掉的是什么**:一次照着错误信息白查的运维时间。2026-08-20 第二阶段真机部署实测踩出 —— 维护者在服务器上用 `python3 -m json.tool` 验出 JSON 完全合法,却因为错误信息指着 JSON,把一整轮排查花在了错的方向上。零运行时危害,实付的是时间。

  ⚠️ 只改错误分支与文案,**bootstrap 的行为零变更**:成功路径、四项安全前置(普通文件 / 大小上限 / group-other 权限 / 字段白名单)、解析结果全部逐字未动。同文件 `new URL()` 那处 `catch` 形状相同但**只有一个失败原因**,按台账**刻意不动**。

### Harness / 执法层

- **「把不同失败原因合并成一句话」类闸**(`src/modules/storage/merged-failure-diagnostics.criteria.spec.ts`,11 条):判据不是「今天这处拆开了」,而是「**合回去必须红**」—— 结构性扫 AST,不写死行号、不点名函数,断言本模块内没有任何 `catch` 同时盖住「环境类失败」(拿不到文件 / 网络)与「内容类失败」(拿到了但解不开)。变异实测:把两个 `catch` 合回一个,类闸与定点锚**双双当场红**并点名「环境类:readFileSync / 内容类:parse / 却只抛一句:…」。

  ⭐ **扫描面是按实测读数定的,不是拍脑袋**。对 `src/` 全仓 991 个 `.ts` 实测了三种判据形状:「一个 try 里有 ≥2 个调用」命中 **131** 处(粗到没有意义);「+ catch 丢弃 error 且只抛一句固定话」收敛到 **15** 处;「+ 跨环境 / 内容两类」才把**故意**合并的路径摘干净。那 15 处的大多数是**令牌校验路径**(`attendance-qr-token` / `attendance-member-credential-token` / `attendance-offline-package-token` / `identity-step-up`)—— 那里把「base64 坏了」和「签名不对」分开报等于给攻击者送预言机,**合并是安全特性不是缺陷**。判据必须能区分这两者,否则会把安全设计误报成违规。

  ⭐ **假阳性对照**:台账点名的 `new URL()` 那处形状相同但只有一个失败原因,是这条闸的反面样本。判据不靠「没扫到」蒙混 —— 有一条断言专门证明它**被扫进管辖了且判绿**;变异期间这两条对照全程 GREEN。另含「catch 带上 error(`{ cause }` / 日志 / 按 `err.code` 分支)即不在管辖内」的逃生门断言:原因没丢就不构成本缺陷类,逼所有 catch 拆 try 会把闸变成噪音。

  ⚠️ **本闸刻意只管 `src/modules/storage/**`,全仓推广不在本刀范围**(A 档微刀)。第三种形状在全仓仍会命中若干处(如 `local-activity-frontend-fixture.ts` 的 fetch + `new URL`、attachments 的四处 DB 取数 + locator 映射)—— **这是已知敞口,已如实登记进 `NEXT_TASKS.md` P2-8**,不是漏判。词表按调用名最后一段匹配,窄面够用;扩面前必须先重测精度。
